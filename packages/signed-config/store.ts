/**
 * Persistent Anti-Rollback Store & Fallback Manager for Two-Tier Signed Config.
 *
 * Storage location: `<dataDir>/signed-config/state.json` (out of app bundle).
 * Fallback resolution order (Design Doc §5.6):
 *   1. Freshly verified signed config (valid root-signed cert, unrevoked,
 *      within cert validity window, monotonic sequence, within built-in bounds).
 *   2. Persisted last-known-good verified config (remains usable even if its
 *      daily signing certificate later expires, as long as its signature is
 *      intact, its key has not been revoked, and it stays within built-in bounds).
 *   3. Bundled default v1 configuration for the current release channel.
 */

import { randomBytes, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SIGNED_CONFIG_BASE_URL } from '../../shared/desktop-builtin-rules.ts';
import type { HostReleaseChannel } from '../../shared/desktop-contract.ts';
import {
  SIGNED_CONFIG_FORMAT_VERSION,
  type SignedConfigEnvelope,
  type SignedConfigPayload,
  type SignedConfigValidationIssue,
} from '../../shared/signed-config.ts';
import { canonicalJson } from './canonical.ts';
import {
  BUILTIN_REVOKED_KEY_IDS,
  createBundledDefaultConfigPayload,
  resolveEmbeddedRootPublicKeySpki,
} from './default-config.ts';
import {
  verifySignedConfigEnvelope,
  type SignedConfigFailureCode,
} from './verifier.ts';

export type ActiveConfigSource = 'verified' | 'last-known-good' | 'bundled-default';

export type SignedConfigManagerErrorCode =
  | SignedConfigFailureCode
  | 'FETCH_TIMEOUT'
  | 'FETCH_FAILED'
  | 'HTTP_ERROR'
  | 'INVALID_JSON'
  | 'STATE_CORRUPT';

export type SignedConfigLastError = {
  code: SignedConfigManagerErrorCode;
  message: string;
  at: string;
  issues?: SignedConfigValidationIssue[];
};

export type SignedConfigFetchResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  text: () => Promise<string>;
};

export type SignedConfigFetchFn = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<SignedConfigFetchResponse>;

export type SignedConfigManagerOptions = {
  /** Out-of-bundle application data directory; state is stored under `<dataDir>/signed-config/`. */
  dataDir: string;
  /** Release channel (default: 'stable'). */
  channel?: HostReleaseChannel;
  /** Allow loopback origins when channel === 'dev'. */
  allowLocalDevLoopback?: boolean;
  /** Root Ed25519 public key (PEM, SPKI base64, or KeyObject). Defaults to embedded root key. */
  rootPublicKey?: string | KeyObject;
  /** Alias for rootPublicKey. */
  rootPublicKeyPem?: string;
  /** Additional built-in revoked daily signing key IDs. */
  builtinRevokedKeyIds?: readonly string[];
  /** Custom fetch implementation (used in tests or proxy environments). */
  fetchFn?: SignedConfigFetchFn;
  /** Network fetch timeout in milliseconds (default: 10000). */
  fetchTimeoutMs?: number;
  /** Clock function returning epoch milliseconds (default: Date.now). */
  now?: () => number;
  /** Default signed config URL used when fetchAndApply() is called without an explicit URL. */
  defaultConfigUrl?: string;
};

export type SignedConfigApplySuccess = {
  applied: true;
  unchanged: boolean;
  source: ActiveConfigSource;
  sequence: number;
  certificateKeyId: string;
};

export type SignedConfigApplyFailure = {
  applied: false;
  source: ActiveConfigSource;
  activeSequence: number | null;
  code: SignedConfigManagerErrorCode;
  message: string;
  issues?: SignedConfigValidationIssue[];
};

export type SignedConfigApplyResult = SignedConfigApplySuccess | SignedConfigApplyFailure;

export type SignedConfigStatus = {
  source: ActiveConfigSource;
  channel: HostReleaseChannel;
  formatVersion: number;
  activeSequence: number | null;
  highestAcceptedSequence: number;
  certificateKeyId: string | null;
  certificateNotBefore: string | null;
  certificateNotAfter: string | null;
  certificateExpired: boolean;
  issuedAt: string | null;
  revokedKeyIds: string[];
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
  lastError: SignedConfigLastError | null;
  stateFilePath: string;
  minShellVersion: string | null;
  featureMinShellVersions: Record<string, string>;
};

type PersistedSignedConfigState = {
  schemaVersion: 1;
  highestAcceptedSequence: number;
  revokedKeyIds: string[];
  acceptedAt?: string;
  lastKnownGood?: SignedConfigEnvelope;
};

const STATE_SCHEMA_VERSION = 1 as const;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class SignedConfigManager {
  private readonly stateDir: string;
  private readonly stateFilePath: string;
  private readonly channel: HostReleaseChannel;
  private readonly allowLocalDevLoopback: boolean;
  private readonly rootPublicKey: string | KeyObject;
  private readonly fetchFn: SignedConfigFetchFn;
  private readonly fetchTimeoutMs: number;
  private readonly now: () => number;
  private readonly defaultConfigUrl: string;
  private readonly bundledDefault: SignedConfigPayload;

  private highestAcceptedSequence = 0;
  private revokedKeyIds: Set<string>;
  private activeEnvelope: SignedConfigEnvelope | null = null;
  private activePayload: SignedConfigPayload;
  private source: ActiveConfigSource = 'bundled-default';
  private lastCheckedAt: string | null = null;
  private lastUpdatedAt: string | null = null;
  private lastError: SignedConfigLastError | null = null;

  constructor(options: SignedConfigManagerOptions) {
    this.channel = options.channel ?? 'stable';
    this.allowLocalDevLoopback = Boolean(options.allowLocalDevLoopback);
    this.rootPublicKey =
      options.rootPublicKey ?? options.rootPublicKeyPem ?? resolveEmbeddedRootPublicKeySpki();
    this.fetchFn = options.fetchFn ?? ((url, init) => globalThis.fetch(url, init));
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.defaultConfigUrl =
      options.defaultConfigUrl ?? `${DEFAULT_SIGNED_CONFIG_BASE_URL}/${this.channel}.json`;
    this.stateDir = path.join(options.dataDir, 'signed-config');
    this.stateFilePath = path.join(this.stateDir, 'state.json');

    this.bundledDefault = createBundledDefaultConfigPayload(this.channel);
    this.activePayload = this.bundledDefault;
    this.revokedKeyIds = new Set<string>([
      ...BUILTIN_REVOKED_KEY_IDS,
      ...(options.builtinRevokedKeyIds ?? []),
    ]);

    this.loadPersistedState();
  }

  /**
   * Returns a clone of the currently active SignedConfigPayload.
   */
  getActiveConfig(): SignedConfigPayload {
    return structuredClone(this.activePayload);
  }

  /**
   * Returns a clone of the active verified/last-known-good envelope, or null
   * when running on the bundled default configuration.
   */
  getActiveEnvelope(): SignedConfigEnvelope | null {
    return this.activeEnvelope ? structuredClone(this.activeEnvelope) : null;
  }

  /**
   * Returns diagnostic status including fallback source, sequence watermarks,
   * certificate expiry status, revoked key IDs, and last error.
   */
  getStatus(): SignedConfigStatus {
    const cert = this.activeEnvelope?.certificate;
    const notAfterMs = cert ? Date.parse(cert.notAfter) : NaN;
    const certificateExpired = cert !== undefined && Number.isFinite(notAfterMs) && this.now() > notAfterMs;

    const featureMinShellVersions: Record<string, string> = {};
    for (const [featureId, def] of Object.entries(this.activePayload.features ?? {})) {
      if (typeof def?.minShellVersion === 'string' && def.minShellVersion.trim()) {
        featureMinShellVersions[featureId] = def.minShellVersion.trim();
      }
    }

    return {
      source: this.source,
      channel: this.channel,
      formatVersion: SIGNED_CONFIG_FORMAT_VERSION,
      activeSequence: this.activeEnvelope?.sequence ?? null,
      highestAcceptedSequence: this.highestAcceptedSequence,
      certificateKeyId: cert?.keyId ?? null,
      certificateNotBefore: cert?.notBefore ?? null,
      certificateNotAfter: cert?.notAfter ?? null,
      certificateExpired,
      issuedAt: this.activeEnvelope?.issuedAt ?? null,
      revokedKeyIds: Array.from(this.revokedKeyIds).sort(),
      lastCheckedAt: this.lastCheckedAt,
      lastUpdatedAt: this.lastUpdatedAt,
      lastError: this.lastError ? structuredClone(this.lastError) : null,
      stateFilePath: this.stateFilePath,
      minShellVersion:
        typeof this.activePayload.minShellVersion === 'string' && this.activePayload.minShellVersion.trim()
          ? this.activePayload.minShellVersion.trim()
          : null,
      featureMinShellVersions,
    };
  }

  /**
   * Verifies and applies an already-parsed signed config envelope.
   * Preserves last-known-good / bundled-default fallback on any rejection.
   */
  applyEnvelope(rawEnvelope: unknown): SignedConfigApplyResult {
    const nowIso = new Date(this.now()).toISOString();
    this.lastCheckedAt = nowIso;

    const result = verifySignedConfigEnvelope(rawEnvelope, {
      rootPublicKey: this.rootPublicKey,
      channel: this.channel,
      allowLocalDevLoopback: this.allowLocalDevLoopback,
      now: this.now(),
      lastAcceptedSequence: this.highestAcceptedSequence,
      allowEqualSequence: true,
      revokedKeyIds: this.revokedKeyIds,
      ignoreExpiration: false,
    });

    // Persist any newly learned root-signed revocations even if the envelope
    // itself is rejected (e.g. emergency revocation of an active daily key).
    const revocationsAdded = this.mergeRevocations(result.verifiedRevokedKeyIds);
    const activeEvicted = this.evictActiveIfRevoked();
    if (revocationsAdded || activeEvicted) {
      this.persistState();
    }

    if (!result.ok) {
      this.lastError = {
        code: result.code,
        message: result.message,
        at: nowIso,
        ...(result.issues ? { issues: result.issues } : {}),
      };
      return {
        applied: false,
        source: this.source,
        activeSequence: this.activeEnvelope?.sequence ?? null,
        code: result.code,
        message: result.message,
        ...(result.issues ? { issues: result.issues } : {}),
      };
    }

    // Reject equivocation: same sequence number with a different payload.
    if (this.activeEnvelope && result.sequence === this.highestAcceptedSequence) {
      const samePayload = canonicalJson(this.activeEnvelope.payload) === canonicalJson(result.payload);
      if (!samePayload) {
        const message = `Rejected conflicting payload at already-accepted sequence ${result.sequence}`;
        this.lastError = {
          code: 'SEQUENCE_ROLLBACK',
          message,
          at: nowIso,
        };
        return {
          applied: false,
          source: this.source,
          activeSequence: this.activeEnvelope.sequence,
          code: 'SEQUENCE_ROLLBACK',
          message,
        };
      }

      this.activeEnvelope = structuredClone(result.envelope);
      this.activePayload = structuredClone(result.payload);
      this.source = 'verified';
      this.lastError = null;
      this.persistState();
      return {
        applied: true,
        unchanged: true,
        source: this.source,
        sequence: result.sequence,
        certificateKeyId: result.certificateKeyId,
      };
    }

    // Newer sequence accepted (or first verified config).
    this.highestAcceptedSequence = Math.max(this.highestAcceptedSequence, result.sequence);
    this.activeEnvelope = structuredClone(result.envelope);
    this.activePayload = structuredClone(result.payload);
    this.source = 'verified';
    this.lastUpdatedAt = nowIso;
    this.lastError = null;
    this.persistState();

    return {
      applied: true,
      unchanged: false,
      source: this.source,
      sequence: result.sequence,
      certificateKeyId: result.certificateKeyId,
    };
  }

  /**
   * Fetches a remote signed config JSON envelope with timeout, verifies it,
   * and applies it. On network/HTTP/parse/verification failure, keeps the
   * fallback config active and returns a typed failure result without throwing.
   */
  async fetchAndApply(url?: string): Promise<SignedConfigApplyResult> {
    const targetUrl = url ?? this.defaultConfigUrl;
    const nowIso = new Date(this.now()).toISOString();
    this.lastCheckedAt = nowIso;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.fetchTimeoutMs);
    timer.unref?.();

    let rawText: string;
    try {
      const response = await this.fetchFn(targetUrl, {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
        },
      });
      if (!response.ok) {
        const message = `Signed config fetch returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
        this.lastError = { code: 'HTTP_ERROR', message, at: nowIso };
        return {
          applied: false,
          source: this.source,
          activeSequence: this.activeEnvelope?.sequence ?? null,
          code: 'HTTP_ERROR',
          message,
        };
      }
      rawText = await response.text();
    } catch (err) {
      const isAbort = timedOut || (err instanceof Error && err.name === 'AbortError');
      const code: SignedConfigManagerErrorCode = isAbort ? 'FETCH_TIMEOUT' : 'FETCH_FAILED';
      const message = isAbort
        ? `Signed config fetch timed out after ${this.fetchTimeoutMs}ms`
        : err instanceof Error
          ? `Signed config fetch failed: ${err.message}`
          : 'Signed config fetch failed';
      this.lastError = { code, message, at: nowIso };
      return {
        applied: false,
        source: this.source,
        activeSequence: this.activeEnvelope?.sequence ?? null,
        code,
        message,
      };
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      const message = err instanceof Error ? `Invalid signed config JSON: ${err.message}` : 'Invalid signed config JSON';
      this.lastError = { code: 'INVALID_JSON', message, at: nowIso };
      return {
        applied: false,
        source: this.source,
        activeSequence: this.activeEnvelope?.sequence ?? null,
        code: 'INVALID_JSON',
        message,
      };
    }

    return this.applyEnvelope(parsed);
  }

  private mergeRevocations(incoming?: readonly string[]): boolean {
    if (!incoming || incoming.length === 0) return false;
    let added = false;
    for (const id of incoming) {
      if (typeof id === 'string' && id.trim() && !this.revokedKeyIds.has(id)) {
        this.revokedKeyIds.add(id);
        added = true;
      }
    }
    return added;
  }

  private evictActiveIfRevoked(): boolean {
    if (!this.activeEnvelope) return false;
    if (this.revokedKeyIds.has(this.activeEnvelope.certificate.keyId)) {
      this.activeEnvelope = null;
      this.activePayload = this.bundledDefault;
      this.source = 'bundled-default';
      return true;
    }
    return false;
  }

  private loadPersistedState(): void {
    if (!existsSync(this.stateFilePath)) {
      return;
    }

    const nowIso = new Date(this.now()).toISOString();
    let parsed: unknown;
    try {
      const content = readFileSync(this.stateFilePath, 'utf8');
      parsed = JSON.parse(content);
    } catch (err) {
      this.lastError = {
        code: 'STATE_CORRUPT',
        message: err instanceof Error ? `Failed to read persisted signed config state: ${err.message}` : 'Corrupt persisted signed config state',
        at: nowIso,
      };
      return;
    }

    if (!isRecord(parsed) || parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
      this.lastError = {
        code: 'STATE_CORRUPT',
        message: 'Persisted signed config state has unsupported schemaVersion',
        at: nowIso,
      };
      return;
    }

    if (
      typeof parsed.highestAcceptedSequence === 'number' &&
      Number.isSafeInteger(parsed.highestAcceptedSequence) &&
      parsed.highestAcceptedSequence >= 0
    ) {
      this.highestAcceptedSequence = parsed.highestAcceptedSequence;
    }

    if (Array.isArray(parsed.revokedKeyIds)) {
      for (const id of parsed.revokedKeyIds) {
        if (typeof id === 'string' && id.trim()) {
          this.revokedKeyIds.add(id);
        }
      }
    }

    if (typeof parsed.acceptedAt === 'string' && parsed.acceptedAt.trim()) {
      this.lastUpdatedAt = parsed.acceptedAt;
    }

    if (parsed.lastKnownGood !== undefined) {
      // Re-verify persisted last-known-good envelope with ignoreExpiration=true
      // so already-accepted configs remain usable after daily cert expiration,
      // while still rejecting tampered files, revoked keys, unsupported formats,
      // or out-of-bounds payloads.
      const check = verifySignedConfigEnvelope(parsed.lastKnownGood, {
        rootPublicKey: this.rootPublicKey,
        channel: this.channel,
        allowLocalDevLoopback: this.allowLocalDevLoopback,
        now: this.now(),
        lastAcceptedSequence: 0,
        revokedKeyIds: this.revokedKeyIds,
        ignoreExpiration: true,
      });

      this.mergeRevocations(check.verifiedRevokedKeyIds);

      if (check.ok) {
        this.activeEnvelope = structuredClone(check.envelope);
        this.activePayload = structuredClone(check.payload);
        this.source = 'last-known-good';
        this.highestAcceptedSequence = Math.max(this.highestAcceptedSequence, check.sequence);
      } else {
        this.activeEnvelope = null;
        this.activePayload = this.bundledDefault;
        this.source = 'bundled-default';
        this.lastError = {
          code: check.code,
          message: `Persisted last-known-good config rejected: ${check.message}`,
          at: nowIso,
          ...(check.issues ? { issues: check.issues } : {}),
        };
      }
    }
  }

  private persistState(): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const state: PersistedSignedConfigState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      highestAcceptedSequence: this.highestAcceptedSequence,
      revokedKeyIds: Array.from(this.revokedKeyIds).sort(),
      ...(this.lastUpdatedAt ? { acceptedAt: this.lastUpdatedAt } : {}),
      ...(this.activeEnvelope ? { lastKnownGood: this.activeEnvelope } : {}),
    };

    const tmpPath = path.join(
      this.stateDir,
      `state.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(tmpPath, this.stateFilePath);
    } catch (err) {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup failure after write/rename error.
      }
      throw err;
    }
  }
}
