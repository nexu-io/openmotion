import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHyperframeRuntimeScript } from '@hyperframes/core/runtime-script';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import sharp from 'sharp';
import {
  COMPOSITION_FILMSTRIP_VERSION,
  embedFilmstripComment,
  MAX_FILMSTRIP_FRAME_HEIGHT,
  MAX_FILMSTRIP_FRAMES,
  MIN_FILMSTRIP_FRAME_HEIGHT,
  MIN_FILMSTRIP_FRAME_WIDTH,
} from '../studio/engine/composition-filmstrip-sprite.ts';
import {
  buildSubCompositionHtmlInMemory,
  bundlePreviewInMemory,
} from '../studio/engine/preview-bundler.ts';
import {
  InMemoryVirtualProject,
  type VirtualFileRecord,
} from '../studio/virtual-project-store.ts';
import {
  assertRenderSubprocessEnvClean,
  buildRenderSubprocessEnv,
} from './render-env.ts';

const DEFAULT_REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_FILMSTRIP_FRAME_WIDTH = 160;
export const DEFAULT_FILMSTRIP_FRAME_COUNT = MAX_FILMSTRIP_FRAMES;
export const DEFAULT_FILMSTRIP_JPEG_QUALITY = 78;

export interface CapturedFilmstripSprite {
  readonly jpeg: Buffer;
  readonly version: 1;
  readonly frameCount: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly aspect: number;
}

export interface VirtualPreviewServerInput {
  readonly projectId: string;
  readonly projectName?: string;
  readonly revision: string;
  readonly files: readonly VirtualFileRecord[];
  readonly textContents: ReadonlyMap<string, string>;
  readonly resolveAsset: (
    relPath: string,
  ) => Promise<{ readonly bytes: Buffer; readonly mimeType: string } | null> | { readonly bytes: Buffer; readonly mimeType: string } | null;
  readonly onAssetLoadError?: (relPath: string, error: unknown) => void;
  readonly repoRoot?: string;
}

export function detectFilmstripBrowserExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.HYPERFRAMES_BROWSER_PATH,
    env.PRODUCER_HEADLESS_SHELL_PATH,
    env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter((p): p is string => Boolean(p && p.trim()));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'No Chromium/Chrome executable found. Set HYPERFRAMES_BROWSER_PATH or install Chrome/Chromium.',
  );
}

export function computeFilmstripSampleTimes(durationSeconds: number, frameCount: number): number[] {
  const safeDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const count = Math.max(1, Math.min(MAX_FILMSTRIP_FRAMES, Math.floor(frameCount || 1)));
  if (safeDuration <= 0) return [0];
  if (count === 1) {
    return [Number((safeDuration <= 3 ? safeDuration * 0.5 : Math.min(3, safeDuration * 0.35)).toFixed(3))];
  }
  if (count === 2) {
    return [Number((safeDuration * 0.25).toFixed(3)), Number((safeDuration * 0.75).toFixed(3))];
  }
  const start = safeDuration * 0.04;
  const end = safeDuration * 0.94;
  const step = (end - start) / (count - 1);
  return Array.from({ length: count }, (_, i) => Number((start + i * step).toFixed(3)));
}

export function computeFilmstripSpriteDimensions(
  stageWidth: number,
  stageHeight: number,
  maxFrameWidth = DEFAULT_FILMSTRIP_FRAME_WIDTH,
): { frameWidth: number; frameHeight: number; aspect: number } {
  const safeW = Math.max(1, Number.isFinite(stageWidth) && stageWidth > 0 ? stageWidth : 1920);
  const safeH = Math.max(1, Number.isFinite(stageHeight) && stageHeight > 0 ? stageHeight : 1080);
  const aspect = safeW / safeH;
  const scale = Math.min(1, maxFrameWidth / safeW, MAX_FILMSTRIP_FRAME_HEIGHT / safeH);
  const frameWidth = Math.max(MIN_FILMSTRIP_FRAME_WIDTH, Math.round(safeW * scale));
  const frameHeight = Math.max(MIN_FILMSTRIP_FRAME_HEIGHT, Math.round(safeH * scale));
  return { frameWidth, frameHeight, aspect };
}

export async function startVirtualTemplatePreviewServer(
  input: VirtualPreviewServerInput,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const repoRoot = input.repoRoot ?? DEFAULT_REPO_ROOT;
  const runtimeJs = getHyperframeRuntimeScript();
  const virtual = new InMemoryVirtualProject({
    projectId: input.projectId,
    projectName: input.projectName ?? input.projectId,
    revision: input.revision,
    files: input.files,
    textContents: input.textContents,
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/runtime.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(runtimeJs);
        return;
      }
      if (url.pathname.startsWith('/api/vendor/gsap/')) {
        const assetName = path.posix.basename(url.pathname);
        const gsapPath = path.join(repoRoot, 'node_modules/gsap/dist', assetName);
        if (existsSync(gsapPath)) {
          const bytes = await readFile(gsapPath);
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
          res.end(bytes);
          return;
        }
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      if (url.pathname === '/preview' || url.pathname === '/preview/') {
        const html = await bundlePreviewInMemory(virtual, {
          runtimeUrl: '/api/runtime.js',
          baseHref: '/preview/',
          gsapBaseUrl: '/api/vendor/gsap/',
          capture: true,
          cacheProjectScripts: false,
          skipDeterministicFonts: true,
        });
        if (!html) {
          res.writeHead(404);
          res.end('Entry composition not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (url.pathname.startsWith('/preview/comp/')) {
        const compPath = decodeURIComponent(url.pathname.slice('/preview/comp/'.length));
        const html = await buildSubCompositionHtmlInMemory(virtual, compPath, {
          runtimeUrl: '/api/runtime.js',
          baseHref: '/preview/',
          gsapBaseUrl: '/api/vendor/gsap/',
          capture: true,
          cacheProjectScripts: false,
          skipDeterministicFonts: true,
        });
        if (!html) {
          res.writeHead(404);
          res.end('Composition not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (url.pathname.startsWith('/preview/')) {
        const rel = decodeURIComponent(url.pathname.slice('/preview/'.length));
        let found: { readonly bytes: Buffer; readonly mimeType: string } | null;
        try {
          found = await input.resolveAsset(rel);
        } catch (assetError) {
          input.onAssetLoadError?.(rel, assetError);
          if (!res.writableEnded && !res.destroyed) {
            res.writeHead(502, { 'Cache-Control': 'no-store' });
            res.end(assetError instanceof Error ? assetError.message : 'Asset load failed');
          }
          return;
        }
        if (res.writableEnded || res.destroyed) return;
        if (!found) {
          res.writeHead(404, { 'Cache-Control': 'no-store' });
          res.end('Asset not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': found.mimeType });
        res.end(found.bytes);
        return;
      }
      if (!res.writableEnded && !res.destroyed) {
        res.writeHead(404, { 'Cache-Control': 'no-store' });
        res.end('Not found');
      }
    } catch (error) {
      if (!res.writableEnded && !res.destroyed) {
        res.writeHead(500, { 'Cache-Control': 'no-store' });
        res.end(error instanceof Error ? error.message : 'Server error');
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

export async function captureCompositionFilmstripSprite(
  page: Page,
  origin: string,
  compPath: string,
  options?: {
    readonly frameWidth?: number;
    readonly frameCount?: number;
    readonly jpegQuality?: number;
    readonly navigationTimeoutMs?: number;
    readonly readyTimeoutMs?: number;
  },
): Promise<CapturedFilmstripSprite> {
  const maxFrameWidth = options?.frameWidth ?? DEFAULT_FILMSTRIP_FRAME_WIDTH;
  const frameCount = options?.frameCount ?? DEFAULT_FILMSTRIP_FRAME_COUNT;
  const jpegQuality = options?.jpegQuality ?? DEFAULT_FILMSTRIP_JPEG_QUALITY;
  const navigationTimeoutMs = options?.navigationTimeoutMs ?? 30_000;
  const readyTimeoutMs = options?.readyTimeoutMs ?? 15_000;

  const targetUrl =
    compPath === 'index.html'
      ? `${origin}/preview`
      : `${origin}/preview/comp/${compPath
          .split('/')
          .map((s) => encodeURIComponent(s))
          .join('/')}`;

  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: navigationTimeoutMs });

  await page.waitForFunction(
    () => {
      const p = (window as unknown as { __player?: { seek?: unknown; getDuration?: () => number } }).__player;
      return Boolean(p && typeof p.seek === 'function' && typeof p.getDuration === 'function' && p.getDuration() > 0);
    },
    { timeout: readyTimeoutMs },
  );

  const stageInfo = await page.evaluate(async () => {
    const p = (window as unknown as {
      __player?: { pause?: () => void; getDuration?: () => number };
    }).__player;
    p?.pause?.();
    if (document.fonts?.ready) {
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]);
    }
    const imgs = Array.from(document.querySelectorAll('img')).filter((img) => !img.complete);
    if (imgs.length > 0) {
      await Promise.race([
        Promise.all(
          imgs.map(
            (img) =>
              new Promise<void>((resolve) => {
                img.addEventListener('load', () => resolve(), { once: true });
                img.addEventListener('error', () => resolve(), { once: true });
              }),
          ),
        ),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    }
    const root = (document.querySelector('[data-composition-id]') ?? document.body) as HTMLElement;
    const width = Number(root.getAttribute('data-width')) || root.clientWidth || 1920;
    const height = Number(root.getAttribute('data-height')) || root.clientHeight || 1080;
    const duration = p?.getDuration?.() ?? 5;
    return { width, height, duration };
  });

  if (stageInfo.width !== 1920 || stageInfo.height !== 1080) {
    await page.setViewport({
      width: Math.max(320, Math.round(stageInfo.width)),
      height: Math.max(180, Math.round(stageInfo.height)),
      deviceScaleFactor: 1,
    });
  }

  const { frameWidth, frameHeight, aspect } = computeFilmstripSpriteDimensions(
    stageInfo.width,
    stageInfo.height,
    maxFrameWidth,
  );
  const times = computeFilmstripSampleTimes(stageInfo.duration, frameCount);

  const framePngs: Buffer[] = [];
  for (const t of times) {
    await page.evaluate(async (timeSec: number) => {
      const p = (window as unknown as { __player?: { seek?: (n: number) => void } }).__player;
      p?.seek?.(timeSec);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    }, t);

    const rootHandle = await page.$('[data-composition-id]');
    const rawPng = rootHandle
      ? Buffer.from(await rootHandle.screenshot({ type: 'png' }))
      : Buffer.from(await page.screenshot({ type: 'png' }));
    if (rootHandle) await rootHandle.dispose();

    const resized = await sharp(rawPng)
      .resize(frameWidth, frameHeight, { fit: 'fill' })
      .png()
      .toBuffer();
    framePngs.push(resized);
  }

  const totalWidth = frameWidth * framePngs.length;
  const rawJpeg = await sharp({
    create: {
      width: totalWidth,
      height: frameHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite(
      framePngs.map((input, idx) => ({
        input,
        left: idx * frameWidth,
        top: 0,
      })),
    )
    .jpeg({ quality: jpegQuality, mozjpeg: true })
    .toBuffer();

  const meta = {
    version: COMPOSITION_FILMSTRIP_VERSION,
    frameCount: framePngs.length,
    frameWidth,
    frameHeight,
    aspect: Number(aspect.toFixed(4)),
  };
  const jpeg = embedFilmstripComment(rawJpeg, meta);
  if (!jpeg) {
    throw new Error(`Failed to embed filmstrip metadata into JPEG for ${compPath}`);
  }
  return { jpeg, ...meta };
}

export interface FilmstripBrowserSession {
  readonly browser: Browser;
  readonly env: Record<string, string>;
  readonly rootDir: string;
  close(): Promise<void>;
}

export interface LaunchFilmstripBrowserOptions {
  readonly executablePath?: string;
  readonly sourceEnv?: NodeJS.ProcessEnv;
  readonly tmpBaseDir?: string;
  /** Test seam for deterministic launcher / isolation verification. */
  readonly launchFn?: typeof puppeteer.launch;
}

export type CompositionCaptureOutcome =
  | { readonly ok: true; readonly sprite: CapturedFilmstripSprite }
  | { readonly ok: false; readonly error: string };

export interface BakeVirtualCompositionsResult {
  readonly results: Map<string, CompositionCaptureOutcome>;
  readonly yielded: boolean;
}

/**
 * Launch headless Chromium inside an isolated ephemeral home/tmp/profile directory using the
 * shared strict render environment allowlist (`buildRenderSubprocessEnv`) so worker secrets
 * (DB/Redis/S3/OIDC/API keys) are never inherited by the browser process.
 */
export async function launchFilmstripBrowser(
  options?: LaunchFilmstripBrowserOptions,
): Promise<FilmstripBrowserSession> {
  const sourceEnv = options?.sourceEnv ?? process.env;
  const executablePath = options?.executablePath ?? detectFilmstripBrowserExecutable(sourceEnv);
  const rootDir = path.join(options?.tmpBaseDir ?? os.tmpdir(), `om-filmstrip-${randomUUID()}`);
  const ephemeralHomeDir = path.join(rootDir, 'home');
  const ephemeralCacheDir = path.join(ephemeralHomeDir, '.cache');
  const ephemeralConfigDir = path.join(ephemeralHomeDir, '.config');
  const ephemeralTmpDir = path.join(rootDir, 'tmp');
  const ephemeralProfileDir = path.join(rootDir, 'profile');
  const cleanupRootDir = () => rm(rootDir, { recursive: true, force: true }).catch(() => {});

  try {
    await Promise.all([
      mkdir(ephemeralCacheDir, { recursive: true, mode: 0o700 }),
      mkdir(ephemeralConfigDir, { recursive: true, mode: 0o700 }),
      mkdir(ephemeralTmpDir, { recursive: true, mode: 0o700 }),
      mkdir(ephemeralProfileDir, { recursive: true, mode: 0o700 }),
    ]);

    const renderEnv = buildRenderSubprocessEnv({
      ephemeralHomeDir,
      ephemeralTmpDir,
      sourceEnv,
    });
    assertRenderSubprocessEnvClean(renderEnv);

    const launchFn = options?.launchFn ?? puppeteer.launch.bind(puppeteer);
    const browser = await launchFn({
      executablePath,
      headless: true,
      env: renderEnv,
      userDataDir: ephemeralProfileDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
      ],
    });

    let closed = false;
    return {
      browser,
      env: renderEnv,
      rootDir,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await browser.close();
        } finally {
          await cleanupRootDir();
        }
      },
    };
  } catch (error) {
    await cleanupRootDir();
    throw error;
  }
}

export async function bakeVirtualCompositionsWithChromium(input: {
  readonly server: VirtualPreviewServerInput;
  readonly targetCompositions: readonly string[];
  readonly executablePath?: string;
  readonly sourceEnv?: NodeJS.ProcessEnv;
  readonly tmpBaseDir?: string;
  readonly launchFn?: typeof puppeteer.launch;
  readonly shouldYield?: () => Promise<boolean> | boolean;
  /** Test seam for observing preview origin without changing capture logic. */
  readonly onPreviewStarted?: (origin: string) => void;
}): Promise<BakeVirtualCompositionsResult> {
  const results = new Map<string, CompositionCaptureOutcome>();
  if (input.targetCompositions.length === 0) return { results, yielded: false };

  let activeCompAssetErrors: string[] | null = null;
  const preview = await startVirtualTemplatePreviewServer({
    ...input.server,
    resolveAsset: async (relPath) => {
      // Bind request ownership to the active composition synchronously at request arrival
      // so a slow asset download that rejects after navigation timeout/abort can never be
      // misattributed to a subsequent healthy sibling composition.
      const ownerErrors = activeCompAssetErrors;
      try {
        return await input.server.resolveAsset(relPath);
      } catch (error) {
        if (ownerErrors) {
          const message = error instanceof Error ? error.message : String(error);
          ownerErrors.push(`${relPath}: ${message}`);
        }
        throw error;
      }
    },
  });
  input.onPreviewStarted?.(preview.origin);

  let browserSession: FilmstripBrowserSession | null = null;
  let yielded = false;
  try {
    browserSession = await launchFilmstripBrowser({
      executablePath: input.executablePath,
      sourceEnv: input.sourceEnv,
      tmpBaseDir: input.tmpBaseDir,
      launchFn: input.launchFn,
    });
    const page = await browserSession.browser.newPage();
    try {
      for (let i = 0; i < input.targetCompositions.length; i += 1) {
        if (i > 0 && input.shouldYield && (await input.shouldYield())) {
          yielded = true;
          break;
        }
        const compPath = input.targetCompositions[i]!;
        const compAssetErrors: string[] = [];
        activeCompAssetErrors = compAssetErrors;
        try {
          const sprite = await captureCompositionFilmstripSprite(page, preview.origin, compPath);
          if (compAssetErrors.length > 0) {
            results.set(compPath, {
              ok: false,
              error: `Requested catalog asset failed to load (${compAssetErrors.join('; ')})`,
            });
          } else {
            results.set(compPath, { ok: true, sprite });
          }
        } catch (error) {
          const baseMessage = error instanceof Error ? error.message : String(error);
          const detail =
            compAssetErrors.length > 0
              ? `${baseMessage} (asset load failures: ${compAssetErrors.join('; ')})`
              : baseMessage;
          results.set(compPath, { ok: false, error: detail });
        } finally {
          activeCompAssetErrors = null;
          await page.goto('about:blank').catch(() => {});
        }
      }
    } finally {
      activeCompAssetErrors = null;
      await page.close().catch(() => {});
    }
  } finally {
    await Promise.allSettled([
      browserSession ? browserSession.close() : Promise.resolve(),
      preview.close(),
    ]);
  }
  return { results, yielded };
}
