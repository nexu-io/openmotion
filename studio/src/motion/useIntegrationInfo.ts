import { useEffect, useState } from 'react';
import { isIntegrationInfo, type IntegrationInfo } from '../../../shared/integration';

const INTEGRATION_CACHE_TTL_MS = 10_000;
const cacheEnabled = typeof process === 'undefined' || (!process.env?.VITEST && process.env?.NODE_ENV !== 'test');

let cachedIntegration: { value: IntegrationInfo; expiresAt: number } | null = null;
let inflightIntegration: { promise: Promise<IntegrationInfo>; controller: AbortController; subscribers: number } | null = null;

async function fetchIntegration(signal: AbortSignal): Promise<IntegrationInfo> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  for (const endpoint of ['/motion-api/account/integration', '/motion-api/integration', '/connect/integration']) {
    try {
      const response = await fetch(endpoint, { signal: combined });
      if (!response.ok) continue;
      const value = await response.json() as IntegrationInfo;
      if (!isIntegrationInfo(value)) continue;
      return value;
    } catch {
      if (signal.aborted) throw new Error('Aborted');
    }
  }
  throw new Error('Unavailable');
}

function subscribeIntegration(forceRefresh: boolean): { promise: Promise<IntegrationInfo>; cancel: () => void } {
  if (!cacheEnabled) {
    const controller = new AbortController();
    return { promise: fetchIntegration(controller.signal), cancel: () => controller.abort() };
  }
  if (!forceRefresh && cachedIntegration && cachedIntegration.expiresAt > Date.now()) {
    return { promise: Promise.resolve(cachedIntegration.value), cancel: () => {} };
  }
  if (forceRefresh || !inflightIntegration) {
    const controller = new AbortController();
    const entry = {
      controller,
      subscribers: 0,
      promise: fetchIntegration(controller.signal).then(value => {
        cachedIntegration = { value, expiresAt: Date.now() + INTEGRATION_CACHE_TTL_MS };
        return value;
      }),
    };
    inflightIntegration = entry;
    void entry.promise.finally(() => {
      if (inflightIntegration === entry) inflightIntegration = null;
    });
  }
  const active = inflightIntegration!;
  active.subscribers++;
  let cancelled = false;
  return {
    promise: active.promise,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      active.subscribers = Math.max(0, active.subscribers - 1);
      if (active.subscribers === 0 && inflightIntegration === active) {
        inflightIntegration = null;
        active.controller.abort();
      }
    },
  };
}

export function useIntegrationInfo() {
  const [info, setInfo] = useState<IntegrationInfo | null>(() =>
    cacheEnabled && cachedIntegration && cachedIntegration.expiresAt > Date.now()
      ? cachedIntegration.value
      : null,
  );
  const [failed, setFailed] = useState(false), [attempt, retry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const forceRefresh = attempt > 0;
    if (forceRefresh || !cacheEnabled || !cachedIntegration || cachedIntegration.expiresAt <= Date.now()) {
      setInfo(null);
    }
    setFailed(false);
    const sub = subscribeIntegration(forceRefresh);
    void sub.promise
      .then(value => { if (!cancelled) setInfo(value); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      sub.cancel();
    };
  }, [attempt]);
  return { info, failed, retry: () => retry(value => value + 1) };
}
