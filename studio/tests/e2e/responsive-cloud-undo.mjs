// STUDIO_URL=http://127.0.0.1:55701 EVIDENCE_DIR=/tmp/undo-paint node studio/tests/e2e/responsive-cloud-undo.mjs [canvas|canvas-immediate|canvas-redo|timeline|timeline-immediate|timeline-redo]...
// Requires local dev-auth, isolated preview and the Welcome template. Each case owns its project.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchStudioChrome } from './chrome-executable.mjs';
import { selectionPaint } from './selection-paint.mjs';
import { drag, inputPoint, liveFrame, mountProbe, openEditor, until } from './preview-receipt-harness.mjs';

const origin = new URL(process.env.STUDIO_URL).origin;
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'requires loopback dev-auth');
const projects = origin + '/motion-api/projects';
const soundtrack = '.timeline-clip[data-el-id$="welcome-soundtrack"]';
const preview = '[data-testid="preview-zoom-stage"] iframe[title="Composition preview"]:not([tabindex="-1"])';
const undo = 'button[aria-label="Undo"]';
const redo = 'button[aria-label="Redo"]';
const maxPaintMs = 200, holdMs = 900;
const slowNetwork = { latency: 300, download: 2_000_000 / 8, upload: 1_000_000 / 8 };
const modes = ['canvas', 'canvas-immediate', 'timeline', 'timeline-immediate', 'canvas-redo', 'timeline-redo'];
const evidence = process.env.EVIDENCE_DIR;
if (evidence) await mkdir(evidence, { recursive: true });

// These readers run inside Chrome both at checkpoints and on animation frames.
function readClip(selector) {
  const node = document.querySelector(selector);
  if (!node?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
  // Timeline zoom can change as the project duration grows. Measure actual CSS layout
  // relative to its track, paired with the independently rendered clip start in seconds.
  return [Number(node.dataset.clipStart), node.getBoundingClientRect().x - node.offsetParent.getBoundingClientRect().x];
}
function readCanvas() {
  const node = document.getElementById('reel-canvas');
  if (!node?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
  const r = node.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? [r.x, r.y, r.width, r.height] : null;
}
// Relay samples from the active cross-origin document. Reinstall on navigation so
// the baseline's iframe replacement is timed too. The small readback catches the
// empty artwork flash even when the canvas DOM rectangle and editor remain intact.
function samplePreview(read, previewOrigin) {
  if (window === top || location.origin !== previewOrigin) return;
  const thumb = new OffscreenCanvas(12, 8).getContext('2d', { willReadFrequently: true });
  function sample() {
    const value = read(), node = document.getElementById('reel-canvas');
    let painted = false;
    if (value) {
      thumb.clearRect(0, 0, 12, 8);
      thumb.drawImage(node, 0, 0, 12, 8);
      const { data } = thumb.getImageData(0, 0, 12, 8);
      for (let i = 4; i < data.length; i += 4) {
        if (data[i + 3] && Math.max(...[0, 1, 2].map(channel => Math.abs(data[i + channel] - data[channel]))) > 8) {
          painted = true; break;
        }
      }
    }
    parent.postMessage({ undoPaintSample: { at: performance.timeOrigin + performance.now(), value, painted } }, '*');
    requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
}
function watchStudio(read, clip, selector, actionSelector, previewOrigin) {
  const trace = window.__undoTrace = { stage: [], preview: [], timeline: [] };
  document.addEventListener('pointerup', event => {
    if (event.isTrusted && !event.target.closest(actionSelector)) window.__lastMoveRelease = performance.timeOrigin + event.timeStamp;
  }, true);
  window.addEventListener('message', event => {
    if (event.origin === previewOrigin && event.data?.undoPaintSample && event.source === document.querySelector(selector)?.contentWindow)
      trace.preview.push(event.data.undoPaintSample);
  });
  document.addEventListener('click', event => {
    if (event.isTrusted && event.target.closest(actionSelector)) window.__historyClick = performance.timeOrigin + event.timeStamp;
  }, true);
  function sample() {
    const iframe = document.querySelector(selector);
    const loader = document.querySelector('.motion-editor-asset-loading');
    const at = performance.timeOrigin + performance.now();
    trace.timeline.push({ at, value: read(clip) });
    trace.stage.push({ at, visible: Boolean(iframe?.clientWidth && iframe.clientHeight &&
      iframe.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !loader?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) });
    requestAnimationFrame(sample);
  }
  sample();
}
const close = (actual, expected, timeline) => actual?.length === expected.length && actual.every((n, i) =>
  Math.abs(n - expected[i]) <= (timeline && i === 0 ? .02 : 2));

async function moveClip(page, dx) {
  const point = await page.$eval(soundtrack, node => {
    const r = node.getBoundingClientRect(), v = node.closest('[data-timeline-scroll-viewport]').getBoundingClientRect();
    const x = (Math.max(r.left, v.left) + Math.min(r.right, v.right)) / 2, y = r.top + r.height / 2;
    if (!node.contains(document.elementFromPoint(x, y))) throw Error('drag must hit soundtrack');
    return { x, y };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + dx, point.y, { steps: 10 });
  await page.waitForSelector('[data-testid="timeline-drag-landing"]', { timeout: 2000 });
  await page.mouse.up();
}

// Pause delivery of real HTTP responses after server acceptance. Delayed SSE cannot
// supply an apparent local restore while HTTP is held; peers consume normal SSE.
async function holdResponses(page, id, immediate, report) {
  const cdp = await page.createCDPSession();
  const routes = { 'history/step': 'history', 'history/step-guarded': 'history', ...(immediate && { 'text-edits/batch': 'save' }) };
  const paused = new Map();
  cdp.on('Fetch.requestPaused', event => {
    const path = new URL(event.request.url).pathname.slice(`/api/projects/${id}/`.length);
    const name = routes[path];
    report.network[name] = { path, pausedAt: Date.now(), status: event.responseStatusCode };
    if (name === 'history') report.network[name].direction = JSON.parse(event.request.postData).direction;
    paused.set(name, event.requestId);
  });
  await page.evaluate(() => { window.__receiptProbe.holdSse = true; });
  await cdp.send('Fetch.enable', { patterns: Object.keys(routes).map(path => ({
    urlPattern: `*/api/projects/${id}/${path}`, requestStage: 'Response',
  })) });
  return {
    wait: name => until(() => paused.has(name), Boolean, `${name} response never intercepted`, 10000),
    async release(name) {
      assert.equal(report.network[name].status, 200, name + ' failed');
      report.network[name].releasedAt = Date.now();
      await cdp.send('Fetch.continueRequest', { requestId: paused.get(name) });
    },
    async finish() {
      await cdp.send('Fetch.disable');
      await page.evaluate(() => window.__receiptProbe.releaseSse());
      await cdp.detach();
    },
  };
}

async function run(mode) {
  const timeline = mode.startsWith('timeline'), immediate = mode.endsWith('immediate');
  const isRedo = mode.endsWith('-redo'), action = isRedo ? redo : undo;
  const report = { mode, origin, maxPaintMs, holdMs, slowNetwork, network: {}, errors: [], violations: [] };
  const network = [], receipts = [];
  let browser, id;
  try {
    ({ browser } = await launchStudioChrome());
    const create = await fetch(projects, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      title: `QA responsive undo ${mode}`, projectType: 'template', templateId: 'openmotion-welcome', selectActive: false, requestId: crypto.randomUUID(),
    }) });
    assert(create.ok, `create fixture: HTTP ${create.status}`);
    ({ projectId: id } = await create.json());
    assert(id);
    const open = name => openEditor(browser, origin, id, 16.5, name, network);
    const [source, peer] = await Promise.all([open('source'), open('peer')]);
    const observe = async page => timeline ? page.evaluate(readClip, soundtrack) : (await liveFrame(page)).evaluate(readCanvas);
    const sample = (page, expected, label) => until(() => observe(page).catch(() => null), v => close(v, expected, timeline), label, 10000);
    // Timeline views fit their own viewport and project duration. Compare the actual
    // screen position within the writer; compare the same visible clip's time across tabs.
    const verifyTab = (page, expected, label) => timeline ? until(() => observe(page), v => v && Math.abs(v[0] - expected[0]) < .02, label) : sample(page, expected, label);
    source.on('pageerror', err => report.errors.push(String(err)));
    source.on('response', async response => {
      const path = new URL(response.url()).pathname;
      if (response.request().method() !== 'POST' || !path.startsWith(`/api/projects/${id}/`)) return;
      if (!response.ok()) report.errors.push(`${path} HTTP ${response.status()}`);
      if (path.endsWith('/text-edits/batch')) {
        try {
          const batch = await response.json();
          if (batch.failed) report.errors.push(JSON.stringify(batch.failed));
          receipts.push(...batch.committed.map(step => step.id));
        } catch (error) { report.errors.push(String(error)); }
      }
    });
    const traffic = new Map();
    source.on('request', request => {
      const path = new URL(request.url()).pathname;
      const prefix = `/api/projects/${id}/`;
      if (!path.startsWith(prefix)) return;
      const route = path.slice(prefix.length);
      if (['file-source', 'history', 'history/step', 'history/step-guarded', 'preview', 'text-edits/batch'].includes(route))
        traffic.set(request, { method: request.method(), path: route, start: Date.now() });
      if (path === prefix + 'history/step' || path === prefix + 'history/step-guarded') report.historyRequestAt = Date.now();
    });
    source.on('requestfinished', request => { const row = traffic.get(request); if (row) row.end = Date.now(); });
    const saved = n => until(() => receipts.length, v => v >= n, `${n} committed gestures`, 10000);
    await source.bringToFront();
    const initial = await observe(source);
    assert(initial, 'fixture target is visible');
    let point, selection;
    if (!timeline) {
      point = await inputPoint(source, 'reel-canvas');
      await source.mouse.click(point.x, point.y);
      await source.waitForFunction(() => location.href.includes('selId=reel-canvas') && document.querySelector('[data-resize-corner]'));
      selection = await selectionPaint(source, await liveFrame(source), preview, mode, evidence, report);
      await selection.checkpoint('selected', initial);
    }
    const move = async (dx, dy, from) => {
      if (timeline) {
        await moveClip(source, dx);
        return until(() => observe(source), v => v && v[0] > from[0] + .05 && v[1] > from[1] + 4, 'clip visibly advanced');
      }
      await drag(source, point, dx, dy);
      point = { ...point, x: point.x + dx, y: point.y + dy };
      const expected = [from[0] + dx / point.scaleX, from[1] + dy / point.scaleY, ...from.slice(2)];
      return sample(source, expected, 'canvas visibly moved');
    };
    // Keep the selection's four edges inside the editor's clipped preview pane.
    const first = await move(timeline ? 60 : 18, 8, initial);
    await saved(1);
    await sample(source, first, 'first saved move');
    await selection?.controls(first);
    await source.waitForSelector(`${undo}:not(:disabled)`, { timeout: 6000 });
    const originalFrame = await liveFrame(source);
    const previewOrigin = new URL(originalFrame.url()).origin;
    const sampler = `(${samplePreview})((${readCanvas}), ${JSON.stringify(previewOrigin)})`;
    await source.evaluate(`(${watchStudio})((${readClip}), ...${JSON.stringify([soundtrack, preview, action, previewOrigin])})`);
    await source.evaluateOnNewDocument(sampler);
    await originalFrame.evaluate(sampler);
    await source.waitForFunction(() => window.__undoTrace.preview.some(row => row.painted), { timeout: 2000 });
    // RTT alone exceeds the local paint budget, including any preparatory file/history reads.
    // Throttle after opening so cold asset downloads do not dominate setup time.
    await source.emulateNetworkConditions(slowNetwork);
    const rows = () => source.evaluate(key => window.__undoTrace[key], timeline ? 'timeline' : 'preview');
    let gate;
    if (immediate) gate = await holdResponses(source, id, true, report);
    const second = await move(timeline ? 45 : -8, -11, first);
    if (!immediate) {
      await saved(2);
      await verifyTab(peer, second, 'peer must show the second move before undo');
      if (isRedo) {
        // The measured forward step starts from a server-confirmed, peer-visible Undo.
        const [reply] = await Promise.all([source.waitForResponse(response => response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `/api/projects/${id}/history/step-guarded` &&
          JSON.parse(response.request().postData()).direction === 'back', { timeout: 10000 }), source.click(undo)]);
        assert.equal(reply.status(), 200, 'setup Undo failed');
        await reply.json();
        await sample(source, first, 'setup Undo must restore the first move');
        await verifyTab(peer, first, 'peer must show setup Undo');
        await source.waitForSelector(`${redo}:not(:disabled)`, { timeout: 10000 });
      }
      gate = await holdResponses(source, id, false, report);
    }
    const expected = isRedo ? second : first;
    Object.assign(report, { first, second });
    const mounted = await mountProbe(source);
    const since = network.length;
    if (immediate) assert.equal(receipts.length, 1, 'second save already acknowledged');
    assert.equal(await source.$eval(action, button => button.disabled), false, 'history toolbar button must accept the click');
    const priorRequests = new Set(traffic.keys());
    await selection?.start();
    await source.click(action);
    const click = report.clickAt = await source.evaluate(() => window.__historyClick);
    assert(click, 'trusted history click was not delivered');
    if (!isRedo) report.moveToClickMs = Math.round(click - await source.evaluate(() => window.__lastMoveRelease));
    // Read the held-state samples before releasing anything. On regressions continue
    // through the real ACK to measure the latency and validate later persistence too.
    await delay(holdMs);
    const held = await rows();
    const correct = row => row.at >= click && (timeline || row.painted) && close(row.value, expected, timeline);
    const firstHeld = held.find(correct);
    report.preAckPaintMs = firstHeld ? Math.round(firstHeld.at - click) : null;
    if (report.preAckPaintMs == null || report.preAckPaintMs > maxPaintMs) report.violations.push('restore missed local paint budget before ACK');
    if (immediate) {
      await gate.wait('save');
      await gate.release('save');
    }
    await gate.wait('history');
    if (immediate) await delay(holdMs);
    const beforeHistory = (await rows()).find(correct);
    report.preHistoryAckPaintMs = beforeHistory ? Math.round(beforeHistory.at - click) : null;
    await selection?.checkpoint('history-held', expected);
    await gate.release('history');
    await gate.finish();
    await sample(source, expected, 'source must show restored position after ACK');
    await verifyTab(peer, expected, 'peer must receive the history step');
    await source.waitForSelector(`${isRedo ? undo : redo}:not(:disabled)`, { timeout: 10000 });
    await delay(350);
    if (selection) {
      await selection.finish(click, report.network.history.releasedAt, expected);
      await selection.checkpoint('confirmed', expected);
    }
    const trace = await source.evaluate(() => window.__undoTrace);
    const frames = timeline ? trace.timeline : trace.preview;
    const firstCorrect = frames.findIndex(correct);
    report.firstCorrectMs = firstCorrect >= 0 ? Math.round(frames[firstCorrect].at - click) : null;
    report.stableFrames = firstCorrect >= 0 ? frames.length - firstCorrect : 0;
    report.blankStageFrames = trace.stage.filter(row => row.at >= click && !row.visible).length;
    report.blankArtworkFrames = trace.preview.filter(row => row.at >= click && !row.painted).length;
    report.mount = await mounted();
    const requests = [...traffic.entries()].filter(([request]) => !priorRequests.has(request)).map(([, row]) => ({
      method: row.method, path: row.path, startMs: Math.round(row.start - click), endMs: row.end && Math.round(row.end - click),
    }));
    report[isRedo ? 'requestsDuringRedo' : 'requestsDuringUndo'] = requests;
    report.previewRequests = network.slice(since).filter(r => r.name === 'source' && r.type === 'document' && !r.capture);
    if (report.blankStageFrames || report.blankArtworkFrames || frames.some(row => row.at >= click && !row.value)) report.violations.push('empty target or preview frame');
    if (report.stableFrames < 2 || frames.slice(firstCorrect).some(row => !close(row.value, expected, timeline))) report.violations.push('restored geometry did not persist');
    if (!report.mount.same || !report.mount.sameDocument || report.mount.additions || report.previewRequests.length) report.violations.push('preview reloaded during history step');
    const steps = requests.filter(row => row.path === 'history/step' || row.path === 'history/step-guarded');
    if (steps.length !== 1 || steps[0].path !== 'history/step-guarded' || report.network.history.direction !== (isRedo ? 'forward' : 'back'))
      report.violations.push('expected one guarded history step in the requested direction');
    await source.emulateNetworkConditions(null);
    if (!timeline && !isRedo) point = { ...point, x: point.x + 8, y: point.y + 11 };
    const third = await move(timeline ? 155 : 12, 0, expected);
    assert(!close(third, second, timeline), 'new move must be distinct from the second move');
    await saved(3);
    if (selection) {
      await selection.checkpoint('following-drag', third);
      await selection.close();
    }
    for (const [name, page] of Object.entries({ source, peer, cold: await open('cold') })) {
      await page.bringToFront();
      await verifyTab(page, third, `${name} must retain the later edit`);
    }
    report.third = third;
    assert.deepEqual(report.errors, [], 'unexpected errors');
    assert.deepEqual(report.violations, []);
  } catch (error) {
    report.failure = error.message;
    throw error;
  } finally {
    try { await browser?.close(); }
    finally {
      if (evidence) await writeFile(join(evidence, `${mode}.json`), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
      if (id) {
        assert((await fetch(`${projects}/${id}/trash`, { method: 'POST' })).ok, 'could not trash fixture ' + id);
        assert((await fetch(`${projects}/${id}`, { method: 'DELETE' })).ok, 'could not delete fixture ' + id);
      }
    }
  }
}

for (const mode of process.argv.length > 2 ? process.argv.slice(2) : modes) {
  assert(modes.includes(mode), `expected ${modes.join('|')}`);
  try { await run(mode); } catch (error) { console.error(`${mode}: ${error.stack}`); process.exitCode = 1; }
}
