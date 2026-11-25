// STUDIO_URL=http://127.0.0.1:55751 node studio/tests/e2e/trim-to-playhead.mjs [case]...
// Audio cases: audio-left, audio-right (paused), audio-left-playing, audio-right-playing.
// Default: hold the writer's save ACK and SSE separately. TRIM_MODE=natural disables
// both gates. Neither mode adds latency to the server's own network profile by default.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { launchStudioChrome } from './chrome-executable.mjs';
import { liveFrame, mountProbe, openEditor, openMcp, seek, until } from './preview-receipt-harness.mjs';

const origin = new URL(process.env.STUDIO_URL).origin;
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'requires loopback dev-auth');
const projects = `${origin}/motion-api/projects`;
const cut = 3.17, budget = 200, rtt = Number(process.env.TRIM_RTT_MS ?? 0);
const held = (process.env.TRIM_MODE ?? 'held') === 'held';
const cases = ['title-left', 'title-right', 'audio-left', 'audio-right', 'audio-left-playing', 'audio-right-playing'];
const playback = '[data-studio-control="playback"]';

function installProbe(selector, button) {
  const read = () => {
    const node = document.querySelector(selector);
    if (!node?.checkVisibility()) return null;
    const rect = node.getBoundingClientRect(), track = node.offsetParent.getBoundingClientRect();
    const ticks = document.querySelectorAll('[data-timeline-grid-cell="major"]');
    if (ticks.length < 2) return null;
    const pps = (ticks[1].getBoundingClientRect().x - ticks[0].getBoundingClientRect().x) /
      (Number(ticks[1].dataset.timelineRulerTime) - Number(ticks[0].dataset.timelineRulerTime));
    return { start: Number(node.dataset.clipStart), end: Number(node.dataset.clipEnd), x: rect.left - track.left, width: rect.width, pps };
  };
  const trace = window.__trim = { frames: [], read, click: null, tasks: [] };
  new PerformanceObserver(entries => {
    for (const { startTime, duration } of entries.getEntries()) trace.tasks.push({ at: performance.timeOrigin + startTime, duration });
  }).observe({ type: 'longtask' });
  document.addEventListener('click', e => {
    if (!e.isTrusted || !e.target.closest(button)) return;
    trace.click = performance.timeOrigin + e.timeStamp;
    function next() {
      trace.frames.push({ ms: Math.round(performance.timeOrigin + performance.now() - trace.click), clip: read() });
      if (!trace.stop) requestAnimationFrame(next);
    }
    requestAnimationFrame(next);
  }, true);
}

const sameTimes = (actual, expected) => !!actual && Math.abs(actual.start - expected.start) < .001 && Math.abs(actual.end - expected.end) < .001;

// Read both clocks in the same preview execution context, including during playback.
function readAudio() {
  const el = document.getElementById('welcome-soundtrack'), player = window.__player;
  if (!(el instanceof HTMLAudioElement) || !player) return null;
  const start = Number(el.dataset.start);
  return { start, end: start + Number(el.dataset.duration), offset: Number(el.dataset.playbackStart ?? el.dataset.mediaStart ?? 0),
    time: player.getTime(), playing: player.isPlaying(), currentTime: el.currentTime, paused: el.paused,
    audible: !el.paused && !el.muted && el.volume > 0 && el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
    sameAudio: window.__trimOriginalAudio && el === window.__trimOriginalAudio };
}

const clocksAgree = s => Math.abs(s.currentTime - (s.offset + s.time - s.start)) <= .1;

async function checkAudioAt(page, expected, offset, time, label) {
  await seek(page, time);
  const frame = await liveFrame(page);
  return until(() => frame.evaluate(readAudio), s => sameTimes(s, expected) && Math.abs(s.offset - offset) < .001 &&
    !s.playing && s.paused && Math.abs(s.time - time) < .05 && clocksAgree(s), label);
}

async function playAudioAt(page, time) {
  await seek(page, time);
  await page.click(playback + '[aria-label="Play"]');
  const frame = await liveFrame(page);
  return until(() => frame.evaluate(readAudio), s => s?.playing && s.audible && s.time > time + .1 && clocksAgree(s), 'soundtrack playing in sync');
}

async function isThumbnailFrame(frame) {
  const owner = await frame?.frameElement();
  if (!owner) return false;
  try { return await owner.evaluate(el => el.matches('iframe[data-openmotion-thumb-capture="true"]')); }
  finally { await owner.dispose(); }
}

async function run(name) {
  const audio = name.startsWith('audio'), left = name.includes('-left'), playing = name.endsWith('-playing');
  const elId = audio ? 'welcome-soundtrack' : 'title';
  const selector = `.timeline-clip[data-el-id="index.html#${elId}"]`;
  const button = `button[aria-label="Trim ${left ? 'left' : 'right'} to playhead"]`;
  const report = { name, origin, rtt, mode: held ? 'held' : 'natural' };
  let browser, id, mcp;
  try {
    const create = await fetch(projects, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      title: `QA toolbar trim ${name}`, requestId: crypto.randomUUID(), selectActive: false,
      ...(audio && { projectType: 'template', templateId: 'openmotion-welcome' }),
    }) });
    assert(create.ok, `create project: HTTP ${create.status}`);
    id = (await create.json()).projectId;
    assert.match(id, /^[\da-f-]{36}$/i);
    ({ browser } = await launchStudioChrome());
    mcp = await openMcp(origin, id);
    const readFile = async () => (await mcp.read('index.html')).file.content;
    const original = await readFile();
    const open = async role => {
      const page = await openEditor(browser, origin, id, cut, role, []);
      await page.evaluate(installProbe, selector, button);
      return page;
    };
    const [writer, peer] = await Promise.all([open(held ? 'writer' : 'source'), open('peer')]);
    const see = (page, expected, label) => until(() => page.evaluate(() => window.__trim.read()), actual => sameTimes(actual, expected), label);
    await writer.bringToFront();
    await writer.click(selector);
    await seek(writer, cut);
    await writer.waitForSelector(button + ':not(:disabled)');
    await writer.waitForNetworkIdle({ idleTime: 500, timeout: 15000, concurrency: 2 });
    const probeMount = await mountProbe(writer);
    const activeFrame = await liveFrame(writer);
    if (audio) await activeFrame.evaluate(() => { window.__trimOriginalAudio = document.getElementById('welcome-soundtrack'); });
    report.playhead = await activeFrame.evaluate(() => window.__player.getTime());
    assert.equal(Number(report.playhead.toFixed(2)), cut, 'expected playhead on the 3.17 s ruler frame');
    const before = await writer.evaluate(() => window.__trim.read());
    assert(before.start < cut && before.end > cut);
    const traffic = new Map();
    const captures = [];
    const prefix = `/api/projects/${id}/`;
    writer.on('request', req => {
      const url = new URL(req.url());
      if (!/^\/(api|motion-api)\//.test(url.pathname) || url.pathname.includes('/~assets/')) return;
      const path = url.pathname.replace(prefix, ''), type = req.resourceType();
      const preview = (path === 'preview' || path.startsWith('preview/comp/')) ?
        { activeFrame: req.frame() === activeFrame, capture: url.searchParams.get('capture') === '1' } : undefined;
      if (audio && preview?.capture) captures.push(isThumbnailFrame(req.frame()).then(ok => { preview.thumbnail = ok; }, () => { preview.thumbnail = false; }));
      traffic.set(req, { method: req.method(), path, type, preview, at: Date.now() });
    });
    writer.on('response', res => { const row = traffic.get(res.request()); if (row) row.serverDelay = res.headers()['x-local-delay-ms']; });
    writer.on('requestfinished', req => { const row = traffic.get(req); if (row) row.end = Date.now(); });
    if (rtt) await writer.emulateNetworkConditions({ latency: rtt, download: 2_000_000, upload: 1_000_000 });
    if (playing) report.playingBeforeClick = await playAudioAt(writer, cut);
    if (held) await writer.evaluate(() => { window.__receiptProbe.holdSse = true; });
    const ack = writer.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname === prefix + 'text-edits/batch')
      .then(response => ({ response, received: Date.now() }));
    await writer.click(button);
    const click = await writer.evaluate(() => window.__trim.click);
    assert(click, 'trusted toolbar click');
    const clickTime = playing ? await activeFrame.evaluate(() => window.__player.getTime()) : cut;
    const { response, received } = await ack;
    const receipt = await response.json();
    assert.equal(response.status(), 200);
    assert.equal(receipt.committed?.length, 1, JSON.stringify(receipt));
    assert(!receipt.failed, JSON.stringify(receipt));
    report.httpResponseMs = Math.round(received - click);
    if (held) {
      await writer.waitForFunction(() => window.__receiptProbe.batches.length > 0);
      await delay(900);
      report.ackReleasedMs = await writer.evaluate(() => {
        const now = performance.timeOrigin + performance.now();
        window.__receiptProbe.batches[0].release();
        return Math.round(now - window.__trim.click);
      });
      await writer.waitForFunction(() => !!window.__receiptProbe.batches[0].parsed);
      await delay(1000);
      report.sseReleasedMs = await writer.evaluate(() => {
        const now = performance.timeOrigin + performance.now();
        window.__receiptProbe.releaseSse();
        return Math.round(now - window.__trim.click);
      });
    }
    // During playback the toolbar can receive a newer transport sample than the last seek.
    // Bound the saved cut by both samples; the paused cases assert the exact ruler frame.
    const html = await readFile();
    const persisted = await writer.evaluate((html, id) => {
      const el = new DOMParser().parseFromString(html, 'text/html').getElementById(id);
      return { start: Number(el.dataset.start), duration: Number(el.dataset.duration), offset: el.dataset.playbackStart ?? el.dataset.mediaStart };
    }, html, elId);
    const boundary = playing ? (left ? persisted.start : persisted.start + persisted.duration) : cut;
    assert(boundary >= cut - .01 && boundary <= clickTime + .05, 'trim at sampled playhead');
    const target = left ? { start: boundary, end: before.end } : { start: before.start, end: boundary };
    assert(sameTimes({ start: persisted.start, end: persisted.start + persisted.duration }, target), JSON.stringify(persisted));
    await see(writer, target, 'writer shows trimmed times');
    await delay(650); // Include the async response/SSE reconciliation and any preview navigation.
    const frames = await writer.evaluate(() => { window.__trim.stop = true; return window.__trim.frames; });
    // The right edge can remain at the viewport's right side when auto-fit zooms in.
    // Compare its real rectangle against the rendered ruler of *this* frame.
    const correct = f => sameTimes(f.clip, target) && Math.abs(f.clip.width - (target.end - target.start) * f.clip.pps) < 2 &&
      Math.abs(f.clip.x - target.start * f.clip.pps) < 2;
    const first = frames.findIndex(correct);
    const requests = [...traffic.values()].filter(row => row.at >= click - 1).map(row => ({ method: row.method, path: row.path,
      type: row.type, preview: row.preview, serverDelay: row.serverDelay, startMs: Math.round(row.at - click), endMs: row.end && Math.round(row.end - click) }));
    Object.assign(report, { firstGeometryMs: frames[first]?.ms ?? null, firstFrameMs: frames[0]?.ms,
      revertedFrames: first < 0 ? null : frames.slice(first).filter(f => !correct(f)).length, before, final: frames.at(-1)?.clip,
      preview: await probeMount(), longTasks: await writer.evaluate(() => window.__trim.tasks.filter(t => t.at + t.duration > window.__trim.click)
        .map(t => ({ ms: Math.round(t.at - window.__trim.click), duration: t.duration }))), requests });
    await see(peer, target, 'peer sees trim');
    const audibleTime = left ? boundary + 1 : boundary - 1, offset = left ? boundary : 0;
    if (audio) {
      assert.equal(Number(persisted.offset ?? 0), offset);
      const frame = await liveFrame(writer);
      report.afterTrim = await frame.evaluate(readAudio);
      assert.deepEqual(report.preview, { same: true, additions: 0, sameDocument: true }, 'trim replaced the primary preview');
      assert(report.afterTrim?.sameAudio, 'trim replaced the primary soundtrack');
      assert(sameTimes(report.afterTrim, target) && Math.abs(report.afterTrim.offset - offset) < .001, 'live soundtrack timing');
      if (playing) {
        assert(report.afterTrim.playing && report.afterTrim.time > report.playingBeforeClick.time + .3, 'transport continued through save');
        if (left) assert(report.afterTrim.audible && clocksAgree(report.afterTrim), 'left-trimmed soundtrack continued in sync');
        else assert(report.afterTrim.paused, 'soundtrack stopped beyond the trimmed right edge');
        await writer.click(playback + '[aria-label="Pause"]');
      } else assert(!report.afterTrim.playing && report.afterTrim.paused && Math.abs(report.afterTrim.time - cut) < .05, 'paused playhead stayed at cut');
      report.afterSeek = await checkAudioAt(writer, target, offset, audibleTime, 'writer seek after trim');
      report.audible = await playAudioAt(writer, audibleTime);
      assert(report.afterSeek.sameAudio && report.audible.sameAudio, 'seeking or playing replaced the soundtrack');
      await writer.click(playback + '[aria-label="Pause"]');
      report.peerSeek = await checkAudioAt(peer, target, offset, audibleTime, 'peer seek after trim');
    }
    const reopened = await open('reopened');
    await see(reopened, target, 'reopened project shows trim');
    if (audio) report.reopenedSeek = await checkAudioAt(reopened, target, offset, audibleTime, 'cold reopen seek after trim');
    await writer.bringToFront();
    if (audio) {
      await Promise.all(captures);
      const docs = [...traffic.values()].filter(r => r.preview && r.at >= click - 1);
      assert(docs.every(r => r.method === 'GET' && r.type === 'document' && r.preview.capture && r.preview.thumbnail && !r.preview.activeFrame),
        'trim requested a full preview outside auxiliary capture');
      assert(docs.length <= 1, `unexpected thumbnail captures: ${docs.length}`);
      report.auxiliaryCaptures = docs.length;
    }
    const undo = 'button[aria-label="Undo"]:not(:disabled)';
    await writer.waitForSelector(undo);
    await writer.click(undo);
    await see(writer, before, 'writer undo');
    await see(peer, before, 'peer undo');
    await until(readFile, html => html === original, 'undo restores original file bytes');
    if (audio) {
      const restoredTime = left ? boundary - 1 : boundary + 1;
      report.undoSeek = await checkAudioAt(writer, before, 0, restoredTime, 'writer seek into restored interval');
      report.peerUndoSeek = await checkAudioAt(peer, before, 0, restoredTime, 'peer seek into restored interval');
    }
    Object.assign(report, { persisted, peerAndReopen: true, undoRestored: true });
    assert.equal(requests.filter(r => r.path === 'text-edits/batch' && r.method === 'POST').length, 1, 'one save for one toolbar click');
    assert(first >= 0 && (!held || frames[first].ms < report.ackReleasedMs) && frames[first].ms <= budget,
      `expected visible trim within ${budget} ms${held ? ' before releasing ACK' : ''}`);
    assert.equal(report.revertedFrames, 0, 'trim reverted after first geometry change');
  } finally {
    console.log(JSON.stringify(report));
    try { await browser?.close(); await mcp?.close(); }
    finally { if (id) {
      assert((await fetch(`${projects}/${id}/trash`, { method: 'POST' })).ok, `trash fixture ${id}`);
      assert((await fetch(`${projects}/${id}`, { method: 'DELETE' })).ok, `delete fixture ${id}`);
    } }
  }
}

for (const name of process.argv.length > 2 ? process.argv.slice(2) : cases) {
  assert(cases.includes(name), `unknown case ${name}`);
  try { await run(name); } catch (error) { console.error(name, error); process.exitCode = 1; }
}
