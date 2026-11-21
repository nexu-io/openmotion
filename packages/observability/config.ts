export const RUNTIME_CONFIG_GLOBAL_KEY = '__OPENMOTION_OBSERVABILITY__' as const;
export const RUNTIME_CONFIG_PLACEHOLDER = '<!-- openmotion:observability-config -->' as const;
export const DEFAULT_TRACES_SAMPLE_RATE = 0.1;

export interface BrowserObservabilityConfig {
  readonly dsn: string;
  readonly environment: string;
  readonly release?: string;
  readonly tracesSampleRate: number;
  readonly tracePropagationTargets?: readonly string[];
  readonly previewOrigin?: string | null;
  readonly appVersion?: string;
  readonly deploymentMode?: string;
}

export interface BrowserObservabilityInput {
  readonly dsn?: string | null;
  readonly environment?: string | null;
  readonly release?: string | null;
  readonly tracesSampleRate?: number | string | null;
  readonly tracePropagationTargets?: readonly string[];
  readonly previewOrigin?: string | null;
  readonly appVersion?: string | null;
  readonly deploymentMode?: string | null;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const NUMERIC_PROJECT_ID = /^\d+$/;

function trimOptional(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Validates a Sentry DSN URL (public key in username + numeric project ID path segment).
 * Allows HTTPS everywhere and HTTP only on loopback hosts for local/test ingestion mocks.
 */
export function parseSentryDsn(raw: unknown): string | null {
  const value = trimOptional(raw);
  if (!value || /\s/.test(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const isHttps = parsed.protocol === 'https:';
  const isLoopbackHttp = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  if (!isHttps && !isLoopbackHttp) return null;
  if (!parsed.username || parsed.search || parsed.hash) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  const projectId = segments.at(-1);
  if (!projectId || !NUMERIC_PROJECT_ID.test(projectId)) return null;

  return parsed.toString();
}

export function normalizeSampleRate(raw: unknown, fallback = DEFAULT_TRACES_SAMPLE_RATE): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric < 0) return 0;
  if (numeric > 1) return 1;
  return numeric;
}

function normalizeOrigin(raw: unknown): string | null {
  const value = trimOptional(raw);
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function normalizePropagationTargets(targets: readonly string[] | undefined): readonly string[] | undefined {
  if (!Array.isArray(targets)) return undefined;
  const cleaned = targets
    .map((entry) => trimOptional(entry))
    .filter((entry): entry is string => Boolean(entry));
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Produces a validated browser observability config, or `null` when disabled / missing valid DSN.
 * Never throws so malformed optional config can never prevent Studio from booting.
 */
export function buildBrowserObservabilityConfig(
  input: BrowserObservabilityInput,
): BrowserObservabilityConfig | null {
  const dsn = parseSentryDsn(input.dsn);
  if (!dsn) return null;

  const environment = trimOptional(input.environment) ?? 'production';
  const release = trimOptional(input.release);
  const tracesSampleRate = normalizeSampleRate(input.tracesSampleRate, DEFAULT_TRACES_SAMPLE_RATE);
  const tracePropagationTargets = normalizePropagationTargets(input.tracePropagationTargets);
  const previewOrigin = normalizeOrigin(input.previewOrigin);
  const appVersion = trimOptional(input.appVersion);
  const deploymentMode = trimOptional(input.deploymentMode);

  return Object.freeze({
    dsn,
    environment,
    ...(release ? { release } : {}),
    tracesSampleRate,
    ...(tracePropagationTargets ? { tracePropagationTargets } : {}),
    ...(previewOrigin ? { previewOrigin } : {}),
    ...(appVersion ? { appVersion } : {}),
    ...(deploymentMode ? { deploymentMode } : {}),
  });
}

function escapeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export function serializeRuntimeConfigScript(config: BrowserObservabilityConfig | null): string {
  if (!config) return '';
  const payload = escapeJsonForInlineScript(config);
  return `<script>window.${RUNTIME_CONFIG_GLOBAL_KEY}=Object.freeze(${payload});</script>`;
}

export function injectRuntimeConfigIntoHtml(
  html: string,
  config: BrowserObservabilityConfig | null,
): string {
  const script = serializeRuntimeConfigScript(config);
  if (html.includes(RUNTIME_CONFIG_PLACEHOLDER)) {
    return html.replace(RUNTIME_CONFIG_PLACEHOLDER, () => script);
  }
  if (!script) return html;
  const headCloseIndex = html.search(/<\/head>/i);
  if (headCloseIndex === -1) return `${script}${html}`;
  return `${html.slice(0, headCloseIndex)}${script}\n${html.slice(headCloseIndex)}`;
}

export function readBrowserObservabilityConfig(
  win: unknown = typeof window !== 'undefined' ? window : undefined,
): BrowserObservabilityConfig | null {
  if (!win || typeof win !== 'object') return null;
  const raw = (win as Record<string, unknown>)[RUNTIME_CONFIG_GLOBAL_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  return buildBrowserObservabilityConfig({
    dsn: typeof record.dsn === 'string' ? record.dsn : null,
    environment: typeof record.environment === 'string' ? record.environment : null,
    release: typeof record.release === 'string' ? record.release : null,
    tracesSampleRate:
      typeof record.tracesSampleRate === 'number' || typeof record.tracesSampleRate === 'string'
        ? record.tracesSampleRate
        : null,
    tracePropagationTargets: Array.isArray(record.tracePropagationTargets)
      ? record.tracePropagationTargets.filter((item): item is string => typeof item === 'string')
      : undefined,
    previewOrigin: typeof record.previewOrigin === 'string' ? record.previewOrigin : null,
    appVersion: typeof record.appVersion === 'string' ? record.appVersion : null,
    deploymentMode: typeof record.deploymentMode === 'string' ? record.deploymentMode : null,
  });
}
