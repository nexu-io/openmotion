// STUDIO_URL=http://127.0.0.1:55701 node studio/tests/e2e/split-undo-rows.mjs [settled|immediate]...
// EVIDENCE_DIR optionally keeps the frame-by-frame writer measurements.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchStudioChrome } from './chrome-executable.mjs';
import { openEditor, openMcp, until } from './preview-receipt-harness.mjs';

const origin = new URL(process.env.STUDIO_URL).origin;
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'requires loopback dev-auth');
const projects = `${origin}/motion-api/projects`;
const cut = 3.17;
const clip = (id, start, duration) => ({ id: `index.html#${id}`, start, duration });
const shape = clips => [{ index: 0, key: 0, clips }];
const whole = shape([clip('title', 0, 5)]);
const halves = shape([clip('title', 0, cut), clip('title-split', cut, 1.83)]);
const enabled = label => `button[aria-label="${label}"]:not(:disabled)`;

// Read the actual row shells, including empty ones, and the rendered clip geometry.
// Store pixel positions separately from the timeline values (the panel can resize).
function installProbe() {
  function read() {
    const rows = [], tops = [];
    for (const row of document.querySelectorAll('[data-timeline-row]')) {
      if (!row.checkVisibility()) continue;
      const clips = [];
      for (const node of row.querySelectorAll('.timeline-clip')) {
        if (!node.checkVisibility()) continue;
        const start = Number(node.dataset.clipStart);
        clips.push({ id: node.dataset.elId, start, duration: +(Number(node.dataset.clipEnd) - start).toFixed(6) });
        tops.push(node.getBoundingClientRect().top);
      }
      rows.push({ index: Number(row.dataset.timelineRow), key: Number(row.dataset.timelineRowKey), clips });
    }
    return { rows, tops };
  }
  const probe = window.__splitRows = { read, frames: [], click: null, release: null };
  document.addEventListener('click', event => {
    if (!event.isTrusted || !['Undo', 'Redo'].includes(event.target.closest('button')?.ariaLabel)) return;
    probe.click = event.timeStamp;
    probe.release = null;
    probe.frames = [];
  }, true);
  function sample() {
    if (probe.click !== null) probe.frames.push({ ms: performance.now() - probe.click, ...read() });
    requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
}

const matches = (sample, rows) => !!sample && JSON.stringify(sample.rows) === JSON.stringify(rows) && new Set(sample.tops).size === 1;
const see = (page, rows, label) => until(() => page.evaluate(() => window.__splitRows.read()),
  sample => matches(sample, rows), label, 12_000);
const savedFile = snapshot => ({ version: snapshot.currentVersionId, revision: snapshot.revision,
  hash: snapshot.file.fileVersion, html: snapshot.file.content });

async function holdHistory(page, id) {
  const session = await page.createCDPSession();
  const pending = [];
  session.on('Fetch.requestPaused', event => pending.push(event));
  await session.send('Fetch.enable', { patterns: [{ urlPattern: `*/api/projects/${id}/history/step*`, requestStage: 'Response' }] });
  return {
    async wait(label) {
      const event = await until(() => pending.shift(), Boolean, `${label} ACK`, 12_000);
      assert.equal(event.responseStatusCode, 200);
      assert.equal(JSON.parse(event.request.postData).direction, label === 'Undo' ? 'back' : 'forward');
      return async () => {
        await page.evaluate(() => { window.__splitRows.release = performance.now() - window.__splitRows.click; });
        await session.send('Fetch.continueRequest', { requestId: event.requestId });
      };
    },
    close: () => session.detach(),
  };
}

function assess({ frames, release }, previous, expected) {
  const before = frames.filter(frame => frame.ms < release);
  const after = frames.filter(frame => frame.ms >= release);
  let changed = false;
  const invalid = frames.filter(frame => {
    if (matches(frame, expected)) { changed = true; return false; }
    return changed || !matches(frame, previous);
  });
  return { frames: frames.length, heldFrames: before.length, afterFrames: after.length,
    correctBeforeAck: before.some(frame => matches(frame, expected)), correctAtEnd: matches(frames.at(-1), expected),
    heldMs: Math.round(release), firstCorrectMs: Math.round(frames.find(frame => matches(frame, expected))?.ms ?? -1),
    extraRowFrames: frames.filter(frame => frame.rows.length > 1).length,
    invalidFrames: invalid.length, invalidBeforeAck: invalid.filter(frame => frame.ms < release).length,
    firstInvalid: invalid[0], lastInvalidMs: invalid.length ? Math.round(invalid.at(-1).ms) : null };
}

async function run(mode, report, traces) {
  let browser, mcp, id;
  try {
    const create = await fetch(projects, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), title: 'Untitled Project', selectActive: false }) });
    assert.equal(create.ok, true, `create fixture: HTTP ${create.status}`);
    id = (await create.json()).projectId;
    assert.match(id, /^[\da-f-]{36}$/i);
    ({ browser } = await launchStudioChrome());
    mcp = await openMcp(origin, id);
    const read = async () => savedFile(await mcp.read('index.html'));
    const open = async name => {
      const page = await openEditor(browser, origin, id, cut, name, []);
      await page.evaluate(installProbe);
      return page;
    };
    // The shared writer probe holds the split's real text-edit ACK. SSE stays live
    // until Undo is enabled even on a fresh project with no prior edit to undo.
    const immediate = mode === 'immediate';
    const [source, peer] = await Promise.all([open(immediate ? 'writer' : 'source'), open('peer')]);
    const original = await read();
    await see(source, whole, 'initial title');
    await source.bringToFront();
    const gate = await holdHistory(source, id);
    await source.click(enabled('Split'));
    await see(source, halves, 'two split halves');
    if (immediate) await source.waitForFunction(() => window.__receiptProbe.batches.length === 1);
    else await see(peer, halves, 'settled split reached peer');
    await source.waitForSelector(enabled('Undo'));
    const split = await read();
    assert.notEqual(split.html, original.html);
    assert.notEqual(split.version, original.version);
    report.versions = { original: original.version, split: split.version };
    for (const [index, label] of ['Undo', 'Redo', 'Undo', 'Redo'].entries()) {
      const undo = label === 'Undo', rows = undo ? whole : halves, expectedFile = undo ? original : split;
      await source.bringToFront();
      await source.waitForSelector(enabled(label));
      await source.evaluate(() => { window.__receiptProbe.holdSse = true; });
      await source.click(enabled(label));
      if (immediate && index === 0) {
        // Give the writer rendered frames while its split is still unacknowledged.
        await delay(350);
        report.splitReleaseMs = await source.evaluate(() => {
          const [batch] = window.__receiptProbe.batches;
          if (batch.parsed || window.__splitRows.click === null) throw Error('expected Undo while split ACK held');
          batch.release();
          return Math.round(performance.now() - window.__splitRows.click);
        });
      }
      const release = await gate.wait(label);
      assert.deepEqual(await read(), expectedFile, `${label} accepted exact file and history cursor`);
      await see(peer, rows, `${label} reached peer while writer ACK held`);
      await delay(450);
      await release();
      await source.evaluate(() => window.__receiptProbe.releaseSse());
      await see(source, rows, `${label} reached writer`);
      await source.waitForSelector(enabled(undo ? 'Redo' : 'Undo'));
      await delay(900);
      const trace = await source.evaluate(() => {
        const { click, frames, release } = window.__splitRows;
        window.__splitRows.click = null;
        if (click === null || release === null) throw Error('missing trusted history click or ACK');
        return { frames, release };
      });
      traces.push({ label, ...trace });
      const step = { label, ...assess(trace, undo ? halves : whole, rows) };
      report.steps.push(step);
      assert(step.heldFrames >= 2 && step.afterFrames >= 2, 'must sample rendered frames on both sides of ACK');
      assert.deepEqual(await read(), expectedFile, `${label} retained exact server state`);
      await see(peer, rows, `${label} retained by peer`);
      if (index < 2) {
        const cold = await open('reopened');
        await see(cold, rows, `reopened after ${label}`);
        await cold.browserContext().close();
      }
    }
    await gate.close();
    assert(report.steps.every(step => !step.invalidFrames), 'transient or duplicate timeline geometry');
    assert(report.steps.every(step => step.correctAtEnd), 'target must persist through the final rendered frame');
    assert(report.steps.every((step, index) => (immediate && index === 0) || step.correctBeforeAck),
      'acknowledged split must restore the complete target before the history ACK');
  } finally {
    try { await browser?.close(); } finally {
      try { await mcp?.close(); } finally {
        if (id) {
          assert((await fetch(`${projects}/${id}/trash`, { method: 'POST' })).ok, `trash fixture ${id}`);
          assert((await fetch(`${projects}/${id}`, { method: 'DELETE' })).ok, `delete fixture ${id}`);
        }
      }
    }
  }
}

const modes = process.argv.length > 2 ? process.argv.slice(2) : ['settled', 'immediate'];
assert(modes.every(mode => ['settled', 'immediate'].includes(mode)));
for (const mode of modes) {
  const report = { origin, mode, steps: [] }, traces = [];
  try { await run(mode, report, traces); }
  catch (error) { report.failure = error.stack; process.exitCode = 1; }
  console.log(JSON.stringify(report));
  if (process.env.EVIDENCE_DIR) {
    await mkdir(process.env.EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.EVIDENCE_DIR, `split-undo-${mode}.json`), JSON.stringify({ ...report, traces }, null, 2));
  }
}
