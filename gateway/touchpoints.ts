import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  safeHttpsUrl,
  safeInternalPath,
  toOpenDesignApiLocale,
  TOUCHPOINT_PLACEMENT_KEYS,
  type ProductionTouchpointDecision,
  type ProductionTouchpointResponse,
  type TouchpointEventType,
  type TouchpointPlacementKey,
} from '../shared/growth-surfaces.ts';
import type { Fetcher } from './network.ts';
import { readSettings, writeSettings } from './settings-storage.ts';
import type { WorkspaceCollabAccountClient } from './workspace-collab.ts';

export interface TouchpointsAccountClient {
  readonly root: string;
  getControlSession: WorkspaceCollabAccountClient['getControlSession'];
}

export class TouchpointRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

type CachedTouchpointEntry = {
  scope: string;
  cachedAt: number;
  decision: ProductionTouchpointDecision;
};

type TouchpointCacheFile = {
  schemaVersion: 1;
  entries: Record<string, CachedTouchpointEntry>;
};

const VALID_PLACEMENTS = new Set<string>(TOUCHPOINT_PLACEMENT_KEYS);
const VALID_EVENTS = new Set<string>(['impression', 'click', 'dismiss', 'action']);
const REQUEST_TIMEOUT_MS = 10_000;
const EVENT_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function extractStaticActionUrls(staticActions: unknown): { httpsUrl: string | null; internalPath: string | null } {
  if (!Array.isArray(staticActions)) return { httpsUrl: null, internalPath: null };
  let httpsUrl: string | null = null;
  let internalPath: string | null = null;
  for (const item of staticActions) {
    if (!isRecord(item) || !isRecord(item.target)) continue;
    if (!httpsUrl && item.target.kind === 'https') {
      httpsUrl = safeHttpsUrl(item.target.url);
    }
    if (!internalPath && item.target.kind === 'internal') {
      internalPath = safeInternalPath(item.target.path);
    }
  }
  return { httpsUrl, internalPath };
}

function pickLocalizedRecord(rawLocales: unknown, locale: string): Record<string, unknown> | null {
  if (!isRecord(rawLocales)) return null;
  if (isRecord(rawLocales[locale])) return rawLocales[locale] as Record<string, unknown>;
  const apiLocale = toOpenDesignApiLocale(locale);
  if (isRecord(rawLocales[apiLocale])) return rawLocales[apiLocale] as Record<string, unknown>;
  const normalized = locale.toLowerCase();
  const primary = normalized.split('-')[0];
  for (const [key, entry] of Object.entries(rawLocales)) {
    if (isRecord(entry) && (key.toLowerCase() === normalized || key.toLowerCase().split('-')[0] === primary)) {
      return entry;
    }
  }
  return null;
}

export function normalizeTouchpointDecision(
  raw: unknown,
  expectedPlacementKey: TouchpointPlacementKey,
  locale = 'en',
  now = Date.now(),
): ProductionTouchpointDecision | null {
  if (!isRecord(raw)) return null;
  const rawPlacement = readString(raw.placementKey);
  if (rawPlacement && rawPlacement !== expectedPlacementKey) return null;

  const content = isRecord(raw.content) ? raw.content : {};
  const contentPlacement = readString(content.placementKey);
  if (contentPlacement && contentPlacement !== expectedPlacementKey) return null;

  const activityId = readString(raw.activityId) || readString(content.activityId);
  const touchpointDecisionId = readString(raw.touchpointDecisionId) || readString(content.id);
  const endsAt = readString(raw.endsAt) || readString(content.endsAt);
  const endsAtMs = parseIsoMs(endsAt);
  if (!activityId || !touchpointDecisionId || endsAtMs === null || endsAtMs <= now) {
    return null;
  }

  const authorizationExpiresAt = readString(raw.authorizationExpiresAt) || null;
  const authExpiresMs = parseIsoMs(authorizationExpiresAt);
  if (authExpiresMs !== null && authExpiresMs <= now) {
    return null;
  }

  const nestedData = isRecord(content.data) ? content.data : isRecord(content.props) ? content.props : {};
  const base = { ...raw, ...content, ...nestedData };
  const localeOverride = pickLocalizedRecord(base.locales, locale);
  const merged = localeOverride ? { ...base, ...localeOverride } : base;

  const title = readString(merged.title) || readString(merged.headline);
  const badgeLabel =
    readString(merged.badgeLabel) ||
    readString(merged.badge) ||
    readString(merged.shortLabel) ||
    (expectedPlacementKey === 'opend.home.account-badge' ? title : '');

  if (!title && !badgeLabel) {
    return null;
  }

  const staticUrls = extractStaticActionUrls(raw.staticActions ?? content.staticActions);
  const ctaUrl = safeHttpsUrl(merged.ctaUrl) ?? staticUrls.httpsUrl;
  const internalPath = safeInternalPath(merged.internalPath) ?? staticUrls.internalPath;
  const imageUrl = safeHttpsUrl(merged.imageUrl);
  const rawHighlights = Array.isArray(merged.highlights) ? merged.highlights : [];
  const highlights = rawHighlights
    .map(item => readString(item))
    .filter(Boolean)
    .slice(0, 6);

  return {
    activityId,
    touchpointDecisionId,
    deploymentId: readString(raw.deploymentId) || null,
    placementKey: expectedPlacementKey,
    endsAt,
    authorizationExpiresAt,
    serverTime: readString(raw.serverTime) || null,
    badgeLabel: badgeLabel || title,
    title: title || badgeLabel,
    subtitle: readString(merged.subtitle) || null,
    body: readString(merged.body) || readString(merged.description),
    highlights,
    imageUrl,
    paidCtaLabel: readString(merged.paidCtaLabel) || null,
    freeCtaLabel: readString(merged.freeCtaLabel) || null,
    ctaUrl,
    internalPath,
    targetModelId: readString(merged.targetModelId) || null,
    targetModelLabel: readString(merged.targetModelLabel) || null,
  };
}

function cacheScopeFor(apiUrl: string, controlKeyId: string | undefined, controlKey: string): string {
  return createHash('sha256')
    .update(`${apiUrl.replace(/\/$/, '')}:${controlKeyId || controlKey}`)
    .digest('hex')
    .slice(0, 24);
}

function entryValidAt(decision: ProductionTouchpointDecision, now: number): boolean {
  const endsMs = parseIsoMs(decision.endsAt);
  if (endsMs === null || endsMs <= now) return false;
  const authMs = parseIsoMs(decision.authorizationExpiresAt);
  if (authMs !== null && authMs <= now) return false;
  return true;
}

export class TouchpointService {
  private readonly account: TouchpointsAccountClient;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    account: TouchpointsAccountClient,
    options: { fetcher?: Fetcher; now?: () => number } = {},
  ) {
    this.account = account;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private get cachePath(): string {
    return path.join(this.account.root, 'touchpoints-cache.json');
  }

  private async readCache(): Promise<TouchpointCacheFile> {
    try {
      const raw = await readSettings<Partial<TouchpointCacheFile>>(this.cachePath, {});
      return {
        schemaVersion: 1,
        entries: isRecord(raw.entries) ? (raw.entries as Record<string, CachedTouchpointEntry>) : {},
      };
    } catch {
      return { schemaVersion: 1, entries: {} };
    }
  }

  private mutateCache<T>(mutator: (cache: TouchpointCacheFile) => Promise<T> | T): Promise<T> {
    const run = this.writeQueue.then(async () => {
      const cache = await this.readCache();
      const result = await mutator(cache);
      await writeSettings(this.cachePath, cache);
      return result;
    });
    this.writeQueue = run.catch(() => {});
    return run;
  }

  private async removeSlot(slotKey: string): Promise<void> {
    const existing = await this.readCache();
    if (!Object.hasOwn(existing.entries, slotKey)) return;
    await this.mutateCache(cache => {
      delete cache.entries[slotKey];
    });
  }

  private async purgeRevoked(
    slotKey: string,
    scope: string,
    identity: { activityId?: string | null; deploymentId?: string | null },
  ): Promise<void> {
    await this.mutateCache(cache => {
      delete cache.entries[slotKey];
      for (const [key, entry] of Object.entries(cache.entries)) {
        if (entry.scope !== scope) continue;
        if (
          (identity.activityId && entry.decision.activityId === identity.activityId) ||
          (identity.deploymentId && entry.decision.deploymentId === identity.deploymentId)
        ) {
          delete cache.entries[key];
        }
      }
    });
  }

  private async purgeScope(scope: string): Promise<void> {
    const existing = await this.readCache();
    const hasScope = Object.values(existing.entries).some(entry => entry.scope === scope);
    if (!hasScope) return;
    await this.mutateCache(cache => {
      for (const [key, entry] of Object.entries(cache.entries)) {
        if (entry.scope === scope) delete cache.entries[key];
      }
    });
  }

  async getProductionTouchpoint(options: {
    placementKey: string;
    locale?: string;
    activeDecisionId?: string;
  }): Promise<ProductionTouchpointResponse> {
    const placementRaw = options.placementKey.trim();
    if (!VALID_PLACEMENTS.has(placementRaw)) {
      throw new TouchpointRequestError(400, 'invalid_placement_key', 'Unsupported touchpoint placement.');
    }
    const placementKey = placementRaw as TouchpointPlacementKey;
    const locale = options.locale?.trim() || 'en';
    const apiLocale = toOpenDesignApiLocale(locale);
    const activeDecisionId = options.activeDecisionId?.trim() || '';

    const session = await this.account.getControlSession();
    if (!session) {
      return { status: 'unauthorized', decision: null, offlineReplay: false };
    }

    const scope = cacheScopeFor(session.apiUrl, session.controlKeyId, session.controlKey);
    const slotKey = `${scope}:${placementKey}:${apiLocale}`;
    const query = new URLSearchParams({ placementKey, locale: apiLocale });
    if (activeDecisionId) query.set('activeDecisionId', activeDecisionId);

    let response: Response | null = null;
    try {
      response = await this.fetcher(
        `${session.apiUrl.replace(/\/$/, '')}/api/v1/touchpoints/runtime/production?${query.toString()}`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${session.controlKey}`,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch {
      response = null;
    }

    if (response) {
      if (response.status === 410) {
        let receipt: Record<string, unknown> = {};
        try {
          const parsed = await response.json();
          if (isRecord(parsed)) receipt = parsed;
        } catch {
          // Withdrawal receipt body is optional for purge.
        }
        await this.purgeRevoked(slotKey, scope, {
          activityId: readString(receipt.activityId) || null,
          deploymentId: readString(receipt.deploymentId) || null,
        }).catch(() => {});
        return { status: 'revoked', decision: null, offlineReplay: false };
      }

      if (response.status === 401 || response.status === 403) {
        await this.purgeScope(scope).catch(() => {});
        return { status: 'unauthorized', decision: null, offlineReplay: false };
      }

      if (response.status === 404) {
        await this.removeSlot(slotKey).catch(() => {});
        return { status: 'none', decision: null, offlineReplay: false };
      }

      if (response.ok) {
        let parsedOk = false;
        let decision: ProductionTouchpointDecision | null = null;
        const now = this.now();
        try {
          const raw = await response.json();
          decision = normalizeTouchpointDecision(raw, placementKey, locale, now);
          parsedOk = true;
        } catch {
          // Incomplete or malformed 200 payload falls through to offline replay check.
        }
        if (parsedOk) {
          if (decision) {
            await this.mutateCache(cache => {
              cache.entries[slotKey] = { scope, cachedAt: now, decision: decision! };
            }).catch(() => {});
            return { status: 'active', decision, offlineReplay: false };
          }
          await this.removeSlot(slotKey).catch(() => {});
          return { status: 'none', decision: null, offlineReplay: false };
        }
      }
    }

    // Network error, timeout, incomplete JSON, or 5xx: replay unexpired cached decision for this account scope.
    const now = this.now();
    const cache = await this.readCache();
    const cached = cache.entries[slotKey];
    if (cached && cached.scope === scope) {
      if (entryValidAt(cached.decision, now)) {
        return { status: 'active', decision: cached.decision, offlineReplay: true };
      }
      await this.removeSlot(slotKey).catch(() => {});
    }

    return { status: 'none', decision: null, offlineReplay: false };
  }

  async reportTouchpointEvent(payload: {
    activityId?: unknown;
    touchpointDecisionId?: unknown;
    deploymentId?: unknown;
    placementKey?: unknown;
    eventType?: unknown;
    locale?: unknown;
    actionId?: unknown;
  }): Promise<{ ok: boolean }> {
    const activityId = readString(payload.activityId);
    const touchpointDecisionId = readString(payload.touchpointDecisionId);
    const placementKey = readString(payload.placementKey);
    const eventType = readString(payload.eventType);
    if (
      !activityId ||
      !touchpointDecisionId ||
      !VALID_PLACEMENTS.has(placementKey) ||
      !VALID_EVENTS.has(eventType)
    ) {
      throw new TouchpointRequestError(400, 'invalid_touchpoint_event', 'Invalid touchpoint event payload.');
    }

    const session = await this.account.getControlSession();
    if (!session) return { ok: false };

    try {
      const response = await this.fetcher(
        `${session.apiUrl.replace(/\/$/, '')}/api/v1/touchpoints/runtime/events`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${session.controlKey}`,
          },
          body: JSON.stringify({
            activityId,
            touchpointDecisionId,
            ...(readString(payload.deploymentId) ? { deploymentId: readString(payload.deploymentId) } : {}),
            placementKey,
            eventType: eventType as TouchpointEventType,
            locale: toOpenDesignApiLocale(readString(payload.locale) || 'en'),
            ...(readString(payload.actionId) ? { actionId: readString(payload.actionId) } : {}),
          }),
          signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
        },
      );
      return { ok: response.ok };
    } catch {
      return { ok: false };
    }
  }
}

const touchpointServices = new WeakMap<TouchpointsAccountClient, TouchpointService>();

export function touchpointsFor(
  account: TouchpointsAccountClient,
  options?: { fetcher?: Fetcher; now?: () => number },
): TouchpointService {
  let instance = touchpointServices.get(account);
  if (!instance) {
    instance = new TouchpointService(account, options);
    touchpointServices.set(account, instance);
  }
  return instance;
}
