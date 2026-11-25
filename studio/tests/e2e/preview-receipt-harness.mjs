// Browser-only controls: hold real deliveries after acceptance, not mocked HTTP or SSE.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { installWebMcpHost } from './webmcp-host.mjs';

const stage = '[data-testid="preview-zoom-stage"]';
const active = `${stage} iframe[title="Composition preview"]:not([tabindex="-1"])`;

export async function until(read, matches, label, timeout = 20_000) {
  const end = Date.now() + timeout;
  let last;
  do {
    last = await read();
    if (matches(last)) return last;
    await delay(40);
  } while (Date.now() < end);
  assert.fail(`${label}: last observed ${JSON.stringify(last)}`);
}

function instrument(projectId, writer) {
  if (window !== top) return;
  localStorage.setItem('motion.studio.locale', 'en');
  const state = window.__receiptProbe = { events: [], batches: [], connected: false, holdSse: false };
  const mounted = new WeakMap();
  window.addEventListener('message', e => {
    if (e.source && e.data?.source === 'openmotion-preview-bridge' && e.data.type === 'preview-ready' && e.data.projectId === projectId)
      mounted.set(e.source, { id: e.data.styleDocumentId, origin: e.origin });
  });
  state.fileVersion = (iframe, path) => {
    const view = iframe.contentWindow, src = new URL(iframe.src), doc = mounted.get(view);
    if (!doc?.id || doc.origin !== src.origin) return null;
    const requestId = crypto.randomUUID(), token = src.searchParams.get('pt');
    return new Promise(resolve => {
      const clean = () => { clearTimeout(timeout); window.removeEventListener('message', onReply); };
      const onReply = e => {
        if (e.source !== view || e.origin !== src.origin || e.data?.source !== 'openmotion-preview-bridge' || e.data.projectId !== projectId ||
          e.data.version !== 1 || e.data.type !== 'response' || e.data.token !== token || e.data.requestId !== requestId) return;
        clean(); resolve(e.data.ok ? e.data.result : null);
      };
      const timeout = setTimeout(() => { clean(); resolve(null); }, 1000);
      window.addEventListener('message', onReply);
      view.postMessage({ source: 'openmotion-studio', version: 1, type: 'mounted-file-version', documentId: doc.id,
        path, projectId, token, requestId }, src.origin);
    });
  };
  const waiting = [];
  window.EventSource = class extends EventSource {
    constructor(url, options) {
      super(url, options);
      if (new URL(url, location).pathname !== '/api/events') return;
      this.addEventListener('connected', () => { state.connected = true; });
      for (const type of ['file-change', 'history-changed']) this.addEventListener(type, event => {
        if (!event.isTrusted) return; // delayed delivery below
        const data = JSON.parse(event.data);
        const row = { type, at: Date.now(), revision: data.revision, steps: data.ordered?.steps.map(s => s.id) };
        state.events.push(row);
        if (!state.holdSse) { row.delivered = Date.now(); return; }
        event.stopImmediatePropagation();
        waiting.push(() => {
          row.delivered = Date.now();
          this.dispatchEvent(new MessageEvent(type, { data: event.data, origin: event.origin, lastEventId: event.lastEventId }));
        });
      });
    }
  };
  state.releaseSse = () => { state.holdSse = false; waiting.splice(0).forEach(deliver => deliver()); };
  if (!writer) return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (new URL(response.url).pathname !== `/api/projects/${projectId}/text-edits/batch`) return response;
    const result = await response.clone().json();
    const batch = { accepted: Date.now(), status: response.status, committed: result.committed, failed: result.failed };
    state.batches.push(batch);
    await new Promise(resolve => { batch.release = resolve; });
    const read = response.json.bind(response);
    response.json = async () => { const value = await read(); batch.parsed = Date.now(); return value; };
    return response;
  };
}

export async function openEditor(browser, origin, id, time, name, network, comp) {
  const context = await browser.createBrowserContext(), page = await context.newPage();
  await page.setViewport({ width: 1650, height: 950 });
  await page.evaluateOnNewDocument(installWebMcpHost, '__seekHost');
  await page.evaluateOnNewDocument(instrument, id, name === 'writer');
  const docPath = `/api/projects/${id}/preview`;
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() !== 'GET' || !(url.pathname === docPath || url.pathname.startsWith(docPath + '/comp/'))) return;
    // Full-document fetches (not just frame navigations) count. Scene snapshots use this same route.
    network.push({ name, at: Date.now(), path: url.pathname, sceneFile: url.searchParams.get('sceneFile'),
      capture: url.searchParams.has('capture'), type: request.resourceType() });
  });
  const composition = comp ? `&comp=${encodeURIComponent(comp)}` : '';
  await page.goto(`${origin}/editor/${id}?project=${id}#project/${id}?v=1&t=${time}&tab=design&rc=0${composition}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-studio-timeline]');
  await page.waitForFunction(() => window.__receiptProbe.connected && window.__seekHost.has('openmotion_studio_seek'));
  if (comp) await page.waitForFunction((selector, comp) => document.querySelector(selector)?.src.includes('/preview/comp/' + comp), {}, active, comp);
  const frame = await (await page.waitForSelector(active)).contentFrame();
  await frame.waitForFunction(t => Math.abs((window.__player?.getTime?.() ?? -1) - t) < .05, { timeout: 60_000 }, time);
  assert.notEqual(new URL(frame.url()).origin, origin, 'isolated preview required');
  await frame.evaluate(async () => { await document.fonts.ready; });
  await page.waitForSelector('.motion-editor-asset-loading', { hidden: true });
  return page;
}

export async function mountProbe(page) {
  const frame = await liveFrame(page);
  const identity = crypto.randomUUID();
  await frame.evaluate(id => { window.__receiptDocumentIdentity = id; }, identity);
  await page.evaluate((stage, active) => {
    const root = document.querySelector(stage), original = document.querySelector(active);
    const existing = new Set(root.querySelectorAll('iframe'));
    let additions = 0;
    const observer = new MutationObserver(records => {
      for (const record of records) for (const added of record.addedNodes) {
        if (added.nodeType !== 1) continue;
        for (const frame of [...(added.matches('iframe') ? [added] : []), ...added.querySelectorAll('iframe')]) {
          if (!existing.has(frame)) { existing.add(frame); additions++; }
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    window.__receiptProbe.mount = () => ({ same: original === document.querySelector(active), additions });
  }, stage, active);
  return async () => ({ ...(await page.evaluate(() => window.__receiptProbe.mount())),
    sameDocument: await (await liveFrame(page)).evaluate(id => window.__receiptDocumentIdentity === id, identity) });
}

export async function liveFrame(page) {
  const node = await page.waitForSelector(active);
  return node.contentFrame();
}

export function mountedVersion(page, path) {
  return page.$eval(active, (iframe, path) => window.__receiptProbe.fileVersion(iframe, path), path);
}

export async function seek(page, time) {
  const result = await page.evaluate(time => window.__seekHost.call('openmotion_studio_seek', { time }), time);
  assert.equal(result.ok, true, JSON.stringify(result));
  await (await liveFrame(page)).waitForFunction(t => Math.abs((window.__player?.getTime?.() ?? -1) - t) < .05, {}, time);
}

export async function state(page) {
  return (await liveFrame(page)).evaluate(() => {
    const box = id => {
      const r = document.getElementById(id)?.getBoundingClientRect();
      return r && [r.x, r.y, r.width, r.height];
    };
    return { image: box('editor-picture'), title: box('editor-name'), text: document.getElementById('editor-caption')?.textContent,
      reel: box('reel-canvas'), time: window.__player?.getTime?.() };
  });
}

export async function inputPoint(page, id) {
  const node = await page.$(active), frame = await node.contentFrame(), host = await node.boundingBox();
  const [x, y, w, h] = await frame.$eval('#' + id, el => {
    const r = el.getBoundingClientRect();
    return [(r.x + r.width * .5) / innerWidth, (r.y + r.height * .5) / innerHeight, innerWidth, innerHeight];
  });
  return { x: host.x + host.width * x, y: host.y + host.height * y, scaleX: host.width / w, scaleY: host.height / h };
}

export async function drag(page, { x, y }, dx, dy) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

export async function openMcp(origin, id) {
  const headers = { Authorization: `Bearer ${process.env.DEV_PAT || 'om_pat_devlocal_000000000000000000000000'}`,
    Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  let seq = 0;
  const rpc = (method, params) => fetch(origin + '/mcp', { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }) });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'preview-receipt-e2e', version: '1' }, capabilities: {} });
  assert(init.ok, `MCP initialize: HTTP ${init.status}`);
  headers['Mcp-Session-Id'] = init.headers.get('mcp-session-id');
  assert(headers['Mcp-Session-Id'], 'missing MCP session');
  const call = async (name, args) => {
    const response = await rpc('tools/call', { name, arguments: { projectId: id, ...args } });
    assert(response.ok, `${name}: HTTP ${response.status}`);
    const { result, error } = await response.json();
    assert(result && !error, `${name}: ${JSON.stringify(error)}`);
    if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  };
  const read = async (path, atProjectVersion) => {
    const current = await call('openmotion_get_project', { file: { path, length: 65536, atProjectVersion } });
    assert(!current.file.truncated, `incomplete fixture file ${path}`);
    return current;
  };
  return { read, writeFile(base, content) {
    return call('openmotion_edit_project', { requestId: crypto.randomUUID(), expectedRevision: base.revision,
      expectedVersionId: base.currentVersionId, files: [{ path: base.file.path, content }] });
  }, async disjointEdit() {
    const path = 'compositions/reel.html', source = await read(path);
    const anchor = 'id="reel-canvas"';
    assert.equal(source.file.content.split(anchor).length, 2, 'expected unique Welcome reel canvas');
    const offset = Buffer.byteLength(source.file.content.slice(0, source.file.content.indexOf(anchor) + anchor.length));
    const result = await call('openmotion_edit_project', { requestId: crypto.randomUUID(), expectedRevision: source.revision,
      expectedVersionId: source.currentVersionId, textEdits: { label: 'Move independent reel', dependencies: {},
        files: [{ path, baseVersion: source.file.fileVersion, patch: [[offset, 0, ' style="left: 72px;"']] }] } });
    assert.deepEqual(result.changedFiles, [path]);
    return result;
  }, async close() {
    const response = await fetch(origin + '/mcp', { method: 'DELETE', headers });
    assert(response.ok, `MCP disconnect: HTTP ${response.status}`);
  } };
}
