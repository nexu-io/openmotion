// Run against a disposable dev-auth stack containing Welcome and an isolated preview origin.
import assert from 'node:assert/strict';
import { launchStudioChrome } from './chrome-executable.mjs';
import { inputPoint, openMcp, openEditor } from './preview-receipt-harness.mjs';
import { stampHfIdsInPlace } from '@hyperframes/parsers/hf-ids';

const origin = new URL(process.env.STUDIO_URL).origin;
const live = 'iframe[title="Composition preview"]:not([tabindex="-1"])';
async function waitForFrame(page, predicate, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const iframe = await page.$(live);
    const frame = iframe && await iframe.contentFrame();
    try { if (frame && await predicate(frame)) return frame; }
    catch (error) { if (!/context|detached|navigat/i.test(String(error))) throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(label);
}

const { browser } = await launchStudioChrome();
const projects = `${origin}/motion-api/projects`;
let id, mcp;
try {
  const created = await fetch(projects, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectType: 'template', templateId: 'openmotion-welcome', title: 'E2E preview recovery', requestId: crypto.randomUUID(), selectActive: false }) });
  assert.ok(created.ok);
  id = (await created.json()).projectId;
  assert.ok(id);
  mcp = await openMcp(origin, id);
  const open = () => openEditor(browser, origin, id, 26.367, 'recovery', []);
  const [writer, observer] = await Promise.all([open(), open()]);
  const scene = await mcp.read('compositions/editor.html');
  const name = /<span\b[^>]*\bid="editor-name"[^>]*>[^<]*<\/span>/;
  assert.match(scene.file.content, name);
  const { x, y } = await inputPoint(writer, 'editor-name');
  await writer.mouse.click(x, y);
  await writer.waitForFunction(() => location.hash.includes('selId=editor-name'));
  await writer.mouse.move(x, y);
  await writer.mouse.down();
  await writer.mouse.move(x + 12, y + 3, { steps: 3 });
  await mcp.writeFile(scene, scene.file.content.replace(name, ''));
  await observer.waitForFunction(() => document.querySelector('[data-studio-timeline]'));
  await waitForFrame(observer, frame => frame.evaluate(() => !!document.querySelector('#editor-picture') && !document.querySelector('#editor-name')), 'Observer retained deleted target');
  await writer.waitForFunction(() => !location.hash.includes('selId=editor-name'));
  await writer.mouse.up();
  await assert.rejects(mcp.writeFile(scene, scene.file.content.replace('Your story', 'Stale edit')), /conflict|mismatch|stale/i);
  const after = await mcp.read(scene.file.path);
  assert.doesNotMatch(after.file.content, name);
  await waitForFrame(writer, frame => frame.evaluate(() => !!document.querySelector('#editor-picture') && !document.querySelector('#editor-name')), 'Writer retained deleted target');

  const root = await mcp.read('index.html');
  const marker = crypto.randomUUID();
  assert.match(root.file.content, /<\/body>/i);
  const runtime = root.file.content.replace(/<\/body>/i, `<script>
    document.documentElement.dataset.recoveryProbe=${JSON.stringify(marker)};
    window.addEventListener('qa-runtime-failure', () => { throw new Error('QA runtime failure ${marker}'); }, { once: true });
  </script></body>`);
  const oldFrames = await Promise.all([writer, observer].map(async page => (await page.$(live)).contentFrame()));
  const oldTimes = await Promise.all(oldFrames.map(frame => frame.evaluate(() => window.__player.getTime())));
  await mcp.writeFile(root, runtime);
  const checkMarker = frame => frame.evaluate(value => document.documentElement.dataset.recoveryProbe === value, marker);
  for (const [i, page] of [writer, observer].entries()) {
    const current = await waitForFrame(page, checkMarker, 'Updated root runtime failed to become visible');
    assert.notEqual(current, oldFrames[i], 'Expected document replacement for root runtime edit');
    await current.waitForFunction(time => Math.abs(window.__player.getTime() - time) < .05, {}, oldTimes[i]);
  }
  const cold = await open();
  await waitForFrame(cold, checkMarker, 'Reopened project did not run the accepted root script');
  await cold.evaluate(() => {
    window.addEventListener('previewruntimeerror', event => { window.__recoveryError = event.detail.message; }, { once: true });
  });
  const coldFrame = await (await cold.$(live)).contentFrame();
  await coldFrame.evaluate(() => window.dispatchEvent(new Event('qa-runtime-failure')));
  await cold.waitForFunction(value => window.__recoveryError?.includes(value), {}, marker);
  assert.equal((await mcp.read('index.html')).file.content, stampHfIdsInPlace(runtime));
  console.log(JSON.stringify({ deletedDuringDrag: true, staleWriteRejected: true, rootRuntimeReplacedInBothWindows: true, playbackPositionRestored: true, reopened: true, runtimeErrorDeliveredToStudio: true }));
} finally {
  await browser.close();
  await mcp?.close();
  if (id) {
    const trash = await fetch(`${projects}/${id}/trash`, { method: 'POST' });
    if (trash.ok) await fetch(`${projects}/${id}`, { method: 'DELETE' });
  }
}
