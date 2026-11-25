import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..');
const buildDir = path.join(desktopDir, 'build');

function extractBrandSymbolPaths(sourceSvgPath) {
  const raw = readFileSync(sourceSvgPath, 'utf8');
  const matches = [...raw.matchAll(/<path[^>]*d="([^"]+)"/g)].map(m => m[1]);
  if (matches.length < 2) {
    throw new Error(`Expected 2 symbol paths in ${sourceSvgPath}, found ${matches.length}`);
  }
  return { ringPath: matches[0], arrowPath: matches[1] };
}

export function buildAppIconSvg(sourceSvgPath) {
  const { ringPath, arrowPath } = extractBrandSymbolPaths(sourceSvgPath);
  // 291x291 symbol scaled by 1.62 -> ~471px centered inside 824x824 squircle on 1024x1024 canvas.
  const symbolScale = 1.62;
  const symbolSize = 291 * symbolScale;
  const offset = (1024 - symbolSize) / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" fill="none">
  <defs>
    <linearGradient id="squircle-bg" x1="180" y1="100" x2="860" y2="924" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#25272b"/>
      <stop offset="55%" stop-color="#18191c"/>
      <stop offset="100%" stop-color="#0f1012"/>
    </linearGradient>
    <radialGradient id="emerald-aura" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(568 456) rotate(130) scale(410)">
      <stop offset="0%" stop-color="#00ff08" stop-opacity="0.22"/>
      <stop offset="58%" stop-color="#007106" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#007106" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rim-highlight" x1="512" y1="100" x2="512" y2="924" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.24"/>
      <stop offset="35%" stop-color="#ffffff" stop-opacity="0.07"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.03"/>
    </linearGradient>
    <linearGradient id="ring-ink" x1="0" y1="0" x2="291" y2="291" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#e6e8e4"/>
    </linearGradient>
    <linearGradient id="arrow-ink" x1="88" y1="90" x2="220" y2="220" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#58ff5e"/>
      <stop offset="100%" stop-color="#00e608"/>
    </linearGradient>
    <filter id="drop-shadow" x="60" y="72" width="904" height="912" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="22" stdDeviation="20" flood-color="#000000" flood-opacity="0.42"/>
    </filter>
  </defs>
  <g filter="url(#drop-shadow)">
    <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#squircle-bg)"/>
    <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#emerald-aura)"/>
    <rect x="101.5" y="101.5" width="821" height="821" rx="184.5" stroke="url(#rim-highlight)" stroke-width="3"/>
  </g>
  <g transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) scale(${symbolScale})">
    <path fill-rule="evenodd" clip-rule="evenodd" d="${ringPath}" fill="url(#ring-ink)"/>
    <path d="${arrowPath}" fill="url(#arrow-ink)"/>
  </g>
</svg>
`;
}

export const LIQUID_GLASS_ICON_NAME = 'AppIcon';

export function buildLiquidGlassIconBundle(sourceSvgPath, outIconDir) {
  const { ringPath, arrowPath } = extractBrandSymbolPaths(sourceSvgPath);
  const assetsDir = path.join(outIconDir, 'Assets');
  rmSync(outIconDir, { recursive: true, force: true });
  mkdirSync(assetsDir, { recursive: true });

  // Icon Composer uses a 1024x1024 full-bleed canvas; macOS applies the squircle
  // mask, outer shadow, and Liquid Glass refraction rim dynamically.
  // Size the 291x291 symbol to ~580px (~56.6% of canvas) to keep safe bevel clearance.
  const symbolSize = 580;
  const symbolScale = symbolSize / 291;
  const offset = (1024 - symbolSize) / 2;

  const auraSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <radialGradient id="aura" cx="56%" cy="46%" r="48%">
      <stop offset="0%" stop-color="#00ff22" stop-opacity="0.28"/>
      <stop offset="55%" stop-color="#007a14" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="#007a14" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#aura)"/>
</svg>
`;

  const ringSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="ring" x1="0" y1="0" x2="291" y2="291" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#d8dde2"/>
    </linearGradient>
  </defs>
  <g transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) scale(${symbolScale.toFixed(5)})">
    <path fill-rule="evenodd" clip-rule="evenodd" d="${ringPath}" fill="url(#ring)"/>
  </g>
</svg>
`;

  const arrowSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="arrow" x1="88" y1="90" x2="220" y2="220" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#6cff72"/>
      <stop offset="100%" stop-color="#00e608"/>
    </linearGradient>
  </defs>
  <g transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) scale(${symbolScale.toFixed(5)})">
    <path d="${arrowPath}" fill="url(#arrow)"/>
  </g>
</svg>
`;

  const iconManifest = {
    fill: {
      'linear-gradient': [
        'display-p3:0.16,0.175,0.195,1.0',
        'display-p3:0.06,0.068,0.08,1.0',
      ],
    },
    'fill-specializations': [
      {
        appearance: 'dark',
        value: {
          'linear-gradient': [
            'display-p3:0.11,0.125,0.145,1.0',
            'display-p3:0.035,0.04,0.05,1.0',
          ],
        },
      },
      {
        appearance: 'tinted',
        value: {
          'linear-gradient': [
            'display-p3:0.14,0.15,0.17,1.0',
            'display-p3:0.05,0.055,0.065,1.0',
          ],
        },
      },
    ],
    groups: [
      {
        layers: [
          {
            glass: false,
            'image-name': 'aura.svg',
            name: 'aura',
            'hidden-specializations': [
              {
                appearance: 'tinted',
                value: true,
              },
            ],
          },
        ],
        specular: false,
      },
      {
        layers: [
          {
            glass: true,
            'image-name': 'ring.svg',
            name: 'ring',
          },
          {
            glass: true,
            'image-name': 'arrow.svg',
            name: 'arrow',
          },
        ],
        shadow: {
          kind: 'neutral',
          opacity: 0.5,
        },
        specular: true,
        translucency: {
          enabled: true,
          value: 0.35,
        },
      },
    ],
    'supported-platforms': {
      squares: 'shared',
    },
  };

  writeFileSync(path.join(assetsDir, 'aura.svg'), auraSvg, 'utf8');
  writeFileSync(path.join(assetsDir, 'ring.svg'), ringSvg, 'utf8');
  writeFileSync(path.join(assetsDir, 'arrow.svg'), arrowSvg, 'utf8');
  writeFileSync(path.join(outIconDir, 'icon.json'), `${JSON.stringify(iconManifest, null, 2)}\n`, 'utf8');

  return { iconDir: outIconDir, iconManifest };
}

function compileLiquidGlassAssetsCar(iconBundleDir, outDir) {
  if (process.platform !== 'darwin' || !existsSync(iconBundleDir)) {
    return null;
  }

  const assetsCarPath = path.join(outDir, 'Assets.car');
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'om-actool-'));
  try {
    const res = spawnSync(
      'xcrun',
      [
        'actool',
        iconBundleDir,
        '--compile',
        tempDir,
        '--output-format',
        'human-readable-text',
        '--notices',
        '--warnings',
        '--errors',
        '--output-partial-info-plist',
        path.join(tempDir, 'Info.plist'),
        '--app-icon',
        LIQUID_GLASS_ICON_NAME,
        '--include-all-app-icons',
        '--enable-on-demand-resources',
        'NO',
        '--development-region',
        'en',
        '--target-device',
        'mac',
        '--minimum-deployment-target',
        '13.0',
        '--platform',
        'macosx',
      ],
      { stdio: 'pipe', timeout: 30_000 },
    );

    const compiledCar = path.join(tempDir, 'Assets.car');
    if (res.status === 0 && existsSync(compiledCar)) {
      copyFileSync(compiledCar, assetsCarPath);
      return assetsCarPath;
    }
    const detail = `${res.stderr?.toString('utf8') ?? ''}\n${res.stdout?.toString('utf8') ?? ''}`.trim();
    if (detail) {
      console.warn(`actool failed to compile Liquid Glass Assets.car (exit=${res.status ?? 'null'}): ${detail.slice(0, 600)}`);
    }
    return null;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function resolveElectronBinary() {
  for (const baseDir of [desktopDir, repoRoot]) {
    const electronPkgDir = path.join(baseDir, 'node_modules', 'electron');
    const pathTxt = path.join(electronPkgDir, 'path.txt');
    if (!existsSync(pathTxt)) continue;
    const rel = readFileSync(pathTxt, 'utf8').trim();
    const full = path.join(electronPkgDir, 'dist', rel);
    if (existsSync(full)) return full;
  }
  return null;
}

function rasterizeSvgViaQuickLook(svgPath, outPngPath, size = 1024) {
  if (process.platform !== 'darwin') return false;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'om-ql-icon-'));
  try {
    const res = spawnSync('qlmanage', ['-t', '-s', String(size), '-o', tempDir, svgPath], {
      stdio: 'pipe',
      timeout: 20_000,
    });
    const rendered = path.join(tempDir, `${path.basename(svgPath)}.png`);
    if (res.status === 0 && existsSync(rendered)) {
      copyFileSync(rendered, outPngPath);
      return true;
    }
    return false;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function readPngWidth(pngBuffer) {
  // PNG signature (8 bytes) + IHDR length (4) + "IHDR" (4) + width (4, big-endian).
  if (pngBuffer.length >= 24 && pngBuffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return pngBuffer.readUInt32BE(16);
  }
  return null;
}

function resolveSharpEntry() {
  for (const baseDir of [repoRoot, desktopDir]) {
    const pkgPath = path.join(baseDir, 'node_modules', 'sharp', 'package.json');
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const mainRel = typeof pkg.main === 'string' && pkg.main.trim() ? pkg.main.trim() : 'lib/index.js';
      const entryPath = path.join(path.dirname(pkgPath), mainRel);
      if (existsSync(entryPath)) return entryPath;
    } catch {
      // Ignore unreadable package metadata and continue searching.
    }
  }
  return null;
}

export function rasterizeTargetsViaSharp(inputPath, targets) {
  const sharpEntry = resolveSharpEntry();
  if (!sharpEntry || !existsSync(inputPath) || !Array.isArray(targets) || targets.length === 0) {
    return false;
  }

  const script = `
import { pathToFileURL } from 'node:url';
const [sharpEntry, inputPath, targetsJson] = process.argv.slice(1);
const mod = await import(pathToFileURL(sharpEntry).href);
const sharp = mod.default || mod;
const targets = JSON.parse(targetsJson);
await Promise.all(
  targets.map(({ size, outPath }) =>
    sharp(inputPath)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(outPath),
  ),
);
`;
  const res = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script, '--', sharpEntry, inputPath, JSON.stringify(targets)],
    { stdio: 'pipe', timeout: 30_000 },
  );
  return res.status === 0 && targets.every(t => existsSync(t.outPath));
}

export function rasterizeTargetsViaImageMagick(inputPath, targets) {
  if (!existsSync(inputPath) || !Array.isArray(targets) || targets.length === 0) {
    return false;
  }
  const probe = spawnSync('magick', ['-version'], { stdio: 'pipe', timeout: 5_000 });
  if (probe.status !== 0) return false;

  for (const target of targets) {
    const res = spawnSync(
      'magick',
      ['-background', 'none', inputPath, '-resize', `${target.size}x${target.size}`, `png32:${target.outPath}`],
      { stdio: 'pipe', timeout: 20_000 },
    );
    if (res.status !== 0 || !existsSync(target.outPath)) {
      return false;
    }
  }
  return true;
}

export function rasterizePngTargetsViaPowerShell(inputPngPath, targets) {
  if (process.platform !== 'win32' || !existsSync(inputPngPath) || !Array.isArray(targets) || targets.length === 0) {
    return false;
  }
  const psScript = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($env:OM_ICON_SRC)
try {
  $targets = $env:OM_ICON_TARGETS | ConvertFrom-Json
  foreach ($t in $targets) {
    $size = [int]$t.size
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    try {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.Clear([System.Drawing.Color]::Transparent)
        $g.DrawImage($src, 0, 0, $size, $size)
      } finally {
        $g.Dispose()
      }
      $bmp.Save($t.outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $bmp.Dispose()
    }
  }
} finally {
  $src.Dispose()
}
`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    env: {
      ...process.env,
      OM_ICON_SRC: inputPngPath,
      OM_ICON_TARGETS: JSON.stringify(targets),
    },
    stdio: 'pipe',
    timeout: 30_000,
  });
  return res.status === 0 && targets.every(t => existsSync(t.outPath));
}

function rasterizeSvgTargetsViaElectron(svgPath, targets) {
  const electronBin = resolveElectronBinary();
  if (!electronBin || !Array.isArray(targets) || targets.length === 0) return false;

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'om-icon-render-'));
  try {
    const svgBase64 = readFileSync(svgPath).toString('base64');
    const runnerPath = path.join(tempDir, 'render-icon.cjs');
    const runnerSource = `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
app.commandLine.appendSwitch('headless');
app.dock?.hide?.();
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 128,
      height: 128,
      show: false,
      transparent: true,
      webPreferences: { offscreen: true, contextIsolation: true },
    });
    const html = \`<!doctype html><html><body style="margin:0;background:transparent">
      <script>
        window.__renderSvgSizes = async (b64, sizes) => {
          const img = new Image();
          img.src = 'data:image/svg+xml;base64,' + b64;
          await img.decode();
          const out = {};
          for (const size of sizes) {
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, size, size);
            ctx.drawImage(img, 0, 0, size, size);
            out[String(size)] = canvas.toDataURL('image/png');
          }
          return out;
        };
      </script></body></html>\`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const targets = ${JSON.stringify(targets)};
    const sizes = [...new Set(targets.map(t => t.size))];
    const rendered = await win.webContents.executeJavaScript(
      'window.__renderSvgSizes(' + JSON.stringify(${JSON.stringify(svgBase64)}) + ', ' + JSON.stringify(sizes) + ')'
    );
    for (const target of targets) {
      const dataUrl = rendered[String(target.size)];
      if (!dataUrl) throw new Error('Missing rendered frame for size ' + target.size);
      const pngBase64 = dataUrl.replace(/^data:image\\/png;base64,/, '');
      fs.writeFileSync(target.outPath, Buffer.from(pngBase64, 'base64'));
    }
    win.destroy();
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
`;
    writeFileSync(runnerPath, runnerSource, 'utf8');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const res = spawnSync(electronBin, [runnerPath], { env, stdio: 'pipe', timeout: 25_000 });
    return res.status === 0 && targets.every(t => existsSync(t.outPath));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function rasterizeSvgViaElectron(svgPath, outPngPath, size = 1024) {
  return rasterizeSvgTargetsViaElectron(svgPath, [{ size, outPath: outPngPath }]);
}

export function packPngFramesAsIco(frames) {
  const count = frames.length;
  const headerSize = 6;
  const entrySize = 16;
  let offset = headerSize + count * entrySize;
  const directory = [];
  for (const frame of frames) {
    const entry = Buffer.alloc(entrySize);
    entry.writeUInt8(frame.size >= 256 ? 0 : frame.size, 0);
    entry.writeUInt8(frame.size >= 256 ? 0 : frame.size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(frame.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    directory.push(entry);
    offset += frame.data.length;
  }
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  return Buffer.concat([header, ...directory, ...frames.map(f => f.data)]);
}

const ICO_SIZES = [16, 32, 48, 64, 128, 256];

function buildIcnsAndIcoFromPng(masterPngPath, outDir, { preRenderedIcoFrames = null, fallbackPngPath = null } = {}) {
  const icnsPath = path.join(outDir, 'icon.icns');
  const icoPath = path.join(outDir, 'icon.ico');
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'om-icon-pack-'));

  try {
    if (process.platform === 'darwin') {
      const iconsetDir = path.join(tempDir, 'icon.iconset');
      mkdirSync(iconsetDir, { recursive: true });
      const specs = [
        [16, 'icon_16x16.png'],
        [32, 'icon_16x16@2x.png'],
        [32, 'icon_32x32.png'],
        [64, 'icon_32x32@2x.png'],
        [128, 'icon_128x128.png'],
        [256, 'icon_128x128@2x.png'],
        [256, 'icon_256x256.png'],
        [512, 'icon_256x256@2x.png'],
        [512, 'icon_512x512.png'],
        [1024, 'icon_512x512@2x.png'],
      ];
      for (const [px, filename] of specs) {
        spawnSync('sips', ['-z', String(px), String(px), masterPngPath, '--out', path.join(iconsetDir, filename)], {
          stdio: 'ignore',
        });
      }
      const icnsRes = spawnSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath], {
        stdio: 'ignore',
      });
      if (icnsRes.status !== 0 && existsSync(icnsPath)) {
        rmSync(icnsPath, { force: true });
      }

      const frames = [];
      for (const px of ICO_SIZES) {
        const framePath = path.join(tempDir, `ico-${px}.png`);
        const res = spawnSync('sips', ['-z', String(px), String(px), masterPngPath, '--out', framePath], {
          stdio: 'ignore',
        });
        if (res.status === 0 && existsSync(framePath)) {
          frames.push({ size: px, data: readFileSync(framePath) });
        }
      }
      if (frames.length > 0) {
        writeFileSync(icoPath, packPngFramesAsIco(frames));
      }
    } else if (Array.isArray(preRenderedIcoFrames) && preRenderedIcoFrames.length > 0) {
      writeFileSync(icoPath, packPngFramesAsIco(preRenderedIcoFrames));
    } else {
      let pngData = readFileSync(masterPngPath);
      let width = readPngWidth(pngData);
      if ((!width || width > 256) && fallbackPngPath && existsSync(fallbackPngPath)) {
        const fallbackData = readFileSync(fallbackPngPath);
        const fallbackWidth = readPngWidth(fallbackData);
        if (fallbackWidth && fallbackWidth <= 256) {
          pngData = fallbackData;
          width = fallbackWidth;
        }
      }
      const frameSize = width && width <= 256 ? width : 256;
      writeFileSync(icoPath, packPngFramesAsIco([{ size: frameSize, data: pngData }]));
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return {
    iconIcns: existsSync(icnsPath) ? icnsPath : null,
    iconIco: existsSync(icoPath) ? icoPath : null,
  };
}

export function buildDesktopIcons({
  sourceDir = path.join(repoRoot, 'packages', 'design-system', 'brand'),
  outDir = buildDir,
} = {}) {
  mkdirSync(outDir, { recursive: true });
  const sourceMarkSvg = path.join(sourceDir, 'loading-mark.svg');
  const fallbackPng = path.join(sourceDir, 'apple-touch-icon.png');
  const targetPng = path.join(outDir, 'icon.png');
  const targetSvg = path.join(outDir, 'icon.svg');
  const targetIconBundle = path.join(outDir, `${LIQUID_GLASS_ICON_NAME}.icon`);

  let iconBundle = null;
  let assetsCar = null;
  if (existsSync(sourceMarkSvg)) {
    writeFileSync(targetSvg, buildAppIconSvg(sourceMarkSvg), 'utf8');
    buildLiquidGlassIconBundle(sourceMarkSvg, targetIconBundle);
    iconBundle = targetIconBundle;
    assetsCar = compileLiquidGlassAssetsCar(targetIconBundle, outDir);
  }

  let preRenderedIcoFrames = null;
  let rasterized = false;
  if (existsSync(targetSvg)) {
    if (process.platform === 'darwin') {
      rasterized =
        rasterizeSvgViaQuickLook(targetSvg, targetPng, 1024) ||
        rasterizeTargetsViaSharp(targetSvg, [{ size: 1024, outPath: targetPng }]) ||
        rasterizeSvgViaElectron(targetSvg, targetPng, 1024);
    } else {
      const icoTempDir = mkdtempSync(path.join(os.tmpdir(), 'om-ico-frames-'));
      try {
        const icoTargets = ICO_SIZES.map(size => ({ size, outPath: path.join(icoTempDir, `ico-${size}.png`) }));
        const allTargets = [{ size: 1024, outPath: targetPng }, ...icoTargets];
        rasterized =
          rasterizeTargetsViaSharp(targetSvg, allTargets) ||
          rasterizeTargetsViaImageMagick(targetSvg, allTargets) ||
          rasterizeSvgTargetsViaElectron(targetSvg, allTargets);
        if (rasterized) {
          preRenderedIcoFrames = icoTargets.map(t => ({ size: t.size, data: readFileSync(t.outPath) }));
        }
      } finally {
        rmSync(icoTempDir, { recursive: true, force: true });
      }
    }
  }

  if (!rasterized) {
    if (!existsSync(fallbackPng)) {
      throw new Error(`Missing source icon: ${fallbackPng}`);
    }
    copyFileSync(fallbackPng, targetPng);
    if (process.platform === 'darwin') {
      spawnSync('sips', ['-z', '1024', '1024', targetPng, '--out', targetPng], {
        stdio: 'ignore',
      });
    } else {
      const icoTempDir = mkdtempSync(path.join(os.tmpdir(), 'om-ico-fallback-'));
      try {
        const icoTargets = ICO_SIZES.map(size => ({ size, outPath: path.join(icoTempDir, `ico-${size}.png`) }));
        const fallbackOk =
          rasterizeTargetsViaSharp(fallbackPng, icoTargets) ||
          rasterizeTargetsViaImageMagick(fallbackPng, icoTargets) ||
          rasterizePngTargetsViaPowerShell(fallbackPng, icoTargets);
        if (fallbackOk) {
          preRenderedIcoFrames = icoTargets.map(t => ({ size: t.size, data: readFileSync(t.outPath) }));
        }
      } finally {
        rmSync(icoTempDir, { recursive: true, force: true });
      }
    }
  }

  const { iconIcns, iconIco } = buildIcnsAndIcoFromPng(targetPng, outDir, {
    preRenderedIcoFrames,
    fallbackPngPath: fallbackPng,
  });

  return { iconPng: targetPng, iconSvg: targetSvg, iconIcns, iconIco, iconBundle, assetsCar };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildDesktopIcons();
  console.log(
    `Prepared desktop icons: png=${result.iconPng} icns=${result.iconIcns ?? 'n/a'} ico=${result.iconIco ?? 'n/a'} assetsCar=${result.assetsCar ?? 'n/a'}`,
  );
}
