// STUDIO_URL=http://127.0.0.1:55701 node studio/tests/e2e/cloud-history-conflicts.mjs [case ...]
// Requires dev-auth, the Welcome template, isolated preview and HTTP MCP. EVIDENCE_DIR is optional.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stampHfIdsInPlace } from '@hyperframes/parsers/hf-ids';
import { launchStudioChrome } from './chrome-executable.mjs';
import { drag, inputPoint, liveFrame, openEditor, openMcp, until } from './preview-receipt-harness.mjs';

const origin = new URL(process.env.STUDIO_URL).origin;
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'requires loopback dev-auth');
const projects = origin + '/motion-api/projects';
const cases = ['undo', 'redo', 'redo-branch', 'undo-late-ack', 'canvas-undo'];
const clip = '.timeline-clip[data-el-id$="welcome-soundtrack"]';
const audio = /<audio\b(?=[^>]*\bid="welcome-soundtrack")[^>]*>/g;
const startAttr = /\bdata-start="([^"]+)"/;
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) < .02;
const button = label => `button[aria-label="${label}"]:not(:disabled)`;
const cursor = ({ currentVersionId, revision }) => ({ currentVersionId, revision });

// Also bound the Node-side HTTP calls made inside the shared MCP helper.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => nativeFetch(input, { ...init,
  signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(init.signal ? [init.signal] : [])]),
});

async function json(url, method = 'GET', body) {
  const response = await fetch(url, { method, ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  assert(response.ok, `${method} ${url}: HTTP ${response.status}`);
  return response.json();
}

function sourceStart(snapshot) {
  const matches = snapshot.file.content.match(audio);
  assert.equal(matches?.length, 1, 'expected one Welcome soundtrack');
  const value = matches[0].match(startAttr);
  assert(value, 'expected an explicit soundtrack start time');
  return Number(value[1]);
}

async function readClip(page) {
  return page.evaluate(selector => {
    const node = document.querySelector(selector);
    return node?.checkVisibility() ? Number(node.dataset.clipStart) : null;
  }, clip);
}

async function moveClip(page, dx) {
  const { x, y } = await page.$eval(clip, node => {
    const r = node.getBoundingClientRect(), v = node.closest('[data-timeline-scroll-viewport]').getBoundingClientRect();
    const x = (Math.max(r.left, v.left) + Math.min(r.right, v.right)) / 2, y = r.top + r.height / 2;
    if (!node.contains(document.elementFromPoint(x, y))) throw Error('drag must hit soundtrack');
    return { x, y };
  });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 10 });
  await page.waitForSelector('[data-testid="timeline-drag-landing"]', { timeout: 3_000 });
  await page.mouse.up();
}

async function saveGesture(page, gesture) {
  await page.bringToFront();
  const [ack] = await Promise.all([page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname.endsWith('/text-edits/batch'), { timeout: 15_000 }), gesture()]);
  const batch = await ack.json();
  assert.equal(ack.status(), 200);
  assert(!batch.failed && batch.committed.length === 1, JSON.stringify(batch));
  return batch.committed[0].id;
}

const timeline = {
  path: 'index.html', read: readClip, matches: near,
  agentValue: () => 3.875,
  agentContent: (html, value) => html.replace(audio, tag => tag.replace(startAttr, `data-start="${value}"`)),
  move: async (page, before, next) => {
    const id = await saveGesture(page, () => moveClip(page, next ? 115 : 60));
    const value = await until(() => readClip(page), v => v > before + .05, 'drag advanced soundtrack');
    return { id, value };
  },
  checkSaved: (snapshot, value) => assert(near(sourceStart(snapshot), value), 'saved timing matches timeline'),
};

async function canvasRect(page) {
  try {
    const frame = await liveFrame(page);
    if (!frame) return null;
    return await frame.evaluate(() => {
      const node = document.getElementById('reel-canvas');
      if (!node?.checkVisibility()) return null;
      const { x, y, width, height } = node.getBoundingClientRect();
      return [x, y, width, height];
    });
  } catch (error) {
    if (/context|detached|navigat/i.test(String(error))) return null;
    throw error;
  }
}

const canvas = {
  path: 'compositions/reel.html', read: canvasRect,
  matches: (actual, expected) => actual?.length === 4 && expected?.length === 4 && actual.every((n, i) => Math.abs(n - expected[i]) <= 2),
  agentValue: ([x, y, w, h]) => [x + 128, y + 72, w, h],
  agentContent: html => {
    const target = /<canvas\b(?=[^>]*\bid="reel-canvas")[^>]*>/g;
    assert.equal(html.match(target)?.length, 1);
    return html.replace(target, tag => tag.replace(/\sstyle="[^"]*"/, '').replace(/>$/, ' style="left:128px; top:72px;">'));
  },
  move: async (page, before, next) => {
    const point = await inputPoint(page, 'reel-canvas');
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => location.href.includes('selId=reel-canvas') && document.querySelector('[data-resize-corner]'), { timeout: 8000 });
    const dx = next ? -16 : 18, dy = next ? -9 : 6;
    const value = [before[0] + dx / point.scaleX, before[1] + dy / point.scaleY, ...before.slice(2)];
    const id = await saveGesture(page, () => drag(page, point, dx, dy));
    return { id, value };
  },
};

async function clickStep(page, label) {
  await page.bringToFront();
  await page.waitForSelector(button(label), { timeout: 10_000 });
  await page.click(button(label));
}

// Pause one real network exchange. Disable the interception after release so any
// accidental follow-up attempt reaches the server and is observable in the trace.
async function gateStep(page, route, stage) {
  const session = await page.createCDPSession();
  let paused;
  session.on('Fetch.requestPaused', event => { paused = event; });
  await session.send('Fetch.enable', { patterns: [{ urlPattern: route, requestStage: stage }] });
  return {
    wait: () => until(() => paused, Boolean, `guarded POST never paused at ${stage}`, 10_000),
    async release() {
      await session.send('Fetch.continueRequest', { requestId: paused.requestId });
      await session.send('Fetch.disable');
      await session.detach();
    },
  };
}

function watchSteps(page, base, log) {
  const rows = new Map();
  page.on('request', request => {
    if (request.method() !== 'POST' || !request.url().startsWith(base + '/history/')) return;
    const row = { path: request.url().slice(base.length), sent: Date.now() };
    rows.set(request, row);
    log.push(row);
  });
  page.on('response', response => {
    const row = rows.get(response.request());
    if (row) Object.assign(row, { status: response.status(), received: Date.now() });
  });
}

async function run(mode, report) {
  const redo = mode.startsWith('redo'), aba = mode === 'redo-branch', accepted = mode === 'undo-late-ack';
  const subject = mode === 'canvas-undo' ? canvas : timeline;
  const see = (page, expected, label) => until(() => subject.read(page), value => subject.matches(value, expected), label, 15_000);
  let browser, mcp, id;
  try {
    ({ browser } = await launchStudioChrome());
    const created = await json(projects, 'POST', { requestId: crypto.randomUUID(), title: `E2E cloud history ${mode}`,
      projectType: 'template', templateId: 'openmotion-welcome', selectActive: false });
    id = created.projectId;
    assert.match(id, /^[\da-f-]{36}$/i);
    report.projectId = id;
    const base = `${origin}/api/projects/${id}`, route = base + '/history/step-guarded';
    const history = () => json(base + '/history');
    const open = name => openEditor(browser, origin, id, 16.5, name, []);
    mcp = await openMcp(origin, id);
    const read = () => mcp.read(subject.path);
    const [source, peer] = await Promise.all([open('source'), open('peer')]);
    const original = await read();
    const initial = report.initial = await until(() => subject.read(source), value => value != null, 'fixture visible');
    subject.checkSaved?.(original, initial);
    await source.bringToFront();
    const { id: firstEdit, value: first } = await subject.move(source, initial, false);
    Object.assign(report, { firstEdit, first });
    const moved = await read();
    assert.notEqual(original.file.fileVersion, moved.file.fileVersion, 'first drag changed the saved file');
    subject.checkSaved?.(moved, first);
    await see(source, first, 'writer rendered first drag');
    await see(peer, first, 'peer received first drag');
    if (redo) {
      await clickStep(source, 'Undo');
      await see(peer, initial, 'peer received setup undo');
      await see(source, initial, 'writer received setup undo');
    }

    const before = await history(), direction = redo ? 'forward' : 'back';
    const target = before[direction];
    assert(target?.targetVersionId && target.targetRevision, 'expected a known history destination');
    const stage = accepted ? 'Response' : 'Request';
    watchSteps(source, base, report.steps);
    const gate = await gateStep(source, route, stage);
    if (!accepted) await source.evaluate(() => { window.__receiptProbe.holdSse = true; });
    report.clickAt = Date.now();
    await clickStep(source, redo ? 'Redo' : 'Undo');
    const paused = await gate.wait();
    report.held = { at: Date.now(), stage, httpStatus: paused.responseStatusCode, body: JSON.parse(paused.request.postData) };
    assert.equal(paused.request.method, 'POST');
    assert.deepEqual(report.held.body, { direction, expectedVersionId: before.currentVersionId, expectedRevision: before.revision,
      expectedTargetVersionId: target.targetVersionId, expectedTargetRevision: target.targetRevision });

    const baseFile = await read();
    if (accepted) {
      assert.equal(paused.responseStatusCode, 200);
      assert.deepEqual(cursor(baseFile), cursor(original), 'step was accepted before agent edit');
      await see(peer, initial, 'peer saw accepted undo before writer ACK');
    } else assert.deepEqual(cursor(baseFile), cursor(before), 'step reached server before MCP edit');
    const agentStart = subject.agentValue(initial);
    assert(!subject.matches(agentStart, first) && !subject.matches(agentStart, initial));
    const content = subject.agentContent(baseFile.file.content, agentStart);
    const edited = await mcp.writeFile(baseFile, content);
    assert.deepEqual(edited.changedFiles, [subject.path]);
    const agent = await read();
    assert.equal(agent.file.content, stampHfIdsInPlace(content), 'MCP wrote the expected edited file');
    report.agent = { at: Date.now(), value: agentStart, ...cursor(agent) };
    await see(peer, agentStart, 'peer saw MCP edit to the same clip');

    let expected = agent;
    if (aba) {
      await clickStep(peer, 'Undo');
      await see(peer, initial, 'peer undid its new branch');
      expected = await read();
      assert.deepEqual(cursor(expected), cursor(before), 'same starting version and revision required for ABA');
      const branch = await history();
      assert.equal(branch.forward.targetVersionId, agent.currentVersionId);
      assert.notEqual(branch.forward.targetVersionId, target.targetVersionId);
      report.replacementRedo = branch.forward.targetVersionId;
    }
    const expectedStart = aba ? initial : agentStart;
    if (accepted) {
      await source.bringToFront();
      // Require the newer SSE to converge even if the old response stalls. Keep
      // collecting the post-ACK trace and durability evidence on a pre-ACK miss.
      report.writerAgentEvent = await until(() => source.evaluate(revision => window.__receiptProbe.events.find(
        row => row.type === 'file-change' && row.revision === revision && row.delivered), agent.revision),
      Boolean, 'writer must receive the agent revision before the old ACK', 10_000);
      await source.evaluate(selector => {
        const sample = () => {
          const node = document.querySelector(selector);
          window.__clipSamples.push({ at: Date.now(), value: node?.checkVisibility() ? Number(node.dataset.clipStart) : null });
          window.__clipRaf = requestAnimationFrame(sample);
        };
        window.__clipSamples = []; sample();
      }, clip);
      await until(() => readClip(source), value => near(value, agentStart), 'writer converged while ACK held', 5_000)
        .catch(error => { report.preAckFailure = error.message; });
      report.writerBeforeAck = await readClip(source);
    } else await source.bringToFront();

    report.releaseAt = Date.now();
    const [response] = await Promise.all([source.waitForResponse(r => r.url() === route, { timeout: 10_000 }), gate.release()]);
    const body = await response.json();
    if (accepted) {
      assert.equal(response.status(), 200);
      assert.equal(body.versionId, target.targetVersionId);
      assert.equal(body.revision, target.targetRevision);
    } else {
      report.conflict = body;
      assert.equal(response.status(), 409);
      assert.equal(body.code, 'VERSION_CONFLICT');
      assert.equal(body.applied, false);
      const text = `Content has changed. This step cannot be ${redo ? 'redone' : 'undone'}.`;
      await source.waitForFunction(text => document.body.innerText.includes(text), { timeout: 8_000 }, text);
      report.feedback = text;
      await source.evaluate(() => window.__receiptProbe.releaseSse());
    }

    // Reopen before the next gesture so it cannot mask damage caused by a retry.
    await see(source, expectedStart, 'writer converged after ACK');
    const cold = await open('reopened');
    report.after = {};
    for (const [name, page] of Object.entries({ source, peer, cold })) {
      report.after[name] = await see(page, expectedStart, `${name} after step`);
    }
    const durable = await read();
    assert.deepEqual(cursor(durable), cursor(expected));
    assert.equal(durable.file.content, expected.file.content);
    if (aba) assert.equal((await history()).forward.targetVersionId, agent.currentVersionId);
    report.durable = cursor(durable);
    if (accepted) {
      const samples = await source.evaluate(() => { cancelAnimationFrame(window.__clipRaf); return window.__clipSamples; });
      const at = samples.findIndex(row => near(row.value, agentStart));
      const frames = rows => ({ count: rows.length, values: [...new Set(rows.map(row => row.value))] });
      report.postAgentFrames = { firstAgentFrame: at, beforeAck: frames(samples.filter(row => row.at < report.releaseAt)),
        afterAck: frames(samples.filter(row => row.at >= report.releaseAt)) };
      assert(at >= 0 && samples.length - at >= 2 && samples.slice(at).every(row => near(row.value, agentStart)),
        'writer must retain the newer timeline on every subsequent frame');
    }

    await source.bringToFront();
    const nextTraffic = new Map();
    const consoleErrors = [];
    source.on('pageerror', error => consoleErrors.push(error.message));
    source.on('console', line => { if (['warn', 'error'].includes(line.type())) consoleErrors.push(line.text()); });
    await source.evaluate(() => {
      const messages = window.__nextToasts = new Set();
      new MutationObserver(() => document.querySelectorAll('[data-toast-tone]').forEach(node => messages.add(node.innerText)))
        .observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    source.on('request', request => {
      if (request.url().startsWith(base + '/')) nextTraffic.set(request, { method: request.method(), path: new URL(request.url()).pathname.slice(new URL(base).pathname.length), at: Date.now() });
    });
    source.on('response', response => {
      const row = nextTraffic.get(response.request());
      if (row) row.status = response.status();
    });
    const { id: nextEdit, value: nextStart } = await subject.move(source, expectedStart, true).catch(async error => {
      report.nextFailure = { traffic: [...nextTraffic.values()], visible: await subject.read(source), consoleErrors,
        messages: await source.evaluate(() => [...window.__nextToasts]) };
      if (subject === timeline) {
        const fileId = snapshot => snapshot.file.content.match(audio)?.[0].match(/data-hf-id="([^"]+)"/)?.[1] ?? null;
        report.nextFailure.soundtrackIds = { firstDrag: fileId(moved), durable: fileId(durable) };
        for (const [name, page] of Object.entries({ source, peer, cold })) {
          report.nextFailure.soundtrackIds[name] = await (await liveFrame(page)).evaluate(() =>
            document.getElementById('welcome-soundtrack')?.getAttribute('data-hf-id') ?? null);
        }
      }
      throw error;
    });
    report.nextEdit = nextEdit;
    const next = await read();
    subject.checkSaved?.(next, nextStart);
    assert.notEqual(next.file.fileVersion, durable.file.fileVersion, 'next drag persisted in the original editor');
    assert.notEqual(next.currentVersionId, durable.currentVersionId);
    report.next = { value: nextStart, ...cursor(next) };
    for (const [name, page] of Object.entries({ source, peer, cold })) await see(page, nextStart, `${name} after next edit`);
    assert.deepEqual(report.steps.map(({ path, status }) => [path, status]), [['/history/step-guarded', accepted ? 200 : 409]], 'one click must issue exactly one history mutation');
    assert(!report.preAckFailure, report.preAckFailure);
  } finally {
    try { await browser?.close(); }
    finally {
      try { await mcp?.close(); }
      finally {
        if (id) {
          assert((await fetch(`${projects}/${id}/trash`, { method: 'POST' })).ok, `trash disposable project ${id}`);
          assert((await fetch(`${projects}/${id}`, { method: 'DELETE' })).ok, `delete disposable project ${id}`);
          report.cleaned = true;
        }
      }
    }
  }
}

const selected = process.argv.length > 2 ? process.argv.slice(2) : cases;
assert(selected.every(mode => cases.includes(mode)), `expected ${cases.join('|')}`);
const directory = process.env.EVIDENCE_DIR;
if (directory) await mkdir(directory, { recursive: true });
for (const mode of selected) {
  const report = { mode, origin, steps: [] };
  try { await run(mode, report); }
  catch (error) { report.failure = error.stack; process.exitCode = 1; }
  console.log(JSON.stringify(report));
  if (directory) await writeFile(join(directory, `cloud-history-${mode}.json`), JSON.stringify(report, null, 2) + '\n');
}
