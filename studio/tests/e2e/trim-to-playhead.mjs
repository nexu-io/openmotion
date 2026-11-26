// STUDIO_URL=http://127.0.0.1:55741 node studio/tests/e2e/trim-to-playhead.mjs [title-left|title-right|audio-left|audio-right]...
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
const cases = ['title-left', 'title-right', 'audio-left', 'audio-right'];

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

async function run(name) {
  const audio = name.startsWith('audio'), left = name.endsWith('left');
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
    report.playhead = await activeFrame.evaluate(() => window.__player.getTime());
    assert.equal(Number(report.playhead.toFixed(2)), cut, 'expected playhead on the 3.17 s ruler frame');
    const before = await writer.evaluate(() => window.__trim.read());
    assert(before.start < cut && before.end > cut);
    const target = left ? { start: cut, end: before.end } : { start: before.start, end: cut };
    const traffic = new Map();
    const prefix = `/api/projects/${id}/`;
    writer.on('request', req => {
      const url = new URL(req.url());
      if (!/^\/(api|motion-api)\//.test(url.pathname) || url.pathname.includes('/~assets/')) return;
      const path = url.pathname.replace(prefix, ''), type = req.resourceType();
      const preview = path === 'preview' ? { activeFrame: req.frame() === activeFrame, capture: url.searchParams.has('capture') } : undefined;
      traffic.set(req, { method: req.method(), path, type, preview, at: Date.now() });
    });
    writer.on('response', res => { const row = traffic.get(res.request()); if (row) row.serverDelay = res.headers()['x-local-delay-ms']; });
    writer.on('requestfinished', req => { const row = traffic.get(req); if (row) row.end = Date.now(); });
    if (rtt) await writer.emulateNetworkConditions({ latency: rtt, download: 2_000_000, upload: 1_000_000 });
    if (held) await writer.evaluate(() => { window.__receiptProbe.holdSse = true; });
    const ack = writer.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname === prefix + 'text-edits/batch')
      .then(response => ({ response, received: Date.now() }));
    await writer.click(button);
    const click = await writer.evaluate(() => window.__trim.click);
    assert(click, 'trusted toolbar click');
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
    const html = await readFile();
    const persisted = await writer.evaluate((html, id) => {
      const el = new DOMParser().parseFromString(html, 'text/html').getElementById(id);
      return { start: Number(el.dataset.start), duration: Number(el.dataset.duration), offset: el.dataset.playbackStart ?? el.dataset.mediaStart };
    }, html, elId);
    assert(sameTimes({ start: persisted.start, end: persisted.start + persisted.duration }, target), JSON.stringify(persisted));
    if (audio) assert.equal(Number(persisted.offset ?? 0), left ? cut : 0);
    await see(peer, target, 'peer sees trim');
    const reopened = await open('reopened');
    await see(reopened, target, 'reopened project shows trim');
    await writer.bringToFront();
    const undo = 'button[aria-label="Undo"]:not(:disabled)';
    await writer.waitForSelector(undo);
    await writer.click(undo);
    await see(writer, before, 'writer undo');
    await see(peer, before, 'peer undo');
    await until(readFile, html => html === original, 'undo restores original file bytes');
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
