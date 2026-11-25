import type { CapabilityDefinition } from '../../../shared/capability-registry';
import type { GatewayStatus, Model, GenerationJob, GenerateInput } from '../../../shared/gateway';
import { isClientCacheEnabled } from '../utils/clientCacheMode';
import {
  clearGatewayCacheState,
  getFreshCachedGateway,
  getGatewayCacheGeneration,
  peekCachedGateway,
  saveCachedGateway,
  type LoadedGateway,
} from './gatewayCache';
export type { GatewayStatus, Model, GenerationJob, GenerateInput, Modality, GeneratedAsset } from '../../../shared/gateway';
export { peekCachedGateway, type LoadedGateway } from './gatewayCache';

let inflightModels: Promise<Model[]> | null = null;
let inflightGateway: Promise<LoadedGateway> | null = null;
let gatewayListenerRegistered = false;

export function invalidateGatewayCache(): void {
  clearGatewayCacheState();
  inflightModels = null;
  inflightGateway = null;
}

/** Warms the gateway catalog cache in the background when missing or expired. */
export function prefetchGateway(): void {
  if (!isClientCacheEnabled()) return;
  if (getFreshCachedGateway()) return;
  void loadGateway().catch(() => {});
}

function ensureGatewayInvalidationListener(): void {
  if (gatewayListenerRegistered || typeof window === 'undefined') return;
  gatewayListenerRegistered = true;
  window.addEventListener('motion:gateway-changed', invalidateGatewayCache);
}

export async function gatewayRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (method !== 'GET') invalidateGatewayCache();
  const response = await fetch('/motion-api/' + path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Model gateway request failed'), data.applied === false ? { applied: false } : {});
  return data as T;
}

export async function loadModels(): Promise<Model[]> {
  ensureGatewayInvalidationListener();
  if (inflightModels) return inflightModels;
  const run = (async () => {
    const models: Model[] = []; let offset: number | null = 0;
    do {
      const page: { models: Model[]; nextOffset: number | null } = await gatewayRequest(`models?offset=${offset}&limit=100`);
      models.push(...page.models); offset = page.nextOffset;
    } while (offset !== null && models.length < 5000);
    return models;
  })();
  inflightModels = run;
  return run.finally(() => {
    if (inflightModels === run) inflightModels = null;
  });
}
export async function loadGateway(): Promise<LoadedGateway> {
  ensureGatewayInvalidationListener();
  const cached = getFreshCachedGateway();
  if (cached) return cached;
  if (inflightGateway) return inflightGateway;
  const generation = getGatewayCacheGeneration();
  const run = Promise.all([
    gatewayRequest<GatewayStatus>('models/capabilities'),
    loadModels(),
    gatewayRequest<{ capabilities: CapabilityDefinition[] }>('capabilities?action=catalog')
      .then(res => (Array.isArray(res?.capabilities) ? res.capabilities : undefined))
      .catch(() => undefined),
  ]).then(
    ([status, models, capabilities]) => {
      const result: LoadedGateway = { status, models, ...(capabilities ? { capabilities } : {}) };
      saveCachedGateway(result, generation);
      return result;
    },
  );
  inflightGateway = run;
  return run.finally(() => {
    if (inflightGateway === run) inflightGateway = null;
  });
}

/** Shared entry point for future property panels and other editor consumers. */
export function generateAsset(input: GenerateInput) {
  return gatewayRequest<{ job: GenerationJob }>('generations', 'POST', input);
}
