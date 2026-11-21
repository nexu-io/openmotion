import { useEffect, useState } from 'react';
import { isIntegrationInfo, type IntegrationInfo } from '../../../shared/integration';

const INTEGRATION_CACHE_TTL_MS = 10_000;
const cacheEnabled = typeof process === 'undefined' || (!process.env?.VITEST && process.env?.NODE_ENV !== 'test');

let cachedIntegration: { value: IntegrationInfo; expiresAt: number } | null = null;
let inflightIntegration: Promise<IntegrationInfo> | null = null;

async function loadIntegrationShared(forceRefresh = false): Promise<IntegrationInfo> {
  if (!forceRefresh && cacheEnabled && cachedIntegration && cachedIntegration.expiresAt > Date.now()) {
    return cachedIntegration.value;
  }
  if (!forceRefresh && inflightIntegration) {
    return inflightIntegration;
  }
  const run = (async () => {
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(8000) : undefined;
    const response = await fetch('/motion-api/integration', signal ? { signal } : undefined);
    if (!response.ok) throw new Error('Unavailable');
    const value = await response.json() as IntegrationInfo;
    if (!isIntegrationInfo(value)) throw new Error('Invalid integration');
    if (cacheEnabled) {
      cachedIntegration = { value, expiresAt: Date.now() + INTEGRATION_CACHE_TTL_MS };
    }
    return value;
  })();
  inflightIntegration = run;
  return run.finally(() => {
    if (inflightIntegration === run) inflightIntegration = null;
  });
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
    void loadIntegrationShared(forceRefresh)
      .then(value => { if (!cancelled) setInfo(value); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [attempt]);
  return { info, failed, retry: () => retry(value => value + 1) };
}
