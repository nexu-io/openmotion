/**
 * Zero-dependency, default-off Electron Main-Process Sentry Envelope Reporter
 * and native `crashReporter` integration.
 *
 * Design principles (aligned with `@openmotion/observability`):
 * - Default-off: without a valid DSN (or when `DO_NOT_TRACK=1` / `OPENMOTION_TELEMETRY=0`),
 *   zero outbound requests are made and `crashReporter` is never started.
 * - Zero preload / IPC footprint: never injects code into renderer windows, popups,
 *   iframes, or `/auth/*` routes — preserving strict thin-shell isolation.
 * - Strict scrubbing: strips local filesystem paths, Bearer tokens, credentials, and
 *   query parameters using both `redactDesktopText` and `@openmotion/observability/sanitize`.
 * - Bounded sliding-window rate limiting prevents crash loops from flooding ingest.
 * - Store and forward: an envelope that cannot be delivered (offline, proxy down, ingest 5xx)
 *   is kept in a small bounded outbox and retried later, because the failures worth reporting
 *   are often the ones that happen while the network is unavailable.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_PRODUCT_NAME } from '../../shared/desktop-builtin-rules.ts';
import type { HostPlatform, HostReleaseChannel } from '../../shared/desktop-contract.ts';
import { parseSentryDsn } from '../../packages/observability/config.ts';
import {
  sanitizeSentryBreadcrumb,
  sanitizeSentryEvent,
  sanitizeText,
  type SentryLikeBreadcrumb,
  type SentryLikeEvent,
} from '../../packages/observability/sanitize.ts';
import { redactDesktopText } from './logger.ts';

const DEFAULT_MAX_EVENTS_PER_MINUTE = 20;
const DEFAULT_SEND_TIMEOUT_MS = 4_000;
const DEFAULT_MAX_BREADCRUMBS = 50;
const RATE_WINDOW_MS = 60_000;
const OUTBOX_MAX_ITEMS = 20;
const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type OutboxItem = { at: number; body: string };

export type ParsedSentryEndpoints = {
  dsn: string;
  envelopeUrl: string;
  minidumpUrl: string;
  publicKey: string;
  projectId: string;
};

declare const __OPENMOTION_DESKTOP_SENTRY_DSN__: string | undefined;

/**
 * Resolves the DSN for this shell: a runtime environment override first (local
 * development and ingest mocks), then the value `desktop/scripts/build.mjs`
 * embeds at build time. Unbundled runs carry no embedded value.
 */
export function resolveDesktopSentryDsn(
  env: NodeJS.ProcessEnv = process.env,
  embedded: string | undefined = typeof __OPENMOTION_DESKTOP_SENTRY_DSN__ === 'string'
    ? __OPENMOTION_DESKTOP_SENTRY_DSN__
    : undefined,
): string | undefined {
  const fromEnv = env.SENTRY_DESKTOP_DSN?.trim() || env.OPENMOTION_DESKTOP_SENTRY_DSN?.trim();
  return fromEnv || embedded?.trim() || undefined;
}

export type ElectronCrashReporterLike = {
  start: (options: {
    submitURL: string;
    productName?: string;
    compress?: boolean;
    uploadToServer?: boolean;
    ignoreSystemCrashHandler?: boolean;
    extra?: Record<string, string>;
    globalExtra?: Record<string, string>;
  }) => void;
  setUploadToServer?: (uploadToServer: boolean) => void;
};

export type DesktopSentryReporterOptions = {
  dsn?: string | null;
  environment?: string;
  release: string;
  channel: HostReleaseChannel;
  platform: HostPlatform;
  arch: string;
  shellVersion: string;
  /** Directory containing bundled desktop JS (`dist/main.mjs`) for `app:///dist/...` frame normalization. */
  appDistDir?: string;
  redactPaths?: readonly string[];
  /** File that holds undelivered envelopes; store and forward is off when unset. */
  outboxPath?: string;
  /** Returns the random per-install UUID while sharing is enabled so Sentry tracks affected users. */
  getInstallId?: () => string | undefined;
  /** Runtime metadata attached to Sentry contexts and native crash `globalExtra`. */
  osVersion?: string;
  electronVersion?: string;
  chromeVersion?: string;
  nodeVersion?: string;
  appStartTime?: number;
  maxBreadcrumbs?: number;
  /** Override for `globalThis._sentryDebugIds` (for deterministic testing). */
  debugIds?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  maxEventsPerMinute?: number;
  sendTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Called for every event captured while reporting is on, before it is sent. */
  onCapture?: (level: 'info' | 'warning' | 'error' | 'fatal') => void;
  /** Called when reporting is turned off, so callers can erase what they kept for it. */
  onDisabled?: () => void;
};

/** One update of a release-health session; times are epoch milliseconds. */
export type DesktopSentrySessionUpdate = {
  sid: string;
  did?: string;
  init: boolean;
  startedAt: number;
  timestamp: number;
  status: 'ok' | 'exited' | 'crashed' | 'abnormal';
  errors: number;
  durationSeconds?: number;
  release: string;
};

export type DesktopSentryBreadcrumbInput = {
  category: string;
  message?: string;
  level?: 'debug' | 'info' | 'warning' | 'error' | 'fatal';
  type?: string;
  data?: Record<string, unknown>;
};

export type DesktopSentrySpanInput = {
  op: string;
  description?: string;
  /** Epoch milliseconds. */
  startMs: number;
  /** Epoch milliseconds. */
  endMs: number;
  status?: 'ok' | 'cancelled' | 'unknown_error' | 'deadline_exceeded' | 'internal_error' | 'unavailable';
  data?: Record<string, unknown>;
};

export type DesktopSentryTransactionInput = {
  name: string;
  op: string;
  /** Epoch milliseconds. */
  startMs: number;
  /** Epoch milliseconds. */
  endMs: number;
  status?: 'ok' | 'cancelled' | 'unknown_error' | 'deadline_exceeded' | 'internal_error' | 'unavailable';
  tags?: Record<string, string>;
  data?: Record<string, unknown>;
  measurements?: Record<string, { value: number; unit?: 'millisecond' | 'second' | 'none' | 'ratio' }>;
  spans?: readonly DesktopSentrySpanInput[];
};

export type DesktopSentryCaptureContext = {
  area?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
};

export type DesktopSentryReporter = {
  isEnabled: () => boolean;
  setEnabled: (enabled: boolean) => void;
  getEndpoints: () => ParsedSentryEndpoints | null;
  /** Records a scrubbed breadcrumb in the bounded ring buffer attached to future events. */
  addBreadcrumb: (crumb: DesktopSentryBreadcrumbInput) => void;
  /** Retries undelivered envelopes; resolves with how many were delivered. */
  flushOutbox: () => Promise<number>;
  startCrashReporter: (crashReporter: ElectronCrashReporterLike) => boolean;
  captureException: (error: unknown, context?: DesktopSentryCaptureContext) => Promise<boolean>;
  captureMessage: (
    message: string,
    level?: 'info' | 'warning' | 'error' | 'fatal',
    context?: DesktopSentryCaptureContext,
  ) => Promise<boolean>;
  /** Sends a performance transaction envelope (e.g. cold startup timings); queued on transient failures. */
  captureTransaction: (transaction: DesktopSentryTransactionInput) => Promise<boolean>;
  /** Sends a release-health session update; undeliverable updates wait in the outbox. */
  sendSession: (update: DesktopSentrySessionUpdate) => Promise<boolean>;
};

function isOptedOutByEnv(env: NodeJS.ProcessEnv): boolean {
  const dnt = env.DO_NOT_TRACK?.trim().toLowerCase();
  if (dnt === '1' || dnt === 'true') return true;
  const flag = env.OPENMOTION_TELEMETRY?.trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return true;
  return false;
}

function resolveOsDisplayName(platform: HostPlatform): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  return 'Linux';
}

/**
 * Parses a validated Sentry DSN into its Envelope ingest and Crashpad minidump URLs.
 */
export function parseSentryEnvelopeEndpoints(rawDsn: unknown): ParsedSentryEndpoints | null {
  const validated = parseSentryDsn(rawDsn);
  if (!validated) return null;
  const parsed = new URL(validated);
  const publicKey = parsed.username;
  const segments = parsed.pathname.split('/').filter(Boolean);
  const projectId = segments.at(-1);
  if (!publicKey || !projectId) return null;
  const prefixSegments = segments.slice(0, -1);
  const basePath = prefixSegments.length > 0 ? `/${prefixSegments.join('/')}` : '';
  const apiBase = `${parsed.origin}${basePath}/api/${projectId}`;

  return {
    dsn: validated,
    envelopeUrl: `${apiBase}/envelope/`,
    minidumpUrl: `${apiBase}/minidump/?sentry_key=${encodeURIComponent(publicKey)}`,
    publicKey,
    projectId,
  };
}

function scrubString(value: string, redactPaths: readonly string[]): string {
  return sanitizeText(redactDesktopText(value, [...redactPaths]));
}

function scrubUnknown(
  value: unknown,
  redactPaths: readonly string[],
  depth = 0,
): unknown {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return scrubString(value, redactPaths);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => scrubUnknown(item, redactPaths, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      if (/(?:token|secret|password|authorization|cookie|key|credential)/i.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = scrubUnknown(v, redactPaths, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function normalizeDistFramePath(rawPath: string, appDistDir?: string): string | null {
  if (!appDistDir) return null;
  let candidate = rawPath.trim();
  if (candidate.startsWith('file://')) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      candidate = candidate.replace(/^file:\/\//i, '');
    }
  }
  const normalizedDist = path.resolve(appDistDir).replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedCandidate = candidate.replace(/\\/g, '/');
  const distLower = normalizedDist.toLowerCase();
  const candLower = normalizedCandidate.toLowerCase();
  if (candLower === distLower) return 'app:///dist';
  if (candLower.startsWith(`${distLower}/`)) {
    const rel = normalizedCandidate.slice(normalizedDist.length + 1);
    return `app:///dist/${rel}`;
  }
  return null;
}

function extractFramePathFromStackLine(trimmed: string): string | null {
  const match = /^at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(trimmed);
  return match?.[2] ?? null;
}

function parseStackFrames(
  stack: string | undefined,
  redactPaths: readonly string[],
  appDistDir?: string,
) {
  if (!stack) return undefined;
  const frames: Array<{
    filename: string;
    abs_path?: string;
    in_app?: boolean;
    function?: string;
    lineno?: number;
    colno?: number;
  }> = [];
  for (const line of stack.split('\n').slice(1, 25)) {
    const trimmed = line.trim();
    const match = /^at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(trimmed);
    if (!match) continue;
    const fnName = match[1]?.trim();
    const rawFile = match[2] ?? '<unknown>';
    const appFrame = normalizeDistFramePath(rawFile, appDistDir);
    const filename = appFrame ?? scrubString(rawFile, redactPaths);
    const lineno = Number.parseInt(match[3] ?? '', 10);
    const colno = Number.parseInt(match[4] ?? '', 10);
    frames.push({
      filename,
      ...(appFrame ? { abs_path: appFrame, in_app: true } : {}),
      ...(fnName ? { function: fnName } : {}),
      ...(Number.isFinite(lineno) ? { lineno } : {}),
      ...(Number.isFinite(colno) ? { colno } : {}),
    });
  }
  if (frames.length === 0) return undefined;
  // Sentry expects frames oldest-first.
  return frames.reverse();
}

export type SentryDebugMetaImage = {
  type: 'sourcemap';
  code_file: string;
  debug_id: string;
};

/**
 * Extracts Sentry sourcemap `debug_meta.images` entries from TC39/Sentry `_sentryDebugIds`.
 */
export function extractDebugMetaImages(
  debugIds: Record<string, string> | undefined,
  appDistDir?: string,
): SentryDebugMetaImage[] {
  if (!debugIds || typeof debugIds !== 'object') return [];
  const seen = new Set<string>();
  const images: SentryDebugMetaImage[] = [];
  for (const [stack, debugId] of Object.entries(debugIds)) {
    if (typeof debugId !== 'string' || !debugId.trim()) continue;
    let codeFile: string | null = null;
    for (const line of stack.split('\n').slice(1)) {
      const rawPath = extractFramePathFromStackLine(line.trim());
      if (!rawPath) continue;
      const appFrame = normalizeDistFramePath(rawPath, appDistDir);
      if (appFrame) {
        codeFile = appFrame;
        break;
      }
      if (!codeFile && /\.(?:mjs|cjs|js)$/i.test(rawPath)) {
        codeFile = `app:///dist/${path.posix.basename(rawPath.replace(/\\/g, '/'))}`;
      }
    }
    if (!codeFile) continue;
    const key = `${codeFile}\0${debugId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    images.push({ type: 'sourcemap', code_file: codeFile, debug_id: debugId.trim() });
  }
  return images;
}

export function createDesktopSentryReporter(
  options: DesktopSentryReporterOptions,
): DesktopSentryReporter {
  const env = options.env ?? process.env;
  const endpoints = parseSentryEnvelopeEndpoints(options.dsn);
  const redactPaths = options.redactPaths ?? [];
  const maxEventsPerMinute = Math.max(1, options.maxEventsPerMinute ?? DEFAULT_MAX_EVENTS_PER_MINUTE);
  const sendTimeoutMs = Math.max(500, options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS);
  const maxBreadcrumbs = Math.max(1, options.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS);
  const now = options.now ?? (() => Date.now());
  const environment = options.environment?.trim() || (options.channel === 'stable' ? 'production' : options.channel);
  const osName = resolveOsDisplayName(options.platform);
  const osVersion = options.osVersion?.trim() || os.release();
  const electronVersion =
    options.electronVersion !== undefined ? options.electronVersion.trim() : process.versions.electron ?? '';
  const chromeVersion =
    options.chromeVersion !== undefined ? options.chromeVersion.trim() : process.versions.chrome ?? '';
  const nodeVersion =
    options.nodeVersion !== undefined ? options.nodeVersion.trim() : process.versions.node ?? '';
  const appStartTimeIso = new Date(options.appStartTime ?? now()).toISOString();

  let runtimeEnabled = Boolean(endpoints) && !isOptedOutByEnv(env);
  let crashReporterStarted = false;
  let crashReporterRef: ElectronCrashReporterLike | null = null;
  const recentSendTimestamps: number[] = [];
  const breadcrumbs: SentryLikeBreadcrumb[] = [];

  const isEnabled = (): boolean => Boolean(endpoints) && runtimeEnabled && !isOptedOutByEnv(env);

  const allowRateLimitedSend = (): boolean => {
    const currentMs = now();
    while (recentSendTimestamps.length > 0 && currentMs - recentSendTimestamps[0]! >= RATE_WINDOW_MS) {
      recentSendTimestamps.shift();
    }
    if (recentSendTimestamps.length >= maxEventsPerMinute) {
      return false;
    }
    recentSendTimestamps.push(currentMs);
    return true;
  };

  const outboxPath = options.outboxPath;
  let flushingOutbox = false;

  const readOutbox = (): OutboxItem[] => {
    if (!outboxPath) return [];
    try {
      const parsed = JSON.parse(readFileSync(outboxPath, 'utf8')) as { items?: unknown };
      if (!Array.isArray(parsed.items)) return [];
      return parsed.items.filter(
        (item): item is OutboxItem =>
          Boolean(item) &&
          typeof (item as OutboxItem).at === 'number' &&
          typeof (item as OutboxItem).body === 'string' &&
          now() - (item as OutboxItem).at <= OUTBOX_MAX_AGE_MS,
      );
    } catch {
      return [];
    }
  };

  const writeOutbox = (items: OutboxItem[]): void => {
    if (!outboxPath) return;
    try {
      if (items.length === 0) {
        rmSync(outboxPath, { force: true });
        return;
      }
      mkdirSync(path.dirname(outboxPath), { recursive: true });
      writeFileSync(
        outboxPath,
        JSON.stringify({ version: 1, items: items.slice(-OUTBOX_MAX_ITEMS) }),
        { encoding: 'utf8', mode: 0o600 },
      );
    } catch {
      // Reporting must never break the shell; an unwritable outbox only loses retries.
    }
  };

  const enqueue = (body: string): void => {
    if (!outboxPath) return;
    writeOutbox([...readOutbox(), { at: now(), body }]);
  };

  const postEnvelope = async (body: string): Promise<'sent' | 'retry' | 'drop'> => {
    if (!endpoints) return 'drop';
    const fetchFn = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchFn !== 'function') return 'drop';
    try {
      const response = await fetchFn(endpoints.envelopeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=openmotion-desktop/${options.shellVersion}, sentry_key=${endpoints.publicKey}`,
        },
        body,
        signal: AbortSignal.timeout(sendTimeoutMs),
      });
      if (response.ok) return 'sent';
      // Ingest rejected the payload itself: retrying the same bytes cannot succeed.
      return response.status >= 500 || response.status === 429 ? 'retry' : 'drop';
    } catch {
      return 'retry';
    }
  };

  /**
   * Sentry reads `sent_at` as the client clock at the moment of sending and shifts the
   * event time by its distance from the receive time. A delayed envelope must therefore
   * carry the time of the actual attempt, or the failure is dated to when it was delivered.
   */
  const withCurrentSentAt = (body: string): string => {
    const headerEnd = body.indexOf('\n');
    if (headerEnd < 0) return body;
    try {
      const header = JSON.parse(body.slice(0, headerEnd)) as Record<string, unknown>;
      return JSON.stringify({ ...header, sent_at: new Date(now()).toISOString() }) + body.slice(headerEnd);
    } catch {
      return body;
    }
  };

  const flushOutbox = async (): Promise<number> => {
    if (!endpoints || !outboxPath || !isEnabled() || flushingOutbox) return 0;
    flushingOutbox = true;
    try {
      const pending = readOutbox();
      const undelivered: OutboxItem[] = [];
      let delivered = 0;
      for (let index = 0; index < pending.length; index += 1) {
        const result = await postEnvelope(withCurrentSentAt(pending[index]!.body));
        if (result === 'sent') {
          delivered += 1;
        } else if (result === 'retry') {
          // Still unreachable: keep this and everything after it for the next attempt.
          undelivered.push(...pending.slice(index));
          break;
        }
      }
      const queuedMeanwhile = readOutbox().filter(
        item => !pending.some(known => known.at === item.at && known.body === item.body),
      );
      writeOutbox([...undelivered, ...queuedMeanwhile]);
      return delivered;
    } finally {
      flushingOutbox = false;
    }
  };

  const resolveInstallId = (): string | undefined => {
    try {
      const id = options.getInstallId?.()?.trim();
      return id || undefined;
    } catch {
      return undefined;
    }
  };

  const baseContexts = (): Record<string, unknown> => ({
    os: {
      name: osName,
      version: osVersion,
    },
    ...(electronVersion ? { runtime: { name: 'Electron', version: electronVersion } } : {}),
    ...(nodeVersion ? { node: { name: 'Node', version: nodeVersion } } : {}),
    ...(chromeVersion ? { chrome: { name: 'Chrome', version: chromeVersion } } : {}),
    device: {
      arch: options.arch,
    },
    app: {
      app_name: DESKTOP_PRODUCT_NAME,
      app_version: options.shellVersion,
      app_start_time: appStartTimeIso,
    },
  });

  const resolveDebugMeta = (): { images: SentryDebugMetaImage[] } | undefined => {
    const rawDebugIds =
      options.debugIds ??
      ((globalThis as Record<string, unknown>)._sentryDebugIds as Record<string, string> | undefined);
    const images = extractDebugMetaImages(rawDebugIds, options.appDistDir);
    return images.length > 0 ? { images } : undefined;
  };

  const baseTags = (context?: DesktopSentryCaptureContext): Record<string, string> => ({
    host_kind: 'desktop',
    release_channel: options.channel,
    host_platform: options.platform,
    host_arch: options.arch,
    shell_version: options.shellVersion,
    ...(context?.area ? { area: context.area } : {}),
    ...(context?.tags ?? {}),
  });

  const addBreadcrumb = (crumb: DesktopSentryBreadcrumbInput): void => {
    if (!isEnabled()) return;
    const raw: SentryLikeBreadcrumb = {
      timestamp: now() / 1000,
      category: crumb.category,
      type: crumb.type ?? 'default',
      level: crumb.level ?? 'info',
      ...(crumb.message ? { message: scrubString(crumb.message, redactPaths) } : {}),
      ...(crumb.data
        ? { data: scrubUnknown(crumb.data, redactPaths) as Record<string, unknown> }
        : {}),
    };
    const sanitized = sanitizeSentryBreadcrumb(raw, {
      dsnOrigin: endpoints ? new URL(endpoints.dsn).origin : null,
    });
    if (!sanitized) return;
    breadcrumbs.push(sanitized);
    if (breadcrumbs.length > maxBreadcrumbs) {
      breadcrumbs.splice(0, breadcrumbs.length - maxBreadcrumbs);
    }
  };

  const sendEvent = async (eventBody: SentryLikeEvent): Promise<boolean> => {
    if (!endpoints || !isEnabled()) return false;
    if (!allowRateLimitedSend()) return false;

    const installId = resolveInstallId();
    const debugMeta = eventBody.exception ? resolveDebugMeta() : undefined;
    const enriched: SentryLikeEvent = {
      ...eventBody,
      contexts: {
        ...baseContexts(),
        ...(eventBody.contexts ?? {}),
      },
      ...(installId ? { user: { id: installId } } : {}),
      ...(breadcrumbs.length > 0 ? { breadcrumbs: [...breadcrumbs] } : {}),
      ...(debugMeta ? { debug_meta: debugMeta } : {}),
    };

    const sanitized = sanitizeSentryEvent(enriched, {
      dsnOrigin: new URL(endpoints.dsn).origin,
    });
    const eventId = randomBytes(16).toString('hex');
    const sentAt = new Date(now()).toISOString();
    const payload = {
      ...sanitized,
      event_id: eventId,
      timestamp: now() / 1000,
      platform: 'node',
      release: options.release,
      environment,
    };

    const envelopeHeader = JSON.stringify({
      event_id: eventId,
      sent_at: sentAt,
      dsn: endpoints.dsn,
    });
    const itemHeader = JSON.stringify({ type: 'event' });
    const itemPayload = JSON.stringify(payload);
    const body = `${envelopeHeader}\n${itemHeader}\n${itemPayload}\n`;

    const result = await postEnvelope(body);
    if (result === 'retry') enqueue(body);
    return result === 'sent';
  };

  const captureTransaction = async (tx: DesktopSentryTransactionInput): Promise<boolean> => {
    if (!endpoints || !isEnabled()) return false;
    if (!allowRateLimitedSend()) return false;

    const eventId = randomBytes(16).toString('hex');
    const traceId = randomBytes(16).toString('hex');
    const rootSpanId = randomBytes(8).toString('hex');
    const startSec = tx.startMs / 1000;
    const endSec = Math.max(tx.startMs, tx.endMs) / 1000;
    const installId = resolveInstallId();

    const spans = (tx.spans ?? []).map(span => {
      const spanStart = Math.max(tx.startMs, span.startMs) / 1000;
      const spanEnd = Math.max(spanStart, span.endMs / 1000);
      return {
        trace_id: traceId,
        span_id: randomBytes(8).toString('hex'),
        parent_span_id: rootSpanId,
        op: span.op,
        ...(span.description ? { description: scrubString(span.description, redactPaths) } : {}),
        start_timestamp: spanStart,
        timestamp: spanEnd,
        status: span.status ?? 'ok',
        origin: 'manual',
        ...(span.data ? { data: scrubUnknown(span.data, redactPaths) as Record<string, unknown> } : {}),
      };
    });

    const eventBody: SentryLikeEvent = {
      type: 'transaction',
      transaction: tx.name,
      transaction_info: { source: 'custom' },
      tags: baseTags({ tags: tx.tags }),
      contexts: {
        ...baseContexts(),
        trace: {
          trace_id: traceId,
          span_id: rootSpanId,
          op: tx.op,
          status: tx.status ?? 'ok',
          origin: 'manual',
          ...(tx.data ? { data: scrubUnknown(tx.data, redactPaths) as Record<string, unknown> } : {}),
        },
      },
      ...(installId ? { user: { id: installId } } : {}),
      ...(tx.measurements && Object.keys(tx.measurements).length > 0
        ? { measurements: tx.measurements }
        : {}),
      spans,
    };

    const sanitized = sanitizeSentryEvent(eventBody, {
      dsnOrigin: new URL(endpoints.dsn).origin,
    });
    const sentAt = new Date(now()).toISOString();
    const payload = {
      ...sanitized,
      event_id: eventId,
      start_timestamp: startSec,
      timestamp: endSec,
      platform: 'node',
      release: options.release,
      environment,
    };

    const envelopeHeader = JSON.stringify({
      event_id: eventId,
      sent_at: sentAt,
      dsn: endpoints.dsn,
      trace: {
        trace_id: traceId,
        public_key: endpoints.publicKey,
        release: options.release,
        environment,
        transaction: tx.name,
      },
    });
    const itemHeader = JSON.stringify({ type: 'transaction' });
    const itemPayload = JSON.stringify(payload);
    const body = `${envelopeHeader}\n${itemHeader}\n${itemPayload}\n`;

    const result = await postEnvelope(body);
    if (result === 'retry') enqueue(body);
    return result === 'sent';
  };

  const sendSession = async (update: DesktopSentrySessionUpdate): Promise<boolean> => {
    if (!endpoints || !isEnabled()) return false;
    const envelopeHeader = JSON.stringify({
      sent_at: new Date(now()).toISOString(),
      dsn: endpoints.dsn,
    });
    const session = JSON.stringify({
      sid: update.sid,
      ...(update.did ? { did: update.did } : {}),
      init: update.init,
      started: new Date(update.startedAt).toISOString(),
      timestamp: new Date(update.timestamp).toISOString(),
      status: update.status,
      errors: update.errors,
      ...(update.durationSeconds !== undefined ? { duration: update.durationSeconds } : {}),
      attrs: { release: update.release, environment },
    });
    const body = `${envelopeHeader}\n${JSON.stringify({ type: 'session' })}\n${session}\n`;
    const result = await postEnvelope(body);
    if (result === 'retry') enqueue(body);
    return result === 'sent';
  };

  const startCrashReporter = (crashReporter: ElectronCrashReporterLike): boolean => {
    crashReporterRef = crashReporter;
    if (!endpoints || !isEnabled() || crashReporterStarted) return false;
    const installId = resolveInstallId();
    const globalExtra: Record<string, string> = {
      'sentry[release]': options.release,
      'sentry[environment]': environment,
      'sentry[tags][host_kind]': 'desktop',
      'sentry[tags][release_channel]': options.channel,
      'sentry[tags][host_platform]': options.platform,
      'sentry[tags][host_arch]': options.arch,
      'sentry[tags][shell_version]': options.shellVersion,
      'sentry[contexts][os][name]': osName,
      'sentry[contexts][os][version]': osVersion,
      'sentry[contexts][device][arch]': options.arch,
      ...(electronVersion
        ? {
            'sentry[contexts][runtime][name]': 'Electron',
            'sentry[contexts][runtime][version]': electronVersion,
          }
        : {}),
      ...(installId ? { 'sentry[user][id]': installId } : {}),
    };
    try {
      crashReporter.start({
        submitURL: endpoints.minidumpUrl,
        productName: DESKTOP_PRODUCT_NAME,
        compress: true,
        uploadToServer: true,
        globalExtra,
      });
      crashReporterStarted = true;
      return true;
    } catch {
      return false;
    }
  };

  return {
    isEnabled,
    setEnabled(next: boolean) {
      runtimeEnabled = Boolean(next) && Boolean(endpoints);
      // Turning sharing off also discards what was waiting to be sent.
      if (!isEnabled()) {
        breadcrumbs.length = 0;
        writeOutbox([]);
        options.onDisabled?.();
      }
      if (!crashReporterRef) return;
      if (!crashReporterStarted) {
        startCrashReporter(crashReporterRef);
        return;
      }
      try {
        crashReporterRef.setUploadToServer?.(isEnabled());
      } catch {
        // The sharing preference still gates every envelope sent by this reporter.
      }
    },
    getEndpoints() {
      return endpoints;
    },
    addBreadcrumb,
    flushOutbox,
    sendSession,
    startCrashReporter,
    captureTransaction,
    async captureException(error, context) {
      if (!isEnabled()) return false;
      options.onCapture?.('error');
      const errObj = error instanceof Error ? error : new Error(typeof error === 'string' ? error : String(error));
      const frames = parseStackFrames(errObj.stack, redactPaths, options.appDistDir);
      const event: SentryLikeEvent = {
        level: 'error',
        tags: baseTags(context),
        exception: {
          values: [
            {
              type: errObj.name || 'Error',
              value: scrubString(errObj.message || 'Unknown error', redactPaths),
              ...(frames ? { stacktrace: { frames } } : {}),
            },
          ],
        },
        ...(context?.extra
          ? { extra: scrubUnknown(context.extra, redactPaths) as Record<string, unknown> }
          : {}),
      };
      return sendEvent(event);
    },
    async captureMessage(message, level = 'error', context) {
      if (!isEnabled()) return false;
      options.onCapture?.(level);
      const event: SentryLikeEvent = {
        level,
        message: scrubString(message, redactPaths),
        tags: baseTags(context),
        ...(context?.extra
          ? { extra: scrubUnknown(context.extra, redactPaths) as Record<string, unknown> }
          : {}),
      };
      return sendEvent(event);
    },
  };
}
