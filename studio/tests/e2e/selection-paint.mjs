import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const tolerance = 2; // viewport CSS pixels, including rasterization at fractional zoom
const round = value => Math.round(value * 10) / 10;

// Measure the native green border and an inset magenta outline on the real canvas
// in ONE composited image. The inset keeps all four canvas edges measurable even
// when the composition clips the translated artwork. CSS outlines do not affect layout.
export async function selectionPaint(page, frame, selector, mode, evidence, report) {
  await frame.addStyleTag({ content: '#reel-canvas { outline: 8px solid #fe00eb !important; outline-offset: -100px !important; }' });
  const viewport = await frame.evaluate(() => [innerWidth, innerHeight]);
  const host = await (await page.$(selector)).boundingBox();
  const scale = [host.width / viewport[0], host.height / viewport[1]];
  const screenEdges = ([x, y, w, h]) => [host.x + x * scale[0], host.y + y * scale[1],
    host.x + (x + w) * scale[0], host.y + (y + h) * scale[1]];
  const initial = screenEdges(await frame.$eval('#reel-canvas', node => {
    const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
  }));
  const cdp = await page.createCDPSession();
  const frames = [];
  const results = report.selection = { document: new URL(frame.url()).pathname, target: '#reel-canvas',
    tolerancePx: tolerance, checkpoints: {}, historyIntervals: [] };
  cdp.on('Page.screencastFrame', event => {
    frames.push({ at: event.metadata.timestamp * 1000, image: Buffer.from(event.data, 'base64') });
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });

  async function measure(image) {
    const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, page.viewport().width, 'requires native viewport pixels');
    // Scan perpendicular to each edge. A straight painted border must agree at
    // multiple interior points, so a corner handle or colored artwork cannot pass.
    function edge(index, marker) {
      const axis = index % 2, other = 1 - axis, direction = index < 2 ? 1 : -1;
      const inset = marker ? direction * 96 * scale[axis] : 0;
      const center = initial[index] + inset;
      const hits = [];
      for (let n = Math.round(center) - 50; n <= center + 50; n++) {
        let votes = 0;
        for (const fraction of [.23, .37, .51, .66, .79]) {
          const cross = Math.floor(initial[other] + fraction * (initial[other + 2] - initial[other]));
          const x = axis ? cross : n, y = axis ? n : cross;
          const k = (y * info.width + x) * info.channels;
          const r = data[k], g = data[k + 1], b = data[k + 2];
          if (marker ? r > 220 && g < 40 && b > 195 : r < 50 && g > 215 && b < 55) votes++;
        }
        if (votes >= 4) hits.push(n);
      }
      if (!hits.length || hits.at(-1) - hits[0] > 5) return null;
      return round((hits[0] + hits.at(-1) + 1) / 2 - inset);
    }
    const target = initial.map((_, i) => edge(i, true));
    const outline = initial.map((_, i) => edge(i, false));
    const offset = outline.map((value, i) => value === null || target[i] === null ? null : round(value - target[i]));
    return { target, outline, offset };
  }
  const aligned = row => row.offset.every(px => px !== null && Math.abs(px) <= tolerance);
  const near = (actual, expected) => actual.every((px, i) => px !== null && Math.abs(px - expected[i]) <= tolerance);
  const save = async (label, image) => { if (evidence) await writeFile(join(evidence, `${mode}-${label}.png`), image); };
  async function checkpoint(label, rect, shift) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const image = Buffer.from(data, 'base64'), row = await measure(image);
    results.checkpoints[label] = row;
    const correct = shift ? near(row.offset, shift) : aligned(row);
    if (!correct || !near(row.target, screenEdges(rect))) {
      await save(label, image);
      report.violations.push(`selection ${label}: ${JSON.stringify(row)}`);
    }
  }
  return {
    checkpoint,
    async controls(rect) {
      await checkpoint('first-drag', rect);
      // Deliberately move ONLY the green border, proving the pixel measurement
      // detects disagreement independently on both axes. Restore before editing.
      const style = await page.addStyleTag({ content: '[data-isolated-selection] { translate: 11px -9px !important; }' });
      try { await checkpoint('deliberate-offset', rect, [11, -9, 11, -9]); }
      finally { await style.evaluate(node => node.remove()); }
      await checkpoint('restored-control', rect);
    },
    start: () => cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }),
    async finish(click, releasedAt, expected) {
      await cdp.send('Page.stopScreencast');
      const destination = screenEdges(expected);
      let saved = false, restored = false, previousFrameMs = 0;
      for (const { at, image } of frames.filter(row => row.at >= click)) {
        const row = await measure(image);
        const ms = round(at - click), beforeAck = at < releasedAt;
        const previous = results.historyIntervals.at(-1);
        if (previous?.beforeAck === beforeAck && previous.target.every((v, i) => v === row.target[i]) &&
            previous.outline.every((v, i) => v === row.outline[i])) {
          previous.lastMs = ms;
          previous.frames++;
        } else results.historyIntervals.push({ firstMs: ms, lastMs: ms, frames: 1, beforeAck, ...row });
        if (!restored && near(row.target, destination) && beforeAck) {
          restored = true;
          results.firstRestoredTargetMs = ms;
          results.captureGapAtRestoreMs = round(ms - previousFrameMs);
          if (results.captureGapAtRestoreMs > 40) report.violations.push('compositor capture gap at history transition exceeded 40 ms');
        }
        previousFrameMs = ms;
        if (!aligned(row) && !saved) {
          saved = true;
          await save('history-mismatch', image);
          report.violations.push(`selection detached ${round(at - click)} ms after click: ${JSON.stringify(row.offset)} px`);
        }
      }
      if (!restored) report.violations.push('no compositor frame showed the restored canvas before history ACK');
    },
    close: () => cdp.detach(),
  };
}
