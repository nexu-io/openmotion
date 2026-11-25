#!/usr/bin/env node
// STUDIO_URL=http://127.0.0.1:55671 node studio/tests/e2e/undo-after-drag.mjs [root|clip|immediate|timeline|timeline-immediate]
// Loopback dev-auth stack, real Chrome, isolated preview, Welcome template. Never opens an existing project.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchStudioChrome } from './chrome-executable.mjs';
import { drag, inputPoint, liveFrame, mountedVersion, openEditor, openMcp, state, until } from './preview-receipt-harness.mjs';

const endpoint = new URL(process.env.STUDIO_URL);
assert(['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname), 'use a loopback dev-auth stack');
const projects = endpoint.origin + '/motion-api/projects';
const reel = 'compositions/reel.html';
const close = (a, b) => a && b.every((v, i) => Math.abs(a[i] - v) <= 2);
const evidence = process.env.EVIDENCE_DIR;
if (evidence) await mkdir(evidence, { recursive: true });

async function observe(page, id, report) {
  const pending = new WeakMap();
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'POST' || !path.startsWith(`/api/projects/${id}/`)) return;
    const row = { path: path.slice(`/api/projects/${id}`.length), at: Date.now(), request: JSON.parse(request.postData() || 'null') };
    report.requests.push(row);
    pending.set(request, row);
  });
  page.on('requestfailed', request => { const row = pending.get(request); if (row) row.error = request.failure()?.errorText; });
  page.on('response', async reply => {
    const row = pending.get(reply.request());
    if (!row) return;
    row.status = reply.status();
    try { row.response = await reply.json(); } catch (err) { row.error = String(err); }
    row.answered = Date.now();
    if (row.status >= 400 || row.response?.failed || row.response?.ok === false) console.error('Rejected:', JSON.stringify(row));
  });
  page.on('pageerror', err => report.errors.push(String(err)));
  await page.evaluate(() => {
    window.__undoFeedback = [];
    window.__undoTargets = [];
    window.addEventListener('message', ({ data }) => {
      const target = data?.result?.target ?? data?.result;
      if (data?.source !== 'openmotion-preview-bridge' || data.type !== 'response' || target?.elementId !== 'reel-canvas') return;
      const { fileVersion, sha256, sourceFile, left, top } = target;
      window.__undoTargets.push({ at: Date.now(), sourceFile, fileVersion, sha256, left, top });
    });
    const observed = new WeakSet();
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[data-toast-tone]')) if (!observed.has(el)) {
        observed.add(el); window.__undoFeedback.push({ at: Date.now(), tone: el.dataset.toastTone, text: el.textContent });
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

async function timelineCase({ source, peer, open, history, receipts, snapshot, holdBatch, report }) {
  // Audio is on its own lane: moving it sideways cannot reorder the adjacent Welcome scenes.
  const clip = '.timeline-clip[data-el-id$="welcome-soundtrack"]';
  const start = page => page.$eval(clip, n => Number(n.dataset.clipStart));
  const move = async (dx, n, waitForSave = true) => {
    const before = await start(source);
    const point = await source.$eval(clip, n => {
      const r = n.getBoundingClientRect(), viewport = n.closest('[data-timeline-scroll-viewport]').getBoundingClientRect();
      return { x: (Math.max(r.left, viewport.left) + Math.min(r.right, viewport.right)) / 2, y: r.top + r.height / 2 };
    });
    assert(await source.evaluate(({x,y}, sel) => !!document.elementFromPoint(x,y)?.closest(sel), point, clip), 'pointer must hit the soundtrack');
    await source.mouse.move(point.x, point.y); await source.mouse.down();
    await source.mouse.move(point.x + dx, point.y, { steps: 12 });
    await source.waitForSelector('[data-testid="timeline-drag-landing"]', { timeout: 2000 });
    await source.mouse.up();
    if (waitForSave) await receipts(n);
    return until(() => start(source), s => s > before + .05, 'timeline move must advance the soundtrack');
  };
  await source.waitForSelector(clip, { visible: true });
  const first = await move(60, 1), immediate = report.mode === 'timeline-immediate';
  if (immediate) await holdBatch();
  const second = await move(45, 2, !immediate);
  await history('Undo', immediate); await snapshot('undo');
  await until(() => start(source), s => Math.abs(s - first) < .02, `timeline undo must restore ${first}`);
  const third = await move(155, 3);
  assert(Math.abs(second - third) > .05, 'new move must differ from discarded redo state');
  for (const [name, page] of Object.entries({ source, peer, cold: await open('cold') })) {
    await page.bringToFront();
    report.samples[name] = await until(() => start(page), s => Math.abs(s - third) < .02, `${name}: expected clip start ${third}`);
  }
  report.samples.history = { first, second, third };
}

async function run(mode) {
  const report = { mode, requests: [], errors: [], samples: {}, versions: {} };
  let browser, id, mcp, source, peer, gate;
  const time = mode === 'clip' ? 5.767 : 16.5; // reel begins at 10.733 s in the root timeline.
  const pages = {};
  const open = async name => pages[name] = await openEditor(browser, endpoint.origin, id, time, name, [], mode === 'clip' ? reel : undefined);
  const snapshot = async label => {
    const path = mode.startsWith('timeline') ? 'index.html' : reel;
    const saved = (await mcp.read(path)).file;
    const version = async page => page && mountedVersion(page, path).catch(() => null);
    report.versions[label] = { path, server: saved.fileVersion, tag: saved.content.match(path === 'index.html' ? /<audio\s[^>]+>/ : /<canvas\s[^>]+>/)?.[0],
      source: await version(source), peer: await version(peer) };
  };
  const committed = () => report.requests.flatMap(row => row.response?.committed ?? []).length;
  const holdBatch = async () => {
    gate = await source.createCDPSession();
    await gate.send('Fetch.enable', { patterns: [{ urlPattern: `*/api/projects/${id}/text-edits/batch`, requestStage: 'Response' }] });
  };
  const healthy = () => {
    const bad = report.requests.find(r => r.status >= 400 || r.error || r.response?.failed || r.response?.ok === false);
    assert(!bad, 'Rejected request: ' + JSON.stringify(bad));
  };
  const receipts = n => until(() => { healthy(); return committed(); }, count => count >= n, `expected ${n} saved gestures`, 8000);
  const sample = async (label, page, expected) => {
    await page.bringToFront();
    const actual = await until(async () => { healthy(); return (await state(page).catch(() => null))?.reel; }, r => close(r, expected), `${label} expected ${expected}`, 8000);
    report.samples[label] = actual;
  };
  const history = async (action, shortcut = false) => {
    if (!shortcut) await source.bringToFront();
    const start = report.requests.length;
    if (shortcut) {
      await source.keyboard.down('Meta'); await source.keyboard.press('z'); await source.keyboard.up('Meta');
      // The key is already delivered. Let Chrome release the real save(s); no synthetic success or history result.
      await gate.send('Fetch.disable');
    } else {
      const selector = `button[aria-label="${action}"]:not(:disabled)`;
      await source.waitForSelector(selector, { visible: true, timeout: 8000 });
      await source.click(selector);
    }
    await until(() => { healthy(); return report.requests.slice(start).find(r => r.path === '/history/step' && r.answered); }, Boolean, `${action}: no history/step response`, 8000);
  };
  try {
    ({ browser } = await launchStudioChrome());
    const create = await fetch(projects, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      title: `QA undo after ${mode} drag`, projectType: 'template', templateId: 'openmotion-welcome', selectActive: false, requestId: crypto.randomUUID() }) });
    assert(create.ok, `project creation: HTTP ${create.status}`);
    ({ projectId: id } = await create.json()); assert(id);
    mcp = await openMcp(endpoint.origin, id);
    [source, peer] = await Promise.all([open('source'), open('peer')]);
    await observe(source, id, report);
    await source.bringToFront();
    if (mode.startsWith('timeline')) {
      await timelineCase({ source, peer, open, history, receipts, snapshot, holdBatch, report });
      await snapshot('final'); healthy(); console.log('PASS', mode); return;
    }
    const initial = (await state(source)).reel, p = await inputPoint(source, 'reel-canvas');
    const box = (dx, dy) => initial.map((v, i) => v + [dx / p.scaleX, dy / p.scaleY, 0, 0][i]);
    await source.mouse.click(p.x, p.y);
    await source.waitForFunction(() => location.href.includes('selId=reel-canvas') && document.querySelector('[data-resize-corner]'), { timeout: 8000 });
    await snapshot('initial');
    if (mode === 'immediate') await holdBatch();
    await drag(source, p, 18, 6);
    await drag(source, { x: p.x + 18, y: p.y + 6 }, -8, 15);
    if (mode !== 'immediate') {
      await receipts(2);
      await sample('both moves saved', source, box(10, 21));
    } else {
      assert(committed() < 2, 'immediate undo must precede the last save receipt');
    }
    await history('Undo', mode === 'immediate');
    await snapshot('undo');
    await sample('undo', source, box(18, 6));
    // Do not navigate, re-select the artwork, or reopen this tab before the next drag.
    if (mode !== 'immediate') {
      const moveAgain = () => drag(source, { x: p.x + 18, y: p.y + 6 }, 12, -15);
      await moveAgain();
      try { await receipts(3); } catch (err) {
        // A second attempt after the restored frame settles distinguishes a persistent stale selection from a transient race.
        await snapshot('beforeRetry'); await moveAgain();
        await receipts(3).catch(() => {});
        throw err;
      }
      for (const [name, page] of Object.entries({ source, peer, cold: await open('cold') }))
        await sample(name + ' after same-clip move', page, box(30, -9));
    } else {
      await sample('peer undo', peer, box(18, 6));
      await history('Redo'); await sample('redo', source, box(10, 21));
      await history('Undo'); await sample('first repeated undo', source, box(18, 6));
      await history('Undo');
      for (const [name, page] of Object.entries({ source, peer, cold: await open('cold') })) await sample(name + ' restored', page, initial);
    }
    await snapshot('final'); healthy();
    assert.deepEqual(await source.evaluate(() => window.__undoFeedback.filter(t => t.tone === 'error')), [], 'unexpected error toast');
    console.log('PASS', mode);
  } catch (err) {
    report.failure = err.message;
    if (mcp) await snapshot('failure').catch(() => {});
    if (source) {
      report.visibleFeedback = await source.$$eval('[role="alert"],[role="status"]', nodes => nodes.map(n => n.textContent)).catch(() => []);
      if (evidence) await source.screenshot({ path: join(evidence, `${mode}-failure.png`) }).catch(() => {});
    }
    for (const [name, page] of Object.entries(pages)) {
      report.samples[name + ' at failure'] = await (await liveFrame(page)).evaluate(() => {
        const n = document.getElementById('reel-canvas'), r = n?.getBoundingClientRect();
        return { time: window.__player?.getTime?.(), reel: r && [r.x, r.y, r.width, r.height], inlineStyle: n?.getAttribute('style') };
      }).catch(() => null);
    }
    throw err;
  } finally {
    if (source) Object.assign(report, await source.evaluate(() => ({ toasts: window.__undoFeedback, targets: window.__undoTargets })).catch(() => ({})));
    if (report.failure) console.error(JSON.stringify(report, null, 2));
    try { await browser?.close(); if (mcp) await mcp.close(); }
    finally {
      if (id) {
        assert((await fetch(`${projects}/${id}/trash`, { method: 'POST' })).ok, 'failed to trash ' + id);
        assert((await fetch(`${projects}/${id}`, { method: 'DELETE' })).ok, 'failed to delete ' + id);
      }
      if (evidence) await writeFile(join(evidence, `${mode}.json`), JSON.stringify(report, null, 2));
    }
  }
}

const modes = ['root', 'clip', 'immediate', 'timeline', 'timeline-immediate'];
for (const mode of process.argv.length > 2 ? process.argv.slice(2) : modes) {
  assert(modes.includes(mode), `expected ${modes.join('|')}`);
  try { await run(mode); } catch (err) { console.error(`${mode}: ${err.message}`); process.exitCode = 1; }
}
