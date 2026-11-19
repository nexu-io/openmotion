#!/usr/bin/env node
// Generate an editable HyperFrames project that writes thick, glowing neon tubes over real footage,
// led by a bright pen tip, relights the whole shot as each tube switches on, and can tuck tubes behind
// a cut-out subject.
// Usage:
//   node scripts/build.mjs --check neon.json
//   node scripts/build.mjs neon.json out/
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const [input, outDir] = args.filter(a => a !== '--check');
if (!input || (!checkOnly && !outDir)) {
  console.error('Usage: node scripts/build.mjs [--check] neon.json [out/]');
  process.exit(2);
}
const inputDir = path.dirname(path.resolve(input));
let data;
try { data = JSON.parse(await readFile(input, 'utf8')); } catch (e) { console.error(`✗ cannot read ${input}: ${e.message}`); process.exit(1); }
// Single-line (centre-line) script strokes, so each letter is one tube, not a hollow outline.
const font = JSON.parse(await readFile(path.join(here, '..', 'assets', 'fonts', 'allure-strokes.json'), 'utf8'));

// ---------- frame ----------
const FPS = 30;
const FRAMES = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] };
const aspect = data.aspect || '16:9';
const [W, H] = FRAMES[aspect] || [];

// ---------- geometry ----------
// Parse absolute M/L/H/V/Q/C/Z path data into contours of commands with numeric points.
const TOKEN = /([MLHVQCZmlhvqcz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
function parsePath(d) {
  const rest = String(d).replace(TOKEN, ' ').replace(/[\s,]+/g, '');
  if (rest) throw new Error(`path has characters it cannot read: "${rest.slice(0, 20)}" (use M L H V Q C Z and plain numbers)`);
  const toks = [...String(d).matchAll(TOKEN)].map(m => m[1] || +m[2]);
  const contours = []; let cur = null, cmd = null, x = 0, y = 0, sx = 0, sy = 0, i = 0;
  const need = { M: 2, L: 2, H: 1, V: 1, Q: 4, C: 6, Z: 0 };
  while (i < toks.length) {
    if (typeof toks[i] === 'string') { cmd = toks[i++]; if (cmd !== cmd.toUpperCase()) throw new Error(`relative command "${cmd}" — use absolute commands (M L H V Q C Z)`); if (cmd === 'Z') { if (cur) cur.push({ c: 'Z', p: [] }); x = sx; y = sy; continue; } }
    if (!cmd || cmd === 'Z') throw new Error('path data must start with M');
    const n = need[cmd]; const p = toks.slice(i, i + n); i += n;
    if (p.length < n || p.some(v => typeof v !== 'number')) throw new Error(`incomplete ${cmd} command`);
    if (cmd === 'M') { cur = []; contours.push(cur); cur.push({ c: 'M', p }); [x, y] = p; [sx, sy] = p; cmd = 'L'; continue; }
    if (!cur) throw new Error('path data must start with M');
    if (cmd === 'H') { cur.push({ c: 'L', p: [p[0], y] }); x = p[0]; continue; }
    if (cmd === 'V') { cur.push({ c: 'L', p: [x, p[0]] }); y = p[0]; continue; }
    cur.push({ c: cmd, p }); x = p[n - 2]; y = p[n - 1];
  }
  return contours;
}
const mapContour = (ct, f) => ct.map(k => ({ c: k.c, p: k.p.reduce((a, v, j) => (j % 2 ? a.push(...f(k.p[j - 1], v)) : null, a), []) }));
// The stroke font is stored as polylines; Catmull-Rom curves through its points give a hand-bent tube instead of facets.
function smooth(ct) {
  if (!ct.every(k => k.c === 'M' || k.c === 'L')) return ct;
  const pts = ct.map(k => k.p);
  if (pts.length < 3) return ct;
  const outC = [{ c: 'M', p: pts[0] }];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    outC.push({ c: 'C', p: [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]] });
  }
  return outC;
}
const fmt = v => (Math.round(v * 10) / 10).toString();
const toD = ct => ct.map(k => k.c + k.p.map(fmt).join(' ')).join('');
function length(ct) {
  let len = 0, x = 0, y = 0, sx = 0, sy = 0;
  for (const k of ct) {
    const p = k.p;
    if (k.c === 'M') { x = sx = p[0]; y = sy = p[1]; continue; }
    if (k.c === 'Z') { len += Math.hypot(sx - x, sy - y); x = sx; y = sy; continue; }
    const steps = k.c === 'L' ? 1 : 12; let px = x, py = y;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, u = 1 - t; let nx, ny;
      if (k.c === 'L') { nx = p[0]; ny = p[1]; }
      else if (k.c === 'Q') { nx = u * u * x + 2 * u * t * p[0] + t * t * p[2]; ny = u * u * y + 2 * u * t * p[1] + t * t * p[3]; }
      else { nx = u ** 3 * x + 3 * u * u * t * p[0] + 3 * u * t * t * p[2] + t ** 3 * p[4]; ny = u ** 3 * y + 3 * u * u * t * p[1] + 3 * u * t * t * p[3] + t ** 3 * p[5]; }
      len += Math.hypot(nx - px, ny - py); px = nx; py = ny;
    }
    x = p[p.length - 2]; y = p[p.length - 1];
  }
  return len;
}
function bbox(cts) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const ct of cts) for (const k of ct) for (let j = 0; j < k.p.length; j += 2) { a = Math.min(a, k.p[j]); c = Math.max(c, k.p[j]); b = Math.min(b, k.p[j + 1]); d = Math.max(d, k.p[j + 1]); }
  return { x0: a, y0: b, x1: c, y1: d };
}

// Shapes in a unit box (-1..1, y down), drawn in this stroke order.
const SHAPES = {
  heart: 'M0 -0.35C-0.25 -0.95 -1 -0.75 -0.95 -0.15C-0.9 0.35 -0.35 0.6 0 0.95C0.35 0.6 0.9 0.35 0.95 -0.15C1 -0.75 0.25 -0.95 0 -0.35',
  smile: 'M-0.45 -0.75L-0.45 -0.15M0.45 -0.75L0.45 -0.15M-0.85 0.25C-0.6 0.95 0.6 0.95 0.85 0.25',
  sparkle: 'M0 -1Q0.12 -0.12 1 0Q0.12 0.12 0 1Q-0.12 0.12 -1 0Q-0.12 -0.12 0 -1Z',
  underline: 'M-1 0.1C-0.5 -0.08 0.4 0.12 1 -0.1',
  circle: 'M0 -1C0.55 -1 1 -0.55 1 0C1 0.55 0.55 1 0 1C-0.55 1 -1 0.55 -1 0C-1 -0.55 -0.55 -1 0 -1Z',
  arrow: 'M-1 0.2C-0.4 -0.3 0.3 -0.3 0.95 0M0.55 -0.35L0.95 0L0.6 0.38',
};

// ---------- validation ----------
const errors = [];
const finite = v => typeof v === 'number' && Number.isFinite(v);
const HEX = /^#[0-9a-fA-F]{6}$/;
if (!W) errors.push(`aspect must be one of ${Object.keys(FRAMES).join(', ')}`);
const footage = data.footage?.src ? path.resolve(inputDir, data.footage.src) : null;
if (!footage) errors.push('footage.src is required (a video file next to neon.json)');
else if (!existsSync(footage)) errors.push(`footage.src "${data.footage.src}" was not found`);
const duration = data.duration;
if (typeof duration !== 'number' || duration < 3 || duration > 30) errors.push('duration must be 3-30 seconds');
const mediaStart = data.footage?.start ?? 0;
if (typeof mediaStart !== 'number' || mediaStart < 0) errors.push('footage.start must be a number of seconds ≥ 0');
const subject = data.footage?.subject ? path.resolve(inputDir, data.footage.subject) : null;
if (subject && !existsSync(subject)) errors.push(`footage.subject "${data.footage.subject}" was not found — make it with: npx hyperframes remove-background <clip> -o subject.webm`);
const subjectStart = data.footage?.subjectStart ?? mediaStart;
if (subject && (!finite(subjectStart) || subjectStart < 0)) errors.push('footage.subjectStart must be a number of seconds ≥ 0');
if (subject && !/\.(webm|mov)$/i.test(subject)) errors.push('footage.subject must be a transparent .webm or .mov from `hyperframes remove-background`');
const tube = data.tube || {};
const tubeWidth = tube.width ?? 22, glow = tube.glow ?? 1, relight = data.relight ?? 1, darken = data.darken ?? 0.45;
for (const [k, v] of Object.entries({ 'tube.width': tubeWidth, 'tube.glow': glow, relight, darken })) if (!finite(v)) errors.push(`${k} must be a number`);
if (tubeWidth < 4 || tubeWidth > 40) errors.push('tube.width must be 4-40 px');
if (glow < 0 || glow > 2) errors.push('tube.glow must be 0-2');
if (relight < 0 || relight > 1.5) errors.push('relight must be 0-1.5');
if (darken < 0 || darken > 0.8) errors.push('darken must be 0-0.8');
const pieces = data.pieces || [];
if (pieces.length < 1 || pieces.length > 6) errors.push('use 1-6 pieces');

const built = [];
pieces.forEach((pc, i) => {
  const at = `pieces[${i}]`;
  const color = pc.color || '#ff3d8b';
  if (!HEX.test(color)) errors.push(`${at}.color "${color}" must be #rrggbb`);
  if (typeof pc.start !== 'number' || pc.start < 0) errors.push(`${at}.start must be seconds ≥ 0`);
  const kinds = ['text', 'shape', 'path'].filter(k => pc[k] != null);
  if (kinds.length !== 1) { errors.push(`${at} needs exactly one of text, shape or path`); return; }
  const cx = pc.x ?? 0.5, cy = pc.y ?? 0.5;
  for (const k of ['x', 'y', 'size', 'draw']) if (pc[k] != null && !finite(pc[k])) { errors.push(`${at}.${k} must be a number`); return; }
  if (pc.size != null && (pc.size <= 0 || pc.size > 0.5)) { errors.push(`${at}.size must be above 0 and at most 0.5`); return; }
  if (pc.draw != null && (pc.draw < 0.3 || pc.draw > 10)) { errors.push(`${at}.draw must be 0.3-10 seconds`); return; }
  if (cx < 0 || cx > 1 || cy < 0 || cy > 1) errors.push(`${at}.x and .y are 0-1 fractions of the frame`);
  const layer = pc.layer ?? 'front';
  if (!['front', 'behind'].includes(layer)) errors.push(`${at}.layer must be front or behind`);
  if (layer === 'behind' && !data.footage?.subject) errors.push(`${at}.layer "behind" needs footage.subject (a cut-out of the person or object)`);
  let contours = [];
  try {
    if (pc.text != null) {
      const text = String(pc.text);
      const bad = [...text].filter(ch => ch !== ' ' && !font.glyphs[ch]);
      if (!text.trim()) errors.push(`${at}.text is empty`);
      if (bad.length) { errors.push(`${at}.text has characters the bundled script font cannot draw: ${[...new Set(bad)].join(' ')} — use Latin letters, or draw them as a path`); return; }
      if ([...text].length > 18) errors.push(`${at}.text "${text}" is longer than 18 characters — split it into two pieces`);
      const size = (pc.size ?? 0.16) * H; // capital height in px
      const s = size / 500; // the stroke font's capitals are 500 units tall
      let adv = 0; const glyphCts = [];
      for (const ch of text) {
        if (ch === ' ') { adv += font.space; continue; }
        const g = font.glyphs[ch]; const off = adv;
        glyphCts.push(...parsePath(g.d).map(ct => ({ ct: smooth(ct), off })));
        adv += g.a;
      }
      const textW = adv * s;
      const ox = cx * W - textW / 2, oy = cy * H + size * 0.45;
      contours = glyphCts.map(({ ct, off }) => mapContour(ct, (x, y) => [ox + (x + off) * s, oy - y * s]));
    } else {
      const d = pc.shape != null ? SHAPES[pc.shape] : pc.path;
      if (pc.shape != null && !d) { errors.push(`${at}.shape must be one of ${Object.keys(SHAPES).join(', ')}`); return; }
      const raw = parsePath(d);
      const half = (pc.size ?? 0.15) * H;
      let f;
      if (pc.shape != null) f = (x, y) => [cx * W + x * half, cy * H + y * half];
      else { const b = bbox(raw); const sc = (2 * half) / Math.max(b.x1 - b.x0, b.y1 - b.y0, 1); f = (x, y) => [cx * W + (x - (b.x0 + b.x1) / 2) * sc, cy * H + (y - (b.y0 + b.y1) / 2) * sc]; }
      contours = raw.map(ct => mapContour(ct, f));
    }
  } catch (e) { errors.push(`${at}: ${e.message}`); return; }
  const b = bbox(contours);
  const pad = tubeWidth * 1.5;
  if (b.x0 < pad || b.y0 < pad || b.x1 > W - pad || b.y1 > H - pad) errors.push(`${at} runs off the ${W}×${H} frame (box ${Math.round(b.x0)},${Math.round(b.y0)} → ${Math.round(b.x1)},${Math.round(b.y1)}) — make it smaller or move it`);
  const lens = contours.map(length);
  const total = lens.reduce((a, v) => a + v, 0);
  const draw = pc.draw ?? Math.min(3.2, Math.max(0.9, total / 1400));
  if (typeof pc.start === 'number' && pc.start + draw > duration - 0.8) errors.push(`${at} finishes drawing at ${(pc.start + draw).toFixed(1)} s; it must finish 0.8 s before the ${duration} s end`);
  // Each contour gets a floor of 0.06 s, then all are scaled so they add up to exactly `draw`.
  const raw = lens.map(l => Math.max(0.06, draw * l / (total || 1))); const rawSum = raw.reduce((a, v) => a + v, 0);
  const times = raw.map(v => v * draw / rawSum);
  built.push({ i, color, contours, lens, total, draw, times, start: pc.start, b, layer, caps: pc.caps ?? (pc.text == null), flicker: pc.flicker !== false, label: pc.text ?? pc.shape ?? 'path' });
});
const brand = data.brand !== false;

if (errors.length) { console.error(`✗ ${errors.length} problem(s) in ${input}:\n` + errors.map(e => '  - ' + e).join('\n')); process.exit(1); }
if (checkOnly) { console.log(`✓ ${input}: ${built.length} piece(s), ${duration} s, ${W}×${H}`); process.exit(0); }


// ---------- output ----------
const out = path.resolve(outDir);
await mkdir(path.join(out, 'assets', 'brand'), { recursive: true });
const ext = path.extname(footage) || '.mp4';
await copyFile(footage, path.join(out, 'assets', 'footage' + ext));
const subjectExt = subject ? path.extname(subject) : '';
if (subject) await copyFile(subject, path.join(out, 'assets', 'subject' + subjectExt));
const require = createRequire(import.meta.url);
let gsapPath = null;
for (const base of [process.env.OPENMOTION_HOME, process.cwd(), here, path.resolve(here, '../../../..')].filter(Boolean)) {
  try { gsapPath = require.resolve('gsap/dist/gsap.min.js', { paths: [base] }); break; } catch {}
}
if (!gsapPath) { console.error('GSAP was not found. Set OPENMOTION_HOME to your OpenMotion checkout, or run `npm install gsap` in the working directory.'); process.exit(1); }
await copyFile(gsapPath, path.join(out, 'assets', 'gsap.min.js'));
const checkoutLogo = path.resolve(here, '../../../../packages/design-system/brand/openmotion-logo.svg');
await copyFile(existsSync(checkoutLogo) ? checkoutLogo : path.join(here, '..', 'assets', 'brand', 'openmotion-logo.svg'), path.join(out, 'assets', 'brand', 'openmotion-logo.svg'));

const mix = (hex, t) => { const n = parseInt(hex.slice(1), 16); const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v + (255 - v) * t)); return '#' + c.map(v => v.toString(16).padStart(2, '0')).join(''); };
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const T = tubeWidth, g = Math.max(0.01, glow), f1 = v => v.toFixed(1);
// Direction at a contour's open ends, for the electrode caps.
function ends(ct) {
  if (ct.some(k => k.c === 'Z') || ct.length < 2) return null;
  const pts = []; for (const k of ct) for (let j = 0; j < k.p.length; j += 2) pts.push([k.p[j], k.p[j + 1]]);
  const away = (a, list) => { for (const b of list) { const d = Math.hypot(b[0] - a[0], b[1] - a[1]); if (d > 0.5) return [(a[0] - b[0]) / d, (a[1] - b[1]) / d]; } return null; };
  const s = pts[0], e = pts[pts.length - 1];
  if (Math.hypot(s[0] - e[0], s[1] - e[1]) < 1) return null; // ends meet: a closed loop has no electrodes
  const ds = away(s, pts.slice(1)), de = away(e, pts.slice(0, -1).reverse());
  return ds && de ? [{ p: s, d: ds }, { p: e, d: de }] : null;
}
const cap = (id, { p, d }) => {
  const x2 = p[0] + d[0] * T * 1.1, y2 = p[1] + d[1] * T * 1.1, x3 = p[0] + d[0] * T * 1.9, y3 = p[1] + d[1] * T * 1.9;
  return `<g id="${id}" opacity="0"><line x1="${f1(x2)}" y1="${f1(y2)}" x2="${f1(x3)}" y2="${f1(y3)}" stroke="#121214" stroke-width="${f1(T * 0.25)}"/>
    <line x1="${f1(p[0])}" y1="${f1(p[1])}" x2="${f1(x2)}" y2="${f1(y2)}" stroke="#1d1d21" stroke-width="${f1(T * 1.45)}"/>
    <line x1="${f1(p[0])}" y1="${f1(p[1])}" x2="${f1(x2)}" y2="${f1(y2)}" stroke="#6c6c74" stroke-width="${f1(T * 0.35)}" opacity=".7"/></g>`;
};
const svgs = { front: '', behind: '' };
let lights = '', tl = '';
for (const p of built) {
  const id = `n${p.i}`;
  const seg = (cls, k, ct) => `<path ${cls === 'c' ? `id="${id}-c${k}" ` : ''}class="${id}-s${k}" d="${toD(ct)}" pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1"/>`;
  const layer = (cls, stroke, w, extra = '') => `<g fill="none" stroke="${stroke}" stroke-width="${f1(w)}" stroke-linecap="round" stroke-linejoin="round" ${extra}>${p.contours.map((ct, k) => seg(cls, k, ct)).join('')}</g>`;
  // A glass tube read from outside in: wide halo, coloured glow, saturated glass, pale core, white hot line.
  const capList = p.caps ? p.contours.map((ct, k) => ({ k, e: ends(ct) })).filter(c => c.e) : [];
  svgs[p.layer] += `<g id="${id}">
  ${layer('h', p.color, T * 4.4, `opacity="${(0.62 * Math.min(1, g)).toFixed(2)}" filter="url(#halo)"`)}
  ${layer('g', p.color, T * 2.1, 'opacity=".95" filter="url(#soft)"')}
  ${layer('b', mix(p.color, 0.35), T * 1.15)}
  ${layer('c', mix(p.color, 0.88), T * 0.8)}
  ${layer('w', '#ffffff', T * 0.42, 'opacity=".95"')}
  ${capList.map(c => cap(`${id}-k${c.k}a`, c.e[0]) + cap(`${id}-k${c.k}b`, c.e[1])).join('\n  ')}
</g>\n`;
  svgs[p.layer] += `<g id="${id}-tip" opacity="0"><circle r="${f1(T * 3.6)}" fill="${p.color}" opacity=".7" filter="url(#halo)"/><circle r="${f1(T * 1.6)}" fill="${mix(p.color, 0.7)}" filter="url(#soft)"/><circle r="${f1(T * 0.85)}" fill="#ffffff"/></g>\n`;
  const lx = ((p.b.x0 + p.b.x1) / 2 / W * 100).toFixed(1), ly = ((p.b.y0 + p.b.y1) / 2 / H * 100).toFixed(1);
  // Light reach and strength follow how much tube there is: a long word floods the room, a small mark lights its corner.
  const rx = Math.max(22, (p.b.x1 - p.b.x0) / W * 130).toFixed(0), ry = Math.max(28, (p.b.y1 - p.b.y0) / H * 200).toFixed(0);
  const amp = +(relight * Math.min(1, Math.max(0.35, p.total / 2200))).toFixed(2);
  lights += `<div id="${id}-light" class="light" style="background:radial-gradient(${rx}% ${ry}% at ${lx}% ${ly}%, ${rgba(mix(p.color, 0.35), 0.95)} 0%, ${rgba(p.color, 0.45)} 50%, rgba(0,0,0,0) 100%)"></div>
<div id="${id}-tint" class="tint" style="background:radial-gradient(150% 150% at ${lx}% ${ly}%, ${rgba(p.color, 0.9)} 0%, ${rgba(p.color, 0.4)} 55%, ${rgba(p.color, 0.1)} 100%)"></div>\n`;
  // Draw each contour in order, the pen tip riding the stroke being drawn.
  let t = p.start;
  p.contours.forEach((_, k) => {
    const dt = p.times[k];
    tl += `tl.fromTo('#main .${id}-s${k}',{strokeDashoffset:1},{strokeDashoffset:0,duration:${dt.toFixed(3)},ease:'none'},${t.toFixed(3)});\n`;
    tl += `tl.fromTo({v:0},{v:0},{v:1,duration:${dt.toFixed(3)},ease:'none',onUpdate(){tip('${id}','${id}-c${k}',this.targets()[0].v)}},${t.toFixed(3)});\n`;
    if (capList.some(c => c.k === k)) {
      tl += `tl.fromTo('#${id}-k${k}a',{opacity:0},{opacity:1,duration:0.08},${t.toFixed(3)});\n`;
      tl += `tl.fromTo('#${id}-k${k}b',{opacity:0},{opacity:1,duration:0.08},${(t + dt - 0.02).toFixed(3)});\n`;
    }
    t += dt;
  });
  const end = p.start + p.draw;
  tl += `tl.set('#${id}-tip',{opacity:1},${p.start.toFixed(3)});\ntl.to('#${id}-tip',{opacity:0,duration:0.25},${end.toFixed(3)});\n`;
  tl += `tl.fromTo('#${id}-light',{opacity:0},{opacity:${amp},duration:${p.draw.toFixed(3)},ease:'power1.in'},${p.start.toFixed(3)});\n`;
  tl += `tl.fromTo('#${id}-tint',{opacity:0},{opacity:${(amp * 0.55).toFixed(2)},duration:${p.draw.toFixed(3)},ease:'power1.in'},${p.start.toFixed(3)});\n`;
  if (p.flicker) {
    // Switch-on stutter when the tube closes, like a real neon transformer catching.
    [[0, 0.35], [0.07, 1], [0.13, 0.5], [0.19, 1], [0.3, 0.8], [0.36, 1]].forEach(([dt, o]) => {
      tl += `tl.set(['#${id}','#${id}-light','#${id}-tint'],{opacity:(i,el)=>el.id==='${id}'?${o}:(el.id==='${id}-tint'?${(amp * 0.55).toFixed(2)}:${amp})*${o}},${(end + dt).toFixed(3)});\n`;
    });
  }
  tl += `tl.fromTo('#${id}',{opacity:1},{opacity:0.9,duration:1.6,ease:'sine.inOut',yoyo:true,repeat:${Math.max(0, Math.floor((duration - end - 0.5) / 1.6))}},${(end + 0.5).toFixed(3)});\n`;
}
const brandHtml = brand ? `<div id="sign" style="position:absolute;right:${Math.round(W * 0.035)}px;bottom:${Math.round(H * 0.045)}px;display:flex;align-items:center;gap:14px;z-index:9;opacity:0">
    <span style="font:600 ${Math.max(28, Math.round(H * 0.026))}px Inter,sans-serif;letter-spacing:.08em;color:rgba(255,255,255,.78)">MADE WITH</span>
    <img src="assets/brand/openmotion-logo.svg" alt="OpenMotion" style="height:${Math.max(34, Math.round(H * 0.034))}px;width:auto;filter:invert(1) brightness(1.6)">
  </div>` : '';
if (brand) tl += `tl.fromTo('#sign',{opacity:0,y:8},{opacity:1,y:0,duration:0.6,ease:'power2.out'},${Math.max(0, duration - 2).toFixed(3)});\n`;
const total = Math.round(duration * FPS) / FPS;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const keepSound = data.footage?.sound === true;
const grade = `brightness(${(1 - darken * 0.7).toFixed(2)}) saturate(.82) contrast(1.06)`;
const defs = `<defs>
        <filter id="halo" filterUnits="userSpaceOnUse" x="${-W}" y="${-H}" width="${3 * W}" height="${3 * H}"><feGaussianBlur stdDeviation="${(T * 1.6 * g).toFixed(1)}"/></filter>
        <filter id="soft" filterUnits="userSpaceOnUse" x="${-W}" y="${-H}" width="${3 * W}" height="${3 * H}"><feGaussianBlur stdDeviation="${(T * 0.45 * g).toFixed(1)}"/></filter>
      </defs>`;
const svgLayer = (key, z, inner) => `<svg id="tubes-${key}" class="tubes" style="z-index:${z}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${key === 'front' ? defs : ''}${key !== 'front' ? `<defs><filter id="halo-b" filterUnits="userSpaceOnUse" x="${-W}" y="${-H}" width="${3 * W}" height="${3 * H}"><feGaussianBlur stdDeviation="${(T * 1.6 * g).toFixed(1)}"/></filter><filter id="soft-b" filterUnits="userSpaceOnUse" x="${-W}" y="${-H}" width="${3 * W}" height="${3 * H}"><feGaussianBlur stdDeviation="${(T * 0.45 * g).toFixed(1)}"/></filter></defs>` : ''}
${key === 'front' ? inner : inner.replace(/url\(#halo\)/g, 'url(#halo-b)').replace(/url\(#soft\)/g, 'url(#soft-b)')}    </svg>`;
await writeFile(path.join(out, 'index.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="generator" content="openmotion-neon-script">
  <title>${esc(built.map(p => p.label).join(' · '))} · neon script</title>
  <script src="assets/gsap.min.js"></script>
  <style>
    body{margin:0;background:#000}
    #main{position:relative;width:${W}px;height:${H}px;overflow:hidden;background:#000}
    #footage,#subject{position:absolute;left:0;top:0;width:${W}px;height:${H}px;object-fit:cover;filter:${grade}}
    #footage{z-index:1}
    #vignette{position:absolute;inset:0;z-index:2;background:radial-gradient(120% 120% at 50% 45%, rgba(0,0,0,0) 45%, rgba(2,3,8,${Math.min(0.85, darken + 0.25).toFixed(2)}) 100%)}
    #subject{z-index:4}
    .tubes{position:absolute;left:0;top:0}
    .light{position:absolute;inset:0;z-index:6;mix-blend-mode:overlay;opacity:0}
    .tint{position:absolute;inset:0;z-index:6;mix-blend-mode:soft-light;opacity:0}
  </style>
</head>
<body>
  <div id="main" data-composition-id="main" data-start="0" data-duration="${total}" data-width="${W}" data-height="${H}" data-fps="${FPS}">
    <video id="footage" class="clip" src="assets/footage${ext}" data-start="0" data-duration="${total}" data-media-start="${mediaStart}" data-track-index="0" ${keepSound ? 'data-has-audio="true"' : 'muted'} playsinline></video>
    <div id="vignette"></div>
    ${svgs.behind ? svgLayer('behind', 3, svgs.behind) : ''}
    ${subject ? `<video id="subject" class="clip" src="assets/subject${subjectExt}" data-start="0" data-duration="${total}" data-media-start="${subjectStart}" data-track-index="1" muted playsinline data-layout-allow-occlusion></video>` : ''}
    ${svgLayer('front', 7, svgs.front)}
${lights}    ${brandHtml}
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    // Move a piece's pen tip to fraction v along one of its drawn strokes.
    function tip(id, pathId, v) {
      const p = document.getElementById(pathId), t = document.getElementById(id + '-tip');
      if (!p || !t) return;
      const q = p.getPointAtLength(v * p.getTotalLength());
      t.setAttribute('transform', 'translate(' + q.x.toFixed(1) + ',' + q.y.toFixed(1) + ')');
    }
${tl.split('\n').map(l => '    ' + l).join('\n')}
    window.__timelines.main = tl;
  </script>
</body>
</html>
`);
const project = JSON.parse(JSON.stringify(data));
project.footage.src = 'assets/footage' + ext;
if (subject) project.footage.subject = 'assets/subject' + subjectExt;
await writeFile(path.join(out, 'neon.json'), JSON.stringify(project, null, 2));
console.log(`✓ ${built.map(p => p.label).join(' + ')}: ${built.length} piece(s), ${total.toFixed(1)} s, ${W}×${H}${subject ? ', subject cut-out' : ''} → ${out}`);
