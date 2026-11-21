import { createHash } from 'node:crypto';
import type { PluginOption } from 'vite';

export interface ResolvedObservabilityBuildConfig {
  readonly sourcemap: boolean | 'hidden';
  readonly injectDebugIds: boolean;
}

function trimEnv(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBoolEnv(value: string | undefined): boolean | undefined {
  const normalized = trimEnv(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

/**
 * Derives a deterministic RFC 4122 UUID v4 Debug ID from bundle content so
 * builds remain reproducible across `api` and `studio-sourcemaps` Docker targets.
 */
export function deriveDeterministicDebugId(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Generates the standard Sentry/TC39 runtime Debug ID registration snippet.
 * Appended at the end of a JS chunk so existing sourcemap line/column mappings remain unchanged.
 */
export function buildDebugIdFooter(debugId: string): string {
  const snippet = `;(()=>{try{var e=typeof window!="undefined"?window:typeof global!="undefined"?global:typeof globalThis!="undefined"?globalThis:typeof self!="undefined"?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]=${JSON.stringify(debugId)},e._sentryDebugIdIdentifier=${JSON.stringify(`sentry-dbid-${debugId}`)})}catch(e){}})();`;
  return `\n${snippet}\n//# debugId=${debugId}\n`;
}

/**
 * Computes Vite `build.sourcemap` from `STUDIO_SOURCEMAP` and `SENTRY_DEBUG_IDS`:
 * - `SENTRY_DEBUG_IDS=true` forces `'hidden'` so Debug IDs and private `.map` files are always emitted.
 * - `STUDIO_SOURCEMAP=hidden` emits hidden sourcemaps without `//# sourceMappingURL=`.
 * - `STUDIO_SOURCEMAP=false|0` disables sourcemaps (default for non-Sentry container builds).
 * - Unset / `true` preserves standard sourcemaps for local development.
 */
export function resolveStudioSourcemapOption(
  env: NodeJS.ProcessEnv = process.env,
): boolean | 'hidden' {
  if (parseBoolEnv(env.SENTRY_DEBUG_IDS) === true) {
    return 'hidden';
  }

  const raw = trimEnv(env.STUDIO_SOURCEMAP)?.toLowerCase();
  if (raw === 'hidden') return 'hidden';
  if (raw === 'false' || raw === '0') return false;
  return true;
}

/**
 * Resolves sourcemap mode and whether to inject deterministic Debug IDs into emitted
 * JS chunks and `.js.map` files. Enabled automatically whenever `STUDIO_SOURCEMAP=hidden`
 * or `SENTRY_DEBUG_IDS=true` (unless explicitly disabled via `SENTRY_DEBUG_IDS=false`).
 */
export function resolveObservabilityBuildConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedObservabilityBuildConfig {
  const sourcemap = resolveStudioSourcemapOption(env);
  const explicitDebugIds = parseBoolEnv(env.SENTRY_DEBUG_IDS);
  const injectDebugIds = explicitDebugIds ?? sourcemap === 'hidden';
  return {
    sourcemap,
    injectDebugIds,
  };
}

/**
 * Zero-dependency Vite plugin that embeds deterministic Debug IDs into hidden-sourcemap
 * JS bundles and their matching `.js.map` files (TC39 ECMA-426 / Sentry format).
 *
 * Uploading `.js.map` files is intentionally handled externally in release CI/CD
 * (for example via `sentry-cli sourcemaps upload`) so the open-source repository
 * stays free of non-OSI CLI dependencies and build-time upload credentials.
 */
export function createSentryVitePlugins(
  env: NodeJS.ProcessEnv = process.env,
): PluginOption[] {
  const resolved = resolveObservabilityBuildConfig(env);
  if (!resolved.injectDebugIds) return [];

  return [
    {
      name: 'openmotion-observability-debug-ids',
      apply: 'build',
      generateBundle(_options, bundle) {
        for (const item of Object.values(bundle)) {
          if (item.type !== 'chunk' || !item.fileName.endsWith('.js')) continue;
          const mapAsset = bundle[`${item.fileName}.map`];
          if (!mapAsset || mapAsset.type !== 'asset') continue;

          const mapText =
            typeof mapAsset.source === 'string'
              ? mapAsset.source
              : Buffer.from(mapAsset.source).toString('utf8');

          let parsedMap: Record<string, unknown>;
          try {
            parsedMap = JSON.parse(mapText) as Record<string, unknown>;
          } catch {
            continue;
          }

          const debugId =
            typeof parsedMap.debugId === 'string' && parsedMap.debugId
              ? parsedMap.debugId
              : deriveDeterministicDebugId(`${item.fileName}\0${item.code}`);

          parsedMap.debugId = debugId;
          mapAsset.source = JSON.stringify(parsedMap);

          if (!item.code.includes(`//# debugId=${debugId}`)) {
            item.code += buildDebugIdFooter(debugId);
          }
        }
      },
    },
  ];
}
