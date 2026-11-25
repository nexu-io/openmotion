#!/usr/bin/env node
// STUDIO_URL=http://127.0.0.1:55671 EVIDENCE_DIR=/path/to/results node studio/tests/e2e/preview-receipt-ownership.mjs
// Local Dev Auth stack with isolated preview, Welcome template and ordered text edits. No existing project ID accepted.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchStudioChrome } from './chrome-executable.mjs';
import { drag, inputPoint, liveFrame, mountedVersion, mountProbe, openEditor, openMcp, seek, state, until } from './preview-receipt-harness.mjs';

const endpoint = new URL(process.env.STUDIO_URL);
assert(['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname), 'use a loopback Dev Auth stack');
const projects = endpoint.origin + '/motion-api/projects';
const editorTime = 26.367, reelTime = 14, file = 'compositions/editor.html', caption = 'Receipt verified';
const near = (a, b, margin = 2) => Number.isFinite(a) && Math.abs(a - b) <= margin;
const aligned = (a, b) => a && b && b.every((v, i) => near(a[i], v));
const matchesEditor = (s, expected) => aligned(s.image, expected.image) && aligned(s.title, expected.title) &&
  s.text === expected.text && near(s.time, editorTime, .05);
const evidence = process.env.EVIDENCE_DIR;
if (evidence) await mkdir(evidence, { recursive: true });

async function json(url, init) {
  const response = await fetch(url, init);
  assert(response.ok, `${new URL(url).pathname}: HTTP ${response.status}`);
  return response.json();
}
const batches = page => page.evaluate(() => window.__receiptProbe.batches.map(({ release, ...batch }) => batch));
const events = page => page.evaluate(() => window.__receiptProbe.events);

// A poll that eventually passes cannot catch a one-frame flash back to an older receipt.
async function guardWriterFrames(page, expected) {
  const frame = await liveFrame(page);
  await frame.evaluate(({ expected, editorTime }) => {
    const probe = window.__receiptPaints = { samples: 0, firstMismatch: null };
    function paint() {
      const read = id => {
        const r = document.getElementById(id)?.getBoundingClientRect();
        return r && [r.x, r.y, r.width, r.height];
      };
      const image = read('editor-picture'), title = read('editor-name');
      const text = document.getElementById('editor-caption')?.textContent, time = window.__player?.getTime?.();
      const same = (a, b) => a && b.every((v, i) => Math.abs(a[i] - v) <= 2);
      if (!same(image, expected.image) || !same(title, expected.title) || text !== expected.text || !(Math.abs(time - editorTime) < .05))
        probe.firstMismatch ??= { at: Date.now(), image, title, text, time };
      probe.samples++;
      probe.next = requestAnimationFrame(paint);
    }
    paint();
  }, { expected, editorTime });
  return () => frame.evaluate(() => { const { samples, firstMismatch, next } = window.__receiptPaints; cancelAnimationFrame(next); return { samples, firstMismatch }; });
}

async function checkHistory(id, receipts, agent, mcp, before) {
  const { versions } = await json(`${projects}/${id}/versions`);
  assert.equal(receipts.length, 4, 'one receipt for each completed local gesture');
  assert.equal(new Set(receipts.map(r => r.id)).size, 4, 'operation IDs must be unique');
  const all = [receipts[0], { ...agent, versionId: agent.version.versionId }, ...receipts.slice(1)];
  const numbers = all.map(r => {
    const v = versions.find(v => v.versionId === r.versionId);
    assert(v && v.revision === r.revision, `missing persisted revision ${r.revision}`);
    return v.versionNumber;
  });
  assert.deepEqual(numbers, numbers.map((_, i) => numbers[0] + i), 'four local gestures and one disjoint agent version in acceptance order');
  const tag = (source, id) => source.match(new RegExp(`<[^<>]*\\bid="${id}"[^<>]*>`))?.[0];
  const history = [before];
  for (const r of receipts) {
    assert.deepEqual(r.changedPaths, [file]);
    const saved = (await mcp.read(file, r.versionId)).file;
    assert.equal(saved.fileVersion, r.versions[file]);
    history.push(saved.content);
  }
  assert.notEqual(tag(history[1], 'editor-picture'), tag(history[0], 'editor-picture'), 'move saved');
  assert.notEqual(tag(history[2], 'editor-picture'), tag(history[1], 'editor-picture'), 'resize saved separately');
  assert.notEqual(tag(history[3], 'editor-name'), tag(history[2], 'editor-name'), 'title move saved separately');
  assert(!history[3].includes(caption) && history[4].includes(caption), 'caption saved in its own version');
  return numbers;
}

async function run(order) {
  const report = { order, network: [], samples: [], mounts: {} };
  let id, browser, writer, observer, mcp, afterInitial, mounts;
  try {
    ({ browser } = await launchStudioChrome());
    ({ projectId: id } = await json(projects, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `E2E receipt ownership (${order})`, projectType: 'template', templateId: 'openmotion-welcome',
        selectActive: false, requestId: crypto.randomUUID() }) }));
    assert(id, 'missing new project ID');
    mcp = await openMcp(endpoint.origin, id);
    const baseline = (await mcp.read(file)).file.content;
    const open = (time, name) => openEditor(browser, endpoint.origin, id, time, name, report.network);
    [writer, observer] = await Promise.all([open(editorTime, 'writer'), open(editorTime, 'observer')]);
    mounts = { writer: await mountProbe(writer), observer: await mountProbe(observer) };
    const sample = async (page, label, check) => {
      const value = await until(() => state(page), check, label);
      report.samples.push({ label, at: Date.now(), ...value });
      return value;
    };
    const initial = await sample(writer, 'writer initial', s => s.image?.[2] > 0 && s.title?.[2] > 0);
    await sample(observer, 'observer initial', s => matchesEditor(s, initial));
    await writer.bringToFront();
    const art = await inputPoint(writer, 'editor-picture');
    await writer.mouse.click(art.x, art.y);
    await writer.waitForFunction(() => location.href.includes('selId=editor-picture') && document.querySelector('[data-resize-corner="se"]'));
    const cornerGeometry = async () => {
      const handle = await writer.$eval('[data-resize-corner="se"]', el => {
        const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      const center = await inputPoint(writer, 'editor-picture');
      const {image} = await state(writer);
      return { handle, dx: handle.x - (center.x + image[2] * center.scaleX / 2), dy: handle.y - (center.y + image[3] * center.scaleY / 2) };
    };
    report.cornerBefore = await cornerGeometry();
    afterInitial = report.network.length;
    assert(['writer', 'observer'].every(name => report.network.some(r => r.name === name && !r.sceneFile && r.type === 'document')),
      'positive control: both initial preview document requests must be observable');
    if (order === 'ack-first') await writer.evaluate(() => { window.__receiptProbe.holdSse = true; });

    report.firstGestureAt = Date.now();
    await drag(writer, art, 16, -8);
    const first = (await until(() => batches(writer), rows => rows.length > 0, 'first accepted batch'))[0];
    assert.equal(first.status, 200);
    assert.equal(first.committed?.length, 1, JSON.stringify(first));
    const id1 = first.committed[0].id;
    const moved = initial.image.map((v, i) => v + [16 / art.scaleX, -8 / art.scaleY, 0, 0][i]);
    await sample(writer, 'writer moved, ACK held', s => aligned(s.image, moved));
    await sample(observer, 'observer first correct move frame, ACK held', s => aligned(s.image, moved));
    const firstSse = (await until(() => events(writer), ev => ev.some(e => e.steps?.includes(id1)), 'writer first SSE')).find(e => e.steps?.includes(id1));
    assert.equal(Boolean(firstSse.delivered), order === 'sse-first', 'writer SSE delivery order');

    // Drive the real SE handle. Wait for the selection outline to catch up to the moved image first.
    report.cornerAfter = await until(cornerGeometry, p => near(p.dx, report.cornerBefore.dx) && near(p.dy, report.cornerBefore.dy), 'moved resize handle');
    const { handle } = report.cornerAfter;
    await drag(writer, handle, -28, -18);
    const resized = await sample(writer, 'writer resized, ACK held', s => s.image && near(s.image[0], moved[0]) && near(s.image[1], moved[1]) &&
      s.image[2] < moved[2] - 12 && s.image[3] < moved[3] - 8);

    const title = await inputPoint(writer, 'editor-name');
    await drag(writer, title, 18, 5);
    const movedTitle = initial.title.map((v, i) => v + [18 / title.scaleX, 5 / title.scaleY, 0, 0][i]);
    await sample(writer, 'writer title moved, ACK held', s => aligned(s.title, movedTitle) && aligned(s.image, resized.image));
    const text = await inputPoint(writer, 'editor-caption');
    await writer.mouse.click(text.x, text.y, { count: 2 });
    const frame = await liveFrame(writer);
    await frame.waitForSelector('#editor-caption[contenteditable="true"]');
    // Deterministically select the full multi-line caption inside the actual editing session.
    await frame.$eval('#editor-caption', el => { const r = document.createRange(); r.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(r); });
    await writer.keyboard.type(caption);
    await writer.keyboard.press('Enter');
    const final = { image: resized.image, title: movedTitle, text: caption };
    await sample(writer, 'writer text committed locally, ACK held', s => matchesEditor(s, final));
    const stopPaintGuard = await guardWriterFrames(writer, final);

    // The observer actually watches the disjoint clip; a correct DB read or hidden DOM node is not a correct frame.
    await seek(observer, reelTime);
    const oldReel = await sample(observer, 'observer reel before MCP', s => s.reel?.[2] > 0);
    const reel = 'compositions/reel.html', beforeReel = (await mcp.read(reel)).file.fileVersion;
    assert.equal(await mountedVersion(writer, reel), beforeReel, 'positive control: writer reports the original reel version');
    report.agentStartedAt = Date.now();
    const agent = await mcp.disjointEdit();
    report.agentAcceptedObservedAt = Date.now();
    const reelX = oldReel.reel[0] + 72;
    await sample(observer, 'observer first correct MCP frame, ACK held', s => near(s.reel?.[0], reelX) && near(s.time, reelTime, .05));
    const mcpNotice = (await until(() => events(writer), rows => rows.some(e => e.type === 'file-change' && e.revision === agent.revision), 'writer received MCP SSE'))
      .find(e => e.type === 'file-change' && e.revision === agent.revision);
    assert.equal(Boolean(mcpNotice.delivered), order === 'sse-first', 'ack-first intentionally buffers the entire ordered stream');
    const expectedReel = order === 'sse-first' ? (await mcp.read(reel, agent.version.versionId)).file.fileVersion : beforeReel;
    // Do not move the operator's playhead to inspect a parked scene during its own edit.
    // Check the isolated *player's* receipt here; actual re-entry into the reel below checks its pixels.
    report.writerParkedVersionBeforeAck = await until(() => mountedVersion(writer, reel), v => v === expectedReel,
      `writer's parked reel must report ${expectedReel} (${order})`);
    await sample(writer, 'writer after MCP, ACK held', s => matchesEditor(s, final));
    assert.equal((await batches(writer))[0].parsed, undefined);
    const selected = () => new URLSearchParams(new URL(writer.url()).hash.split('?')[1]).get('selId');
    const selection = selected();
    assert(selection, 'the operator still has a selection');
    if (evidence) await writer.screenshot({ path: join(evidence, `${order}-held.png`) });

    let received = 0;
    for (let i = 0; received < 4; i++) {
      const batch = (await until(() => batches(writer), rows => rows.length > i, `accepted batch ${i + 1}`))[i];
      assert(!batch.failed && batch.committed?.length, JSON.stringify(batch));
      await sample(writer, `writer before releasing batch ${i + 1}`, s => matchesEditor(s, final));
      await writer.evaluate(i => window.__receiptProbe.batches[i].release(), i);
      await writer.waitForFunction(i => !!window.__receiptProbe.batches[i].parsed, {}, i);
      if (i === 0 && order === 'ack-first') await writer.evaluate(() => window.__receiptProbe.releaseSse());
      await sample(writer, `writer after releasing batch ${i + 1}`, s => matchesEditor(s, final));
      received += batch.committed.length;
    }
    const allReceipts = (await batches(writer)).flatMap(b => b.committed);
    const ids = allReceipts.map(r => r.id);
    const allEvents = await until(() => events(observer), ev => ids.every(id => ev.some(e => e.steps?.includes(id))), 'observer SSE for each receipt');
    assert.deepEqual(allEvents.flatMap(e => e.steps ?? []), ids, 'observer sees each immutable operation once');
    assert(allEvents.some(e => e.type === 'file-change' && e.revision === agent.revision), 'missing disjoint MCP event');
    report.historyVersionNumbers = await checkHistory(id, allReceipts, agent, mcp, baseline);
    assert.equal(selected(), selection, 'receipt changed the selection');
    report.writerPaintGuard = await stopPaintGuard();
    assert(report.writerPaintGuard.samples > 1, 'no visible frames observed around receipt release');
    assert.equal(report.writerPaintGuard.firstMismatch, null, 'a frame regressed while releasing ACKs: ' + JSON.stringify(report.writerPaintGuard.firstMismatch));
    await seek(observer, editorTime);
    await sample(observer, 'observer persisted 4 local edits', s => matchesEditor(s, final));
    await seek(writer, reelTime);
    await sample(writer, 'writer persisted MCP edit', s => near(s.reel?.[0], reelX));
    await seek(writer, editorTime);
    await sample(writer, 'writer persisted 4 local edits', s => matchesEditor(s, final));

    // Incognito context: no writer cache, outstanding promises, acknowledged DOM or shared session storage.
    const cold = await open(editorTime, 'reopen');
    await sample(cold, 'reopened persisted 4 local edits', s => matchesEditor(s, final));
    await seek(cold, reelTime);
    await sample(cold, 'reopened persisted MCP edit', s => near(s.reel?.[0], reelX));
    for (const [name, probe] of Object.entries(mounts)) report.mounts[name] = await probe();
    for (const [name, result] of Object.entries(report.mounts))
      assert.deepEqual(result, { same: true, additions: 0, sameDocument: true }, `${name}: ordinary edits replaced a preview`);
    assert.deepEqual(report.network.slice(afterInitial).filter(r => r.name !== 'reopen' && !r.sceneFile && !r.capture), [], 'ordinary edits requested full preview HTML');
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.error = error.stack;
    if (evidence && writer) await writer.screenshot({ path: join(evidence, `${order}-failure.png`) }).catch(() => {});
    throw error;
  } finally {
    if (afterInitial != null) {
      const warm = report.network.slice(afterInitial).filter(r => r.name !== 'reopen');
      report.warmRequests = { primaryFull: warm.filter(r => !r.sceneFile && !r.capture), sceneFragments: warm.filter(r => r.sceneFile && !r.capture),
        thumbnailCapture: warm.filter(r => r.capture) };
    }
    for (const [name, probe] of Object.entries(mounts ?? {})) report.mounts[name] ??= await probe().catch(() => null);
    if (writer) report.receipts = await batches(writer).catch(() => []);
    for (const [name, page] of Object.entries({ writer, observer })) if (page) report[`${name}Events`] = await events(page).catch(() => []);
    try {
      await browser?.close();
      if (mcp) await mcp.close();
    } finally {
      if (id) {
        const trashed = await fetch(`${projects}/${id}/trash`, { method: 'POST' });
        assert(trashed.ok, `cleanup: failed to trash ${id} (${trashed.status})`);
        const deleted = await fetch(`${projects}/${id}`, { method: 'DELETE' });
        assert(deleted.ok, `cleanup: failed to delete ${id} (${deleted.status})`);
      }
      console.log(JSON.stringify(report, null, 2));
      if (evidence) await writeFile(join(evidence, `${order}.json`), JSON.stringify(report, null, 2));
    }
  }
}

const orders = ['sse-first', 'ack-first'];
const only = process.argv[2]; // Optional: repeat just one delivery order during diagnosis.
assert(!only || orders.includes(only), 'expected sse-first or ack-first');
for (const order of only ? [only] : orders) await run(order);
