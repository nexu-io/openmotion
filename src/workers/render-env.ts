import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isTemplateEntry } from '@hyperframes/core/compiler';
import {
  STUDIO_MANUAL_EDITS_PATH,
  createStudioManualEditsRenderBodyScript,
} from '@hyperframes/studio-server/manual-edits-render-script';
import {
  STUDIO_MOTION_PATH,
  createStudioMotionRenderBodyScript,
} from '@hyperframes/studio-server/studio-motion-render-script';

export { STUDIO_MANUAL_EDITS_PATH, STUDIO_MOTION_PATH };

/**
 * Strict allowlist of environment variables permitted inside untrusted render subprocesses
 * (`hyperframes render`, headless Chromium, FFmpeg invoked during render/thumbnail).
 *
 * CRITICAL SECURITY BOUNDARY:
 * Never inherit `process.env` when spawning user-authored HTML/JS inside Chromium.
 */
export const RENDER_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'NODE_ENV',
  'CONTAINER',
  'NODE_OPTIONS',
  'NODE_DISABLE_COMPILE_CACHE',
  'HYPERFRAMES_NO_TELEMETRY',
  'HYPERFRAMES_NO_UPDATE_CHECK',
  'HYPERFRAMES_NO_AUTO_INSTALL',
  'HYPERFRAMES_GSAP_WRITER',
  'HYPERFRAMES_PREVIEW_HOST',
  'HYPERFRAMES_RENDER_DETACHED',
  'HYPERFRAMES_FONT_CACHE_DIR',
  'HYPERFRAMES_CACHE_DIR',
  'HYPERFRAMES_CONFIG_DIR',
  'HYPERFRAMES_BROWSER_PATH',
  'PRODUCER_HEADLESS_SHELL_PATH',
  'HYPERFRAMES_FFMPEG_PATH',
  'HYPERFRAMES_FFPROBE_PATH',
  'FONTCONFIG_PATH',
  'TZ',
  'LANG',
]);

/**
 * Sensitive environment prefixes/patterns that MUST NEVER appear in any render subprocess env.
 * Checked as defense-in-depth alongside the strict allowlist above.
 */
export const FORBIDDEN_RENDER_ENV_PATTERNS: readonly RegExp[] = [
  /^DATABASE_URL$/i,
  /^PG/i,
  /^REDIS_/i,
  /^S3_/i,
  /^AWS_/i,
  /^R2_/i,
  /^OPENDESIGN_/i,
  /^OIDC_/i,
  /^SESSION_SECRET$/i,
  /^DEV_PAT$/i,
  /^DEV_AUTH_TOKEN$/i,
  /^MCP_/i,
  /^JWT_/i,
  /^OPENAI_/i,
  /^GEMINI_/i,
  /^GOOGLE_/i,
  /^ANTHROPIC_/i,
  /^HEYGEN_/i,
  /^ELEVENLABS_/i,
  /^MINIMAX_/i,
  /^FAL_/i,
  /(SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)/i,
];

export interface RenderSubprocessEnvOptions {
  ephemeralHomeDir: string;
  ephemeralTmpDir: string;
  fontCacheDir?: string;
  captureFixUrl?: string;
  sourceEnv?: NodeJS.ProcessEnv;
  extraSafeEnv?: {
    lang?: string;
    tz?: string;
    fontconfigPath?: string;
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build a strictly allowlisted environment dictionary for `hyperframes render` / Chromium / FFmpeg.
 * Explicitly strips ALL secrets (`DATABASE_URL`, `REDIS_URL`, `S3_*`, `AWS_*`, `OPENDESIGN_*`,
 * `OIDC_*`, `SESSION_SECRET`, `DEV_PAT`, etc.) by never inheriting `process.env`.
 */
export function buildRenderSubprocessEnv(options: RenderSubprocessEnvOptions): Record<string, string> {
  const sourceEnv = options.sourceEnv ?? process.env;
  const captureFixUrl =
    options.captureFixUrl ?? new URL('../../shared/hyperframes-capture-fix.mjs', import.meta.url).href;
  const fontCacheDir = nonEmpty(options.fontCacheDir) ?? '/tmp/hf-font-cache';
  const cacheDir = path.join(options.ephemeralHomeDir, '.cache');
  const configDir = path.join(options.ephemeralHomeDir, '.config');

  const env: Record<string, string> = {
    PATH: nonEmpty(sourceEnv.PATH) ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: options.ephemeralHomeDir,
    TMPDIR: options.ephemeralTmpDir,
    NODE_ENV: 'production',
    CONTAINER: 'true',
    NODE_OPTIONS: `--import=${captureFixUrl}`,
    HYPERFRAMES_NO_TELEMETRY: '1',
    HYPERFRAMES_NO_UPDATE_CHECK: '1',
    HYPERFRAMES_NO_AUTO_INSTALL: '1',
    HYPERFRAMES_GSAP_WRITER: 'acorn',
    HYPERFRAMES_PREVIEW_HOST: '127.0.0.1',
    HYPERFRAMES_RENDER_DETACHED: '1',
    HYPERFRAMES_FONT_CACHE_DIR: fontCacheDir,
    HYPERFRAMES_CACHE_DIR: cacheDir,
    HYPERFRAMES_CONFIG_DIR: configDir,
    TZ: nonEmpty(options.extraSafeEnv?.tz) ?? nonEmpty(sourceEnv.TZ) ?? 'UTC',
    LANG: nonEmpty(options.extraSafeEnv?.lang) ?? nonEmpty(sourceEnv.LANG) ?? 'C.UTF-8',
  };

  if (process.platform === 'win32') {
    env.NODE_DISABLE_COMPILE_CACHE = '1';
  }

  const browserPath = nonEmpty(sourceEnv.HYPERFRAMES_BROWSER_PATH);
  if (browserPath) {
    env.HYPERFRAMES_BROWSER_PATH = browserPath;
  }

  const headlessShellPath = nonEmpty(sourceEnv.PRODUCER_HEADLESS_SHELL_PATH);
  if (headlessShellPath) {
    env.PRODUCER_HEADLESS_SHELL_PATH = headlessShellPath;
  }

  const ffmpegPath = nonEmpty(sourceEnv.HYPERFRAMES_FFMPEG_PATH) ?? nonEmpty(sourceEnv.FFMPEG_PATH);
  if (ffmpegPath) {
    env.HYPERFRAMES_FFMPEG_PATH = ffmpegPath;
  }

  const ffprobePath = nonEmpty(sourceEnv.HYPERFRAMES_FFPROBE_PATH) ?? nonEmpty(sourceEnv.FFPROBE_PATH);
  if (ffprobePath) {
    env.HYPERFRAMES_FFPROBE_PATH = ffprobePath;
  }

  const fontconfigPath =
    nonEmpty(options.extraSafeEnv?.fontconfigPath) ?? nonEmpty(sourceEnv.FONTCONFIG_PATH);
  if (fontconfigPath) {
    env.FONTCONFIG_PATH = fontconfigPath;
  }

  assertRenderSubprocessEnvClean(env);
  return env;
}

/**
 * Defense-in-depth assertion guaranteeing that a render subprocess environment contains
 * zero forbidden or non-allowlisted keys before spawning Chromium/Hyperframes.
 */
export function assertRenderSubprocessEnvClean(env: Readonly<Record<string, string | undefined>>): void {
  const violations: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!RENDER_ENV_ALLOWLIST.has(key)) {
      violations.push(`non-allowlisted key "${key}"`);
      continue;
    }
    if (FORBIDDEN_RENDER_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
      violations.push(`forbidden secret key "${key}"`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`RENDER_ENV_SECURITY_VIOLATION: Refusing render spawn with ${violations.join(', ')}`);
  }
}

function escapeInlineScriptBody(scriptBody: string): string {
  // Prevent a literal closing script tag or HTML comment opener inside JSON strings
  // from breaking out of the injected <script> tag.
  return scriptBody.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

export interface StudioRenderParityInput {
  manualEditsJson?: string | null;
  studioMotionJson?: string | null;
  activeCompositionPath?: string | null;
}

export interface StudioRenderParityResult {
  html: string;
  injectedManualEdits: boolean;
  injectedStudioMotion: boolean;
}

/**
 * Inject Hyperframes Studio manual-edits and studio-motion render body scripts into an
 * ephemeral entry HTML string right before `</body>` so CLI `hyperframes render` achieves
 * byte-accurate parity with Studio preview (#9 §6.3 / #11 §5).
 */
export function injectStudioRenderParityScripts(
  html: string,
  options: StudioRenderParityInput,
): StudioRenderParityResult {
  const scripts: string[] = [];
  let injectedManualEdits = false;
  let injectedStudioMotion = false;
  const scriptOptions = { activeCompositionPath: options.activeCompositionPath ?? null };

  if (typeof options.manualEditsJson === 'string' && options.manualEditsJson.trim().length > 0) {
    const body = createStudioManualEditsRenderBodyScript(options.manualEditsJson, scriptOptions);
    if (body) {
      scripts.push(
        `<script data-om-render-parity="studio-manual-edits">${escapeInlineScriptBody(body)}</script>`,
      );
      injectedManualEdits = true;
    }
  }

  if (typeof options.studioMotionJson === 'string' && options.studioMotionJson.trim().length > 0) {
    const body = createStudioMotionRenderBodyScript(options.studioMotionJson, scriptOptions);
    if (body) {
      scripts.push(
        `<script data-om-render-parity="studio-motion">${escapeInlineScriptBody(body)}</script>`,
      );
      injectedStudioMotion = true;
    }
  }

  if (scripts.length === 0) {
    return { html, injectedManualEdits: false, injectedStudioMotion: false };
  }

  const block = `\n${scripts.join('\n')}\n`;
  const bodyCloseMatch = /<\/body\s*>/i.exec(html);
  let patchedHtml: string;
  if (bodyCloseMatch && bodyCloseMatch.index !== undefined) {
    // Insert right before the final </body> tag if multiple appear in comments/templates.
    const matches = [...html.matchAll(/<\/body\s*>/gi)];
    const last = matches.at(-1);
    const insertAt = last?.index ?? bodyCloseMatch.index;
    patchedHtml = `${html.slice(0, insertAt)}${block}${html.slice(insertAt)}`;
  } else if (isTemplateEntry(html)) {
    // Sub-scenes wrapped in <template> are read via template.innerHTML during render;
    // scripts appended after </template> would be discarded.
    const matches = [...html.matchAll(/<\/template\s*>/gi)];
    const last = matches.at(-1);
    if (last?.index !== undefined) {
      patchedHtml = `${html.slice(0, last.index)}${block}${html.slice(last.index)}`;
    } else {
      patchedHtml = `${html}${block}`;
    }
  } else {
    patchedHtml = `${html}${block}`;
  }

  return {
    html: patchedHtml,
    injectedManualEdits,
    injectedStudioMotion,
  };
}

async function readOptionalUtf8(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Read `.hyperframes/studio-manual-edits.json` and `.hyperframes/studio-motion.json`
 * from an ephemeral hydrated `/tmp` directory and inject their render runtime scripts into
 * the ephemeral copy of the target entry HTML file (never modifying PG or S3 snapshots).
 */
export async function injectStudioRenderParityIntoHydratedDir(
  projectDir: string,
  compositionPath = 'index.html',
): Promise<{ injectedManualEdits: boolean; injectedStudioMotion: boolean }> {
  const normalizedComposition = compositionPath.replace(/^\/+/, '') || 'index.html';
  const entryFullPath = path.resolve(projectDir, normalizedComposition);
  const resolvedRoot = path.resolve(projectDir);
  if (entryFullPath !== resolvedRoot && !entryFullPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`INVALID_PATH: Composition path escapes hydrated render directory: ${compositionPath}`);
  }

  const [manualEditsJson, studioMotionJson] = await Promise.all([
    readOptionalUtf8(path.join(resolvedRoot, STUDIO_MANUAL_EDITS_PATH)),
    readOptionalUtf8(path.join(resolvedRoot, STUDIO_MOTION_PATH)),
  ]);

  if (!manualEditsJson && !studioMotionJson) {
    return { injectedManualEdits: false, injectedStudioMotion: false };
  }

  const originalHtml = await readFile(entryFullPath, 'utf8');
  const injected = injectStudioRenderParityScripts(originalHtml, {
    manualEditsJson,
    studioMotionJson,
    activeCompositionPath: normalizedComposition,
  });

  if (injected.injectedManualEdits || injected.injectedStudioMotion) {
    await writeFile(entryFullPath, injected.html, 'utf8');
  }

  return {
    injectedManualEdits: injected.injectedManualEdits,
    injectedStudioMotion: injected.injectedStudioMotion,
  };
}
