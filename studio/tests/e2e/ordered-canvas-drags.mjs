// STUDIO_URL=http://127.0.0.1:54074 node studio/tests/e2e/ordered-canvas-drags.mjs
// Requires a dev-auth API, an isolated preview origin, and the welcome template.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchStudioChrome } from "./chrome-executable.mjs";

assert(process.env.STUDIO_URL, "Set STUDIO_URL to the test API origin");
const origin = new URL(process.env.STUDIO_URL).origin;
const projects = origin + "/motion-api/projects";
const evidence = process.env.EVIDENCE_DIR;
const count = 100;
const preview = 'iframe[title="Composition preview"]:not([tabindex="-1"])';
const { browser } = await launchStudioChrome();

async function until(read, matches, label) {
  const deadline = Date.now() + 15000;
  let result;
  do {
    result = await read();
    if (matches(result)) return result;
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(label + ": " + JSON.stringify(result));
}

async function openEditor(url) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1650, height: 950 });
  await page.evaluateOnNewDocument(() => {
    if (window.top === window.self) localStorage.setItem("motion.studio.locale", "en");
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-studio-timeline]");
  const iframe = await page.waitForSelector(preview);
  const frame = await iframe.contentFrame();
  await frame.waitForSelector("#editor-picture");
  assert.notEqual(new URL(frame.url()).origin, origin, "Expected an isolated preview");
  await page.waitForSelector(".motion-editor-asset-loading", { hidden: true });
  return page;
}

// Measure the image in its own document, then convert to screen pixels.
async function geometry(page, inFile = false) {
  const iframe = await page.$(preview);
  const frame = await iframe.contentFrame();
  const box = await iframe.boundingBox();
  const [x, y, w, h, vw, vh] = await frame.$eval("#editor-picture", node => {
    const r = node.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height, innerWidth, innerHeight];
  });
  if (inFile) return [x, y, w, h];
  return [box.x + x * box.width / vw, box.y + y * box.height / vh, w * box.width / vw, h * box.height / vh];
}
const aligned = (actual, expected) => actual.every((v, i) => Math.abs(v - expected[i]) <= 1);

async function selectImage(page) {
  await until(async () => {
    const [x, y, w, h] = await geometry(page);
    await page.mouse.click(x + w * .56, y + h * .49);
    return page.url();
  }, href => href.includes("selId=editor-picture"), "Could not select the artwork");
  await page.waitForSelector("[data-resize-corner]");
}

async function checkOutline(page, expected) {
  await until(() => page.$eval("[data-resize-corner]", node => {
    const r = node.parentElement.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height];
  }), actual => aligned(actual, expected), "Selection outline does not match the artwork");
}

let projectId;
try {
  const response = await fetch(projects, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "E2E ordered canvas drags", projectType: "template",
      templateId: "openmotion-welcome", selectActive: false, requestId: crypto.randomUUID() }),
  });
  assert(response.ok, "Could not create test project: HTTP " + response.status);
  projectId = (await response.json()).projectId;
  assert(projectId, "Missing new project ID");
  const url = origin + "/editor/" + projectId + "?project=" + projectId + "#project/" + projectId + "?v=1&t=26.367&tab=design&rc=0";
  const [writer, peer] = await Promise.all([openEditor(url), openEditor(url)]);
  await Promise.all([selectImage(writer), selectImage(peer)]);
  const [sender, receiver] = await Promise.all([writer.createCDPSession(), peer.createCDPSession()]);
  const receipts = [], broadcasts = [];
  let held;
  await receiver.send("Network.enable");
  receiver.on("Network.eventSourceMessageReceived", event => {
    if (event.eventName === "file-change") {
      const batch = JSON.parse(event.data).ordered;
      if (batch) broadcasts.push(batch.steps.map(step => step.id));
    }
  });
  // Pause the first response after acceptance, leaving input and the peer's SSE connection live.
  const endpoint = "/api/projects/" + projectId + "/text-edits/batch";
  const dropResponse = process.argv.includes('--lose-first-response');
  const attempts = [];
  await sender.send("Fetch.enable", { patterns: [{ urlPattern: "*" + endpoint, requestStage: "Response" }] });
  sender.on("Fetch.requestPaused", event => {
    if (dropResponse) attempts.push(JSON.parse(event.request.postData).operations.map(op => op.id));
    if (!held) held = event.requestId;
    else void sender.send("Fetch.continueRequest", { requestId: event.requestId });
  });
  writer.on("response", async reply => {
    if (new URL(reply.url()).pathname === endpoint && reply.ok()) {
      receipts.push((await reply.json()).committed.map(step => step.id));
    }
  });

  const fileReads = [];
  for (const page of [writer, peer]) {
    page.on("request", req => {
      const path = new URL(req.url()).pathname;
      if (req.method() === "GET" && path.startsWith("/api/projects/" + projectId + "/files/")) fileReads.push(path);
    });
  }
  const initial = await geometry(writer);
  let x = initial[0] + initial[2] * .56, y = initial[1] + initial[3] * .49;
  await writer.mouse.move(x, y);
  // Reproduce Chromium dropping capture with the button held independently of frame scheduling.
  await writer.evaluate(() => {
    const canvas = document.querySelector('[aria-label="Composition canvas"]');
    canvas.addEventListener("gotpointercapture", event => canvas.releasePointerCapture(event.pointerId), { once: true });
  });
  const start = Date.now();
  for (let i = 0; i < count; i++) {
    await writer.mouse.down();
    // Reverse each move. A distinct final offset makes dropping gestures observable.
    x += i === count - 1 ? -8 : i % 2 ? -22 : 22;
    y += i % 2 ? -3 : 3;
    await writer.mouse.move(x, y);
    await writer.mouse.up();
  }
  const gestureMs = Date.now() - start;
  const expected = [initial[0] + 14, ...initial.slice(1)];
  await until(() => held, Boolean, "Did not intercept an edit batch");
  await until(() => geometry(writer), actual => aligned(actual, expected), "Local feedback before first ACK");
  await checkOutline(writer, expected);
  const pendingInFile = await geometry(writer, true);
  assert.equal(receipts.length, 0);
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writer.screenshot({ path: join(evidence, "canvas-before-first-ack.png") });
  }
  if (dropResponse) await sender.send("Fetch.failRequest", { requestId: held, errorReason: "ConnectionReset" });
  else await sender.send("Fetch.continueRequest", { requestId: held });
  await until(() => receipts.flat().length, n => n >= count, "Missing accepted edits");
  await until(() => broadcasts.flat().length, n => n >= count, "Missing peer edit events");
  assert.equal(receipts.flat().length, count);
  assert.equal(new Set(receipts.flat()).size, count, "Duplicate or missing operation IDs");
  assert.deepEqual(broadcasts, receipts, "One ordered SSE group per accepted batch");
  if (dropResponse) assert.deepEqual(attempts[1], attempts[0], 'Retry after ambiguous acceptance must reuse the original operation IDs');
  assert(receipts.length < count, "Each gesture sent a separate request");
  const cold = await openEditor(url);
  for (const [name, page] of Object.entries({ writer, peer, cold })) {
    await until(() => geometry(page, true), actual => aligned(actual, pendingInFile), name + " saved geometry");
  }
  await checkOutline(peer, await geometry(peer));
  assert.deepEqual(fileReads, [], "Warm editor should apply the received patches without fetching project files");
  const metrics = { gestures: count, gestureMs, editsPerRequest: receipts.map(batch => batch.length), peerEvents: broadcasts.length, lostFirstResponse: dropResponse };
  if (evidence) {
    await peer.screenshot({ path: join(evidence, "canvas-peer.png") });
    await writeFile(join(evidence, "metrics.json"), JSON.stringify(metrics, null, 2));
  }
  console.log(metrics);
} finally {
  await browser.close();
  if (projectId) {
    const trash = await fetch(projects + "/" + projectId + "/trash", { method: "POST" });
    if (!trash.ok) console.error("Could not trash the disposable project", projectId, trash.status);
    else {
      const deleted = await fetch(projects + "/" + projectId, { method: "DELETE" });
      if (!deleted.ok) console.error("Could not remove the trashed project", projectId, deleted.status);
    }
  }
}
