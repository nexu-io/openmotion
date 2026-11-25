import { useEffect, useState } from 'react';
import type { AccountSummary } from '../../../../shared/provider-directory';
import { gatewayRequest } from '../gatewayClient';

export const DEFAULT_GAME_COMMUNITY_BASE = 'https://open-design.ai/cloud';
export const DEFAULT_GAME_COMMUNITY_URL = `${DEFAULT_GAME_COMMUNITY_BASE}/games`;
export const GAME_COMMUNITY_TAB_ID = 'web:game-community';

const CACHE_TTL_MS = 5 * 60 * 1000;
const WARM_THROTTLE_MS = 60 * 1000;
let lastWarmAt = 0;

let preloadedBrowserChunks = false;

/**
 * Triggers non-blocking headless Chrome warmup and preloads the lazy Browser Pane + WebBrowser JS chunks
 * so clicking Surprise me opens immediately with zero Suspense fallback flashes.
 */
export function warmSuperAgentBrowser(): void {
  if (typeof window === 'undefined') return;
  if (!preloadedBrowserChunks) {
    preloadedBrowserChunks = true;
    void import('../../super-agent/ArtifactBrowserPane')
      .then(mod => mod.preloadWebBrowser?.())
      .catch(() => {
        preloadedBrowserChunks = false;
      });
  }
  if (typeof fetch !== 'function') return;
  const now = Date.now();
  if (now - lastWarmAt < WARM_THROTTLE_MS) return;
  lastWarmAt = now;
  void fetch('/motion-api/super-agent/browser/warm', { method: 'POST' }).catch(() => {});
}

/**
 * Resolves the AMR random-swipe community game feed URL (`/games`) from the
 * active OpenDesign account console URL, falling back to production Cloud.
 */
export function buildGameCommunityFeedUrl(consoleUrl?: string | null): string {
  const raw = consoleUrl?.trim();
  if (!raw) return DEFAULT_GAME_COMMUNITY_URL;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return DEFAULT_GAME_COMMUNITY_URL;
    }
    const cleanPath = parsed.pathname
      .replace(/\/+$/, '')
      .replace(/\/(?:dashboard|games)$/i, '');
    return `${parsed.origin}${cleanPath}/games`;
  } catch {
    return DEFAULT_GAME_COMMUNITY_URL;
  }
}

let cachedUrl: { value: string; at: number } | null = null;
let inFlight: Promise<string> | null = null;
let inFlightId = 0;

export function resetGameCommunityUrlCache() {
  cachedUrl = null;
  inFlight = null;
  inFlightId += 1;
}

export function peekCachedGameCommunityUrl(): string {
  return cachedUrl?.value ?? DEFAULT_GAME_COMMUNITY_URL;
}

export async function resolveGameCommunityUrl(force = false): Promise<string> {
  if (!force && cachedUrl && Date.now() - cachedUrl.at < CACHE_TTL_MS) {
    return cachedUrl.value;
  }
  if (!force && inFlight) return inFlight;
  const requestId = ++inFlightId;
  const run = (async () => {
    try {
      const account = await gatewayRequest<AccountSummary>('settings/account');
      const next = buildGameCommunityFeedUrl(account?.consoleUrl);
      if (inFlightId === requestId) {
        cachedUrl = { value: next, at: Date.now() };
      }
      return next;
    } catch {
      return cachedUrl?.value ?? DEFAULT_GAME_COMMUNITY_URL;
    } finally {
      if (inFlightId === requestId) inFlight = null;
    }
  })();
  inFlight = run;
  return run;
}

/**
 * Resolves the AMR `/games` feed URL with one shared cached request across
 * Game Studio and the built-in Browser Pane.
 */
export function useGameCommunityUrl(): string {
  const [url, setUrl] = useState<string>(() => peekCachedGameCommunityUrl());

  useEffect(() => {
    let cancelled = false;
    const sync = (force = false) => {
      void resolveGameCommunityUrl(force).then(next => {
        if (!cancelled) setUrl(next);
      });
    };
    sync(false);
    const onAccountChanged = () => sync(true);
    window.addEventListener('motion:account-changed', onAccountChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('motion:account-changed', onAccountChanged);
    };
  }, []);

  return url;
}
