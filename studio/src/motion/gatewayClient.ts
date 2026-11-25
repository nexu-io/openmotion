import type { GatewayStatus, Model, GenerationJob, GenerateInput } from '../../../shared/gateway';
import { classifyAuthHttpError, notifyAuthRecovery } from './authRecoveryStore';
export type { GatewayStatus, Model, GenerationJob, GenerateInput, Modality, GeneratedAsset } from '../../../shared/gateway';

export type CloudApiError = Error & {
  status?: number;
  code?: string;
  errorCode?: string;
  applied?: boolean;
};

const GATEWAY_CACHE_TTL_MS = 5_000;
const cacheEnabled = typeof process === 'undefined' || (!process.env?.VITEST && process.env?.NODE_ENV !== 'test');

let cacheGeneration = 0;
let cachedGateway: { value: { status: GatewayStatus; models: Model[]; mode?: 'opendesign' | 'mock' }; expiresAt: number } | null = null;
let inflightModels: Promise<Model[]> | null = null;
let inflightGateway: Promise<{ status: GatewayStatus; models: Model[]; mode?: 'opendesign' | 'mock' }> | null = null;
let gatewayListenerRegistered = false;

export function invalidateGatewayCache(): void {
  cacheGeneration++;
  cachedGateway = null;
  inflightModels = null;
  inflightGateway = null;
}

function ensureGatewayInvalidationListener(): void {
  if (gatewayListenerRegistered || typeof window === 'undefined') return;
  gatewayListenerRegistered = true;
  window.addEventListener('motion:gateway-changed', invalidateGatewayCache);
}

export async function gatewayRequest<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  options?: { suppressAuthRecovery?: boolean },
): Promise<T> {
  if (method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') invalidateGatewayCache();
  const response = await fetch('/motion-api/' + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON response body.
  }
  if (!response.ok) {
    const message = typeof data.error === 'string'
      ? data.error
      : data.error && typeof data.error === 'object' && typeof (data.error as { message?: unknown }).message === 'string'
        ? String((data.error as { message: string }).message)
        : `Model gateway request failed (${response.status})`;
    const code = typeof data.code === 'string'
      ? data.code
      : data.error && typeof data.error === 'object' && typeof (data.error as { code?: unknown }).code === 'string'
        ? String((data.error as { code: string }).code)
        : undefined;
    const error = new Error(message) as CloudApiError;
    error.status = response.status;
    if (code) error.code = code;
    if (typeof data.errorCode === 'string') error.errorCode = data.errorCode;
    if (data.applied === false) error.applied = false;
    const authRecovery = classifyAuthHttpError(response.status, data, message);
    const isMutating = method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD';
    if (
      authRecovery &&
      (authRecovery.kind === 'auth_unavailable' || (isMutating && !options?.suppressAuthRecovery))
    ) {
      notifyAuthRecovery(authRecovery);
    }
    throw error;
  }
  return data as T;
}

export async function loadModels(options?: { refresh?: boolean }): Promise<Model[]> {
  ensureGatewayInvalidationListener();
  if (!options?.refresh && inflightModels) return inflightModels;
  const run = (async () => {
    const models: Model[] = [];
    let offset: number | null = 0;
    do {
      const query = new URLSearchParams({ offset: String(offset) });
      if (options?.refresh) query.set('refresh', 'true');
      const page: { models?: Model[]; nextOffset?: number | null } = await gatewayRequest(`models?${query.toString()}`);
      if (Array.isArray(page.models)) models.push(...page.models);
      offset = typeof page.nextOffset === 'number' ? page.nextOffset : null;
    } while (offset !== null && models.length < 5000);
    return models;
  })();
  if (!options?.refresh) inflightModels = run;
  return run.finally(() => {
    if (inflightModels === run) inflightModels = null;
  });
}

function normalizeStatus(raw: Partial<GatewayStatus> | null | undefined): GatewayStatus {
  return {
    providers: Array.isArray(raw?.providers) ? raw.providers : [],
    agents: Array.isArray(raw?.agents) ? raw.agents : [],
    routes: raw?.routes && typeof raw.routes === 'object' ? raw.routes : {},
    capabilities: Array.isArray(raw?.capabilities) ? raw.capabilities : [],
    ...(typeof raw?.consoleUrl === 'string' && raw.consoleUrl ? { consoleUrl: raw.consoleUrl } : {}),
  };
}

function isLegacyRouteNotFound(err: unknown): boolean {
  return (err as CloudApiError | null)?.status === 404;
}

export async function loadGateway(): Promise<{ status: GatewayStatus; models: Model[]; mode?: 'opendesign' | 'mock' }> {
  ensureGatewayInvalidationListener();
  if (cacheEnabled && cachedGateway && cachedGateway.expiresAt > Date.now()) {
    return cachedGateway.value;
  }
  if (inflightGateway) return inflightGateway;
  const generation = cacheGeneration;
  const run = Promise.all([
    gatewayRequest<Partial<GatewayStatus>>('models/status')
      .then(res => (Array.isArray(res?.providers) ? res : gatewayRequest<Partial<GatewayStatus>>('models/capabilities').catch(() => res)))
      .catch((err: unknown) => {
        if (isLegacyRouteNotFound(err)) return gatewayRequest<Partial<GatewayStatus>>('models/capabilities');
        throw err;
      }),
    gatewayRequest<{ models?: Model[]; mode?: 'opendesign' | 'mock' }>('models/catalog')
      .then(async res => (Array.isArray(res?.models) ? res : { models: await loadModels(), mode: res?.mode }))
      .catch(async (err: unknown) => {
        if (isLegacyRouteNotFound(err)) return { models: await loadModels(), mode: undefined };
        throw err;
      }),
  ]).then(([rawStatus, catalog]) => {
    const result = {
      status: normalizeStatus(rawStatus),
      models: Array.isArray(catalog.models) ? catalog.models : [],
      mode: catalog.mode,
    };
    if (cacheEnabled && generation === cacheGeneration) {
      cachedGateway = { value: result, expiresAt: Date.now() + GATEWAY_CACHE_TTL_MS };
    }
    return result;
  });
  inflightGateway = run;
  return run.finally(() => {
    if (inflightGateway === run) inflightGateway = null;
  });
}
/** Shared entry point for future property panels and other editor consumers. */
export function generateAsset(input: GenerateInput) {
  return gatewayRequest<{ job: GenerationJob }>('models/generate', 'POST', input);
}
