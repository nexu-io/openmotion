import type { CapabilityDefinition } from '../../../shared/capability-registry';
import type { GatewayStatus, Model } from '../../../shared/gateway';
import { isClientCacheEnabled } from '../utils/clientCacheMode';

export const GATEWAY_CACHE_TTL_MS = 30_000;

export type LoadedGateway = { status: GatewayStatus; models: Model[]; capabilities?: CapabilityDefinition[] };

let cacheGeneration = 0;
let cachedGateway: { value: LoadedGateway; expiresAt: number } | null = null;

export function getGatewayCacheGeneration(): number {
  return cacheGeneration;
}

/** Returns the last cached gateway snapshot (even if stale) for instant Frame-0 UI prefill. */
export function peekCachedGateway(): LoadedGateway | undefined {
  if (!isClientCacheEnabled()) return undefined;
  return cachedGateway?.value;
}

export function getFreshCachedGateway(): LoadedGateway | undefined {
  if (!isClientCacheEnabled() || !cachedGateway) return undefined;
  if (cachedGateway.expiresAt <= Date.now()) return undefined;
  return cachedGateway.value;
}

export function saveCachedGateway(
  value: LoadedGateway,
  generation: number,
): void {
  if (!isClientCacheEnabled() || generation !== cacheGeneration) return;
  cachedGateway = { value, expiresAt: Date.now() + GATEWAY_CACHE_TTL_MS };
}

export function clearGatewayCacheState(): void {
  cacheGeneration++;
  cachedGateway = null;
}
