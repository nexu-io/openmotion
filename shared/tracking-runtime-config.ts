export const TRACKING_RUNTIME_CONFIG_ELEMENT_ID = 'openmotion-tracking-config' as const;
export const TRACKING_RUNTIME_CONFIG_PLACEHOLDER = '<!-- openmotion:tracking-config -->' as const;

export type TracertEnvironment = 'prod' | 'test';
export type TrackingLockReason = 'environment' | 'cloud' | null;

export interface BrowserTracertConfig {
  readonly spmA: string | number;
  readonly endpoint?: string;
  readonly environment: TracertEnvironment;
  readonly appVersion?: string;
}

export interface BrowserTrackingRuntimeConfig {
  readonly enabled: boolean;
  readonly posthogEnabled: boolean;
  readonly locked: boolean;
  readonly reason: TrackingLockReason;
  readonly tracert: BrowserTracertConfig | null;
}

export interface BrowserTracertInput {
  readonly spmA?: string | number | null;
  readonly endpoint?: string | null;
  readonly environment?: string | null;
  readonly appVersion?: string | null;
}

export interface BrowserTrackingRuntimeInput {
  readonly posthogEnabled: boolean;
  readonly locked?: boolean;
  readonly reason?: TrackingLockReason;
  readonly tracert?: BrowserTracertInput | BrowserTracertConfig | null;
}

interface DocumentLike {
  getElementById(id: string): { textContent: string | null } | null;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const POSITIVE_INT_PATTERN = /^[1-9]\d*$/;
const MAX_SPM_A_LENGTH = 256;
const MAX_APP_VERSION_LENGTH = 128;

function trimOptional(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Validates Tracert `spmA` (positive safe integer or non-empty string up to 256 chars).
 * Pure positive integer strings normalize to numbers to match the Collector schema.
 */
export function parseTracertSpmA(raw: unknown): string | number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  const value = trimOptional(raw);
  if (!value || value.length > MAX_SPM_A_LENGTH) return null;
  if (POSITIVE_INT_PATTERN.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;
  }
  return value;
}

/**
 * Validates an optional Tracert collector endpoint override.
 * - `undefined`: omitted (SDK uses its default public collector endpoint).
 * - `string`: validated HTTPS URL, loopback HTTP URL (local tests), or same-origin path (e.g. `/t/events`).
 * - `null`: malformed non-empty value (caller must fail closed).
 */
export function parseTracertEndpoint(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return undefined;
  if (/\s/.test(value)) return null;

  if (value.startsWith('/')) {
    if (value.startsWith('//') || value.includes('?') || value.includes('#')) return null;
    return value;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const isHttps = parsed.protocol === 'https:';
  const isLoopbackHttp = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  if (!isHttps && !isLoopbackHttp) return null;
  return parsed.toString();
}

/**
 * Maps OpenMotion environment labels (`production` / `development` / `test` / `prod`)
 * into the closed set accepted by `@powerformer/tracert` (`prod` | `test`).
 */
export function normalizeTracertEnvironment(
  raw: unknown,
  fallback: TracertEnvironment = 'prod',
): TracertEnvironment {
  const value = trimOptional(raw)?.toLowerCase();
  if (!value) return fallback;
  if (value === 'prod' || value === 'production') return 'prod';
  if (value === 'test' || value === 'development' || value === 'dev' || value === 'staging') return 'test';
  return fallback;
}

/**
 * Produces a validated browser Tracert config, or `null` when unconfigured or invalid.
 * Self-hosted deployments without `OPENMOTION_TRACERT_SPM_A` stay completely disabled.
 */
export function buildBrowserTracertConfig(
  input: BrowserTracertInput | BrowserTracertConfig | null | undefined,
): BrowserTracertConfig | null {
  if (!input) return null;
  const spmA = parseTracertSpmA(input.spmA);
  if (spmA === null) return null;

  const endpoint = parseTracertEndpoint(input.endpoint);
  if (endpoint === null) return null;

  const environment = normalizeTracertEnvironment(input.environment, 'prod');
  const rawVersion = trimOptional(input.appVersion);
  const appVersion = rawVersion && rawVersion.length <= MAX_APP_VERSION_LENGTH ? rawVersion : undefined;

  return Object.freeze({
    spmA,
    ...(endpoint ? { endpoint } : {}),
    environment,
    ...(appVersion ? { appVersion } : {}),
  });
}

export function buildBrowserTrackingRuntimeConfig(
  input: BrowserTrackingRuntimeInput,
): BrowserTrackingRuntimeConfig {
  const posthogEnabled = Boolean(input.posthogEnabled);
  const tracert = buildBrowserTracertConfig(input.tracert);
  const enabled = posthogEnabled || tracert !== null;
  const locked = input.locked ?? true;
  const reason: TrackingLockReason =
    input.reason === 'environment' || input.reason === 'cloud' ? input.reason : null;

  return Object.freeze({
    enabled,
    posthogEnabled,
    locked,
    reason,
    tracert,
  });
}

function escapeJsonForHtmlScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

/**
 * Serializes a CSP-safe `<script type="application/json">` tag for Studio HTML.
 * Returns empty string when telemetry is disabled so self-hosted HTML stays untouched.
 */
export function serializeTrackingRuntimeConfigTag(
  config: BrowserTrackingRuntimeConfig | null,
): string {
  if (!config || !config.enabled) return '';
  const payload = escapeJsonForHtmlScript(config);
  return `<script type="application/json" id="${TRACKING_RUNTIME_CONFIG_ELEMENT_ID}">${payload}</script>`;
}

export function injectTrackingRuntimeConfigIntoHtml(
  html: string,
  config: BrowserTrackingRuntimeConfig | null,
): string {
  const tag = serializeTrackingRuntimeConfigTag(config);
  if (html.includes(TRACKING_RUNTIME_CONFIG_PLACEHOLDER)) {
    return html.replace(TRACKING_RUNTIME_CONFIG_PLACEHOLDER, () => tag);
  }
  if (!tag) return html;
  const headCloseIndex = html.search(/<\/head>/i);
  if (headCloseIndex === -1) return `${tag}${html}`;
  return `${html.slice(0, headCloseIndex)}${tag}\n${html.slice(headCloseIndex)}`;
}

/**
 * Parses either an HTML-injected payload or a `/motion-api/tracking` JSON response.
 * Remains backwards-compatible with minimal `{ enabled: boolean }` responses.
 */
export function parseTrackingRuntimeConfigResponse(
  raw: unknown,
): BrowserTrackingRuntimeConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.enabled !== 'boolean') return null;

  const locked = typeof record.locked === 'boolean' ? record.locked : true;
  const reason: TrackingLockReason =
    record.reason === 'environment' || record.reason === 'cloud' ? record.reason : null;

  const posthogEnabled =
    typeof record.posthogEnabled === 'boolean' ? record.posthogEnabled : true;

  if (!record.enabled) {
    return Object.freeze({
      enabled: false,
      posthogEnabled,
      locked,
      reason,
      tracert: null,
    });
  }

  const tracertRaw =
    record.tracert && typeof record.tracert === 'object' && !Array.isArray(record.tracert)
      ? (record.tracert as BrowserTracertInput)
      : null;
  const tracert = buildBrowserTracertConfig(tracertRaw);

  return Object.freeze({
    enabled: posthogEnabled || tracert !== null,
    posthogEnabled,
    locked,
    reason,
    tracert,
  });
}

export function readTrackingRuntimeConfigFromDocument(
  doc?: DocumentLike | null,
): BrowserTrackingRuntimeConfig | null {
  const target =
    doc !== undefined
      ? doc
      : typeof globalThis !== 'undefined' && 'document' in globalThis
        ? ((globalThis as { document?: DocumentLike }).document ?? null)
        : null;
  if (!target || typeof target.getElementById !== 'function') return null;
  try {
    const el = target.getElementById(TRACKING_RUNTIME_CONFIG_ELEMENT_ID);
    const text = el?.textContent?.trim();
    if (!text) return null;
    return parseTrackingRuntimeConfigResponse(JSON.parse(text));
  } catch {
    return null;
  }
}
