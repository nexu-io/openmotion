/**
 * Privacy-safe, zero-PII Desktop Edge Health Telemetry Collector.
 *
 * Tracks operational reliability signals locally (startup latency, PKCE handoff
 * completion/fallback/timeout, updater checks/downloads/installs, signed-config
 * refresh outcomes, and Agent connect outcomes) in a bounded rolling ring buffer
 * persisted under `<dataDir>/telemetry/health-metrics.json`.
 *
 * Privacy invariants:
 * - Only allowlisted enum/numeric fields are stored; arbitrary strings, URLs,
 *   tokens, emails, and filesystem paths are rejected/stripped.
 * - Respects `DO_NOT_TRACK=1` and `OPENMOTION_TELEMETRY=0`.
 * - Optional remote flush transport (disabled unless explicitly configured) is
 *   strictly restricted to `isUrlInAllowedDomainScope`.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isUrlInAllowedDomainScope } from '../../shared/desktop-builtin-rules.ts';
import type { HostPlatform, HostReleaseChannel } from '../../shared/desktop-contract.ts';
import { TelemetryRecordEventParamsSchema } from '../../shared/desktop-schemas.ts';
import type {
  DesktopTelemetryCategory,
  DesktopTelemetryCategoryCounters,
  DesktopTelemetryEvent,
  DesktopTelemetryOutcome,
  DesktopTelemetryRecordInput,
  DesktopTelemetrySummary,
} from '../../shared/desktop-telemetry.ts';

const TELEMETRY_FILE_NAME = 'health-metrics.json';
const TELEMETRY_SCHEMA_VERSION = 1 as const;
const DEFAULT_MAX_RETAINED_EVENTS = 200;
const SAFE_SHORT_TOKEN_RE = /^[a-zA-Z0-9._-]{1,64}$/;

type PersistedTelemetryState = {
  schemaVersion: 1;
  enabled: boolean;
  totalEvents: number;
  updatedAt: string;
  categories: Partial<
    Record<
      DesktopTelemetryCategory,
      {
        total: number;
        outcomes: Partial<Record<DesktopTelemetryOutcome, number>>;
        durationSumMs: number;
        durationCount: number;
        maxDurationMs?: number;
      }
    >
  >;
  recentEvents: DesktopTelemetryEvent[];
};

export type DesktopTelemetryCollectorOptions = {
  dataDir: string;
  channel: HostReleaseChannel;
  platform: HostPlatform;
  arch: string;
  shellVersion: string;
  allowLocalDevLoopback?: boolean;
  maxRetainedEvents?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  flushEndpointUrl?: string;
  fetchImpl?: typeof fetch;
};

function isTelemetryOptedOutByEnv(env: NodeJS.ProcessEnv): boolean {
  const dnt = env.DO_NOT_TRACK?.trim().toLowerCase();
  if (dnt === '1' || dnt === 'true') return true;
  const flag = env.OPENMOTION_TELEMETRY?.trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return true;
  return false;
}

function sanitizeShortToken(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return SAFE_SHORT_TOKEN_RE.test(trimmed) ? trimmed : undefined;
}

function assertNotSymlink(targetPath: string): void {
  if (!existsSync(targetPath)) return;
  if (lstatSync(targetPath).isSymbolicLink()) {
    throw new Error(`Refusing to access symlinked telemetry path: ${targetPath}`);
  }
}

export class DesktopTelemetryCollector {
  private readonly dirPath: string;
  private readonly filePath: string;
  private readonly channel: HostReleaseChannel;
  private readonly platform: HostPlatform;
  private readonly arch: string;
  private readonly shellVersion: string;
  private readonly allowLocalDevLoopback: boolean;
  private readonly maxRetainedEvents: number;
  private readonly now: () => Date;
  private readonly flushEndpointUrl?: string;
  private readonly fetchImpl?: typeof fetch;
  private state: PersistedTelemetryState;

  constructor(options: DesktopTelemetryCollectorOptions) {
    this.dirPath = path.join(options.dataDir, 'telemetry');
    this.filePath = path.join(this.dirPath, TELEMETRY_FILE_NAME);
    this.channel = options.channel;
    this.platform = options.platform;
    this.arch = options.arch;
    this.shellVersion = options.shellVersion;
    this.allowLocalDevLoopback = Boolean(options.allowLocalDevLoopback);
    this.maxRetainedEvents = Math.max(10, options.maxRetainedEvents ?? DEFAULT_MAX_RETAINED_EVENTS);
    this.now = options.now ?? (() => new Date());
    this.flushEndpointUrl = options.flushEndpointUrl;
    this.fetchImpl = options.fetchImpl;

    const env = options.env ?? process.env;
    const defaultEnabled = !isTelemetryOptedOutByEnv(env);
    this.state = this.loadState(defaultEnabled);
    if (isTelemetryOptedOutByEnv(env)) {
      this.state.enabled = false;
    }
  }

  private emptyState(enabled: boolean): PersistedTelemetryState {
    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      enabled,
      totalEvents: 0,
      updatedAt: this.now().toISOString(),
      categories: {},
      recentEvents: [],
    };
  }

  private loadState(defaultEnabled: boolean): PersistedTelemetryState {
    try {
      assertNotSymlink(this.dirPath);
      assertNotSymlink(this.filePath);
      if (!existsSync(this.filePath)) {
        return this.emptyState(defaultEnabled);
      }
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PersistedTelemetryState>;
      if (parsed && parsed.schemaVersion === TELEMETRY_SCHEMA_VERSION && typeof parsed.totalEvents === 'number') {
        return {
          schemaVersion: TELEMETRY_SCHEMA_VERSION,
          enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : defaultEnabled,
          totalEvents: parsed.totalEvents,
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : this.now().toISOString(),
          categories: parsed.categories && typeof parsed.categories === 'object' ? parsed.categories : {},
          recentEvents: Array.isArray(parsed.recentEvents)
            ? parsed.recentEvents.slice(-this.maxRetainedEvents)
            : [],
        };
      }
    } catch {
      // Corrupted telemetry file fails cleanly to fresh state.
    }
    return this.emptyState(defaultEnabled);
  }

  private persistState(): void {
    try {
      assertNotSymlink(this.dirPath);
      mkdirSync(this.dirPath, { recursive: true, mode: 0o700 });
      assertNotSymlink(this.dirPath);
      assertNotSymlink(this.filePath);
      const tmpPath = path.join(
        this.dirPath,
        `.${TELEMETRY_FILE_NAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
      );
      writeFileSync(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      try {
        chmodSync(tmpPath, 0o600);
      } catch {
        // Ignore on filesystems without POSIX permissions.
      }
      renameSync(tmpPath, this.filePath);
    } catch {
      // Telemetry persistence must never interrupt primary desktop workflows.
    }
  }

  isEnabled(): boolean {
    return this.state.enabled;
  }

  setEnabled(enabled: boolean): DesktopTelemetrySummary {
    this.state.enabled = Boolean(enabled);
    this.state.updatedAt = this.now().toISOString();
    this.persistState();
    return this.getSummary();
  }

  reset(): DesktopTelemetrySummary {
    this.state = this.emptyState(this.state.enabled);
    this.persistState();
    return this.getSummary();
  }

  record(rawInput: DesktopTelemetryRecordInput): DesktopTelemetryEvent | null {
    if (!this.state.enabled) {
      return null;
    }

    const parsed = TelemetryRecordEventParamsSchema.safeParse(rawInput);
    if (!parsed.success) {
      return null;
    }
    const valid = parsed.data;
    const durationMs =
      typeof valid.durationMs === 'number' ? Math.max(0, Math.round(valid.durationMs)) : undefined;
    const agentId = sanitizeShortToken(valid.agentId);
    const targetVersion = sanitizeShortToken(valid.targetVersion);
    const errorCode = sanitizeShortToken(valid.errorCode);
    const timestamp = this.now().toISOString();

    const event: DesktopTelemetryEvent = {
      category: valid.category,
      outcome: valid.outcome,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(agentId ? { agentId } : {}),
      ...(valid.connectMode ? { connectMode: valid.connectMode } : {}),
      ...(valid.pairMethod ? { pairMethod: valid.pairMethod } : {}),
      ...(targetVersion ? { targetVersion } : {}),
      ...(valid.sequence !== undefined ? { sequence: valid.sequence } : {}),
      ...(errorCode ? { errorCode } : {}),
      timestamp,
      channel: this.channel,
      platform: this.platform,
      arch: this.arch,
      shellVersion: this.shellVersion,
    };

    this.state.totalEvents += 1;
    this.state.updatedAt = timestamp;
    const bucket =
      this.state.categories[valid.category] ??
      (this.state.categories[valid.category] = {
        total: 0,
        outcomes: {},
        durationSumMs: 0,
        durationCount: 0,
      });
    bucket.total += 1;
    bucket.outcomes[valid.outcome] = (bucket.outcomes[valid.outcome] ?? 0) + 1;
    if (durationMs !== undefined) {
      bucket.durationSumMs += durationMs;
      bucket.durationCount += 1;
      bucket.maxDurationMs =
        bucket.maxDurationMs === undefined ? durationMs : Math.max(bucket.maxDurationMs, durationMs);
    }

    this.state.recentEvents.push(event);
    if (this.state.recentEvents.length > this.maxRetainedEvents) {
      this.state.recentEvents = this.state.recentEvents.slice(-this.maxRetainedEvents);
    }
    this.persistState();
    return event;
  }

  getSummary(): DesktopTelemetrySummary {
    const categories: Partial<Record<DesktopTelemetryCategory, DesktopTelemetryCategoryCounters>> = {};
    for (const [cat, bucket] of Object.entries(this.state.categories) as Array<
      [DesktopTelemetryCategory, NonNullable<PersistedTelemetryState['categories'][DesktopTelemetryCategory]>]
    >) {
      categories[cat] = {
        total: bucket.total,
        outcomes: { ...bucket.outcomes },
        ...(bucket.durationCount > 0
          ? {
              avgDurationMs: Math.round(bucket.durationSumMs / bucket.durationCount),
              maxDurationMs: bucket.maxDurationMs,
            }
          : {}),
      };
    }

    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      enabled: this.state.enabled,
      channel: this.channel,
      platform: this.platform,
      arch: this.arch,
      shellVersion: this.shellVersion,
      totalEvents: this.state.totalEvents,
      retainedEvents: this.state.recentEvents.length,
      updatedAt: this.state.updatedAt,
      categories,
      recentEvents: [...this.state.recentEvents],
    };
  }

  /**
   * Optional bounded flush to a domain-scoped cloud telemetry endpoint.
   * Rejects out-of-scope URLs and fails silently when disabled or unconfigured.
   */
  async flush(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.state.enabled) return { ok: false, reason: 'disabled' };
    if (!this.flushEndpointUrl) return { ok: false, reason: 'unconfigured' };
    if (
      !isUrlInAllowedDomainScope(this.flushEndpointUrl, {
        channel: this.channel,
        allowLocalDevLoopback: this.allowLocalDevLoopback,
      })
    ) {
      return { ok: false, reason: 'origin_denied' };
    }
    const fetchFn = this.fetchImpl ?? globalThis.fetch;
    if (typeof fetchFn !== 'function') return { ok: false, reason: 'no_fetch' };

    try {
      const response = await fetchFn(this.flushEndpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.getSummary()),
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok ? { ok: true } : { ok: false, reason: `http_${response.status}` };
    } catch {
      return { ok: false, reason: 'network_error' };
    }
  }
}
