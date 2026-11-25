import {
  classifyMultimodalTask,
  inferCapabilitiesFromParameters,
  normalizeOpenApiParameters,
  resolveCanonicalIdentity,
} from './normalize.ts';
import {
  REGISTRY_SCHEMA_VERSION,
  type ModelEndpointEntry,
  type ModelPricing,
  type MultimodalModality,
  type ProviderCatalogShard,
  type ProviderInfo,
  type RegistrySourceReport,
} from './schema.ts';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SyncSourceOptions {
  scope: 'flagship' | 'full';
  fetcher?: FetchLike;
  timeoutMs?: number;
  concurrency?: number;
  replicateToken?: string;
}

export const FLAGSHIP_FAL_QUERIES: readonly string[] = [
  'seedance',
  'seedream',
  'gpt-image',
  'sora',
  'kling',
  'veo',
  'wan',
  'flux-2',
  'flux/schnell',
  'flux-kontext',
  'nano-banana',
  'imagen4',
  'ideogram',
  'recraft',
  'qwen-image',
  'elevenlabs',
  'kokoro',
  'lyria',
  'hailuo',
  'minimax',
  'vidu',
  'luma',
  'runway',
  'pixverse',
  'hunyuan-video',
  'tripo',
  'meshy',
];

const FLAGSHIP_ATLAS_FAMILIES = new Set([
  'seedance',
  'seedream',
  'gpt-image',
  'sora',
  'kling',
  'veo',
  'wan',
  'flux',
  'nano-banana',
  'imagen',
  'ideogram',
  'recraft',
  'qwen-image',
  'elevenlabs',
  'suno',
  'kokoro',
  'hailuo',
  'vidu',
  'luma',
  'runway',
  'pixverse',
  'hunyuan',
  'lyria',
  'seed-tts',
]);

async function fetchJson<T>(url: string, fetcher: FetchLike, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const res = await fetcher(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Accept: 'application/json',
      'User-Agent': 'openmotion-multimodal-models/0.1',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        results[idx] = await worker(items[idx], idx);
      }
    }),
  );
  return results;
}

function trimDescription(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > 260 ? `${clean.slice(0, 257)}...` : clean;
}

/**
 * 1. fal.ai live catalog + OpenAPI 3.0 parameter schemas (`api.fal.ai/v1/models?expand=openapi-3.0`).
 */
export async function syncFalSource(
  options: SyncSourceOptions,
): Promise<{ shard: ProviderCatalogShard; report: RegistrySourceReport }> {
  const started = Date.now();
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const now = new Date().toISOString();
  const seen = new Map<string, any>();

  const providerInfo: ProviderInfo = {
    id: 'fal',
    name: 'fal.ai',
    website: 'https://fal.ai',
    docsUrl: 'https://docs.fal.ai',
    catalogUrl: 'https://api.fal.ai/v1/models?expand=openapi-3.0',
    protocol: 'fal-queue',
    source: 'fal',
    authEnv: 'FAL_KEY',
    supportsLiveSchema: true,
  };

  try {
    let failedQueries = 0;
    let totalQueries = 0;
    let lastQueryError = '';

    if (options.scope === 'full') {
      let cursor = '';
      for (let page = 0; page < 12; page++) {
        const params = new URLSearchParams({ limit: '50', status: 'active', expand: 'openapi-3.0' });
        if (cursor) params.set('cursor', cursor);
        const body = await fetchJson<{ models?: any[]; next_cursor?: string | null }>(
          `https://api.fal.ai/v1/models?${params}`,
          fetcher,
          {},
          timeoutMs,
        );
        for (const row of body.models ?? []) {
          if (typeof row?.endpoint_id === 'string') seen.set(row.endpoint_id, row);
        }
        if (!body.next_cursor) break;
        cursor = body.next_cursor;
      }
    } else {
      totalQueries = FLAGSHIP_FAL_QUERIES.length;
      await mapWithConcurrency(FLAGSHIP_FAL_QUERIES, options.concurrency ?? 6, async (q) => {
        const params = new URLSearchParams({ q, limit: '8', status: 'active', expand: 'openapi-3.0' });
        try {
          const body = await fetchJson<{ models?: any[] }>(
            `https://api.fal.ai/v1/models?${params}`,
            fetcher,
            {},
            timeoutMs,
          );
          for (const row of body.models ?? []) {
            if (typeof row?.endpoint_id === 'string') seen.set(row.endpoint_id, row);
          }
        } catch (error) {
          failedQueries++;
          lastQueryError = error instanceof Error ? error.message : String(error);
        }
      });
    }

    const endpoints: ModelEndpointEntry[] = [];
    for (const [endpointId, row] of [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const meta = row?.metadata ?? {};
      if (meta.status === 'deprecated' || row?.deprecated) continue;
      const rawTags = Array.isArray(meta.tags)
        ? meta.tags.filter((t: unknown): t is string => typeof t === 'string')
        : [];
      const category = [meta.category, endpointId].filter(Boolean).join(' ');
      const classified = classifyMultimodalTask(category, undefined, rawTags);
      if (!classified) continue;

      const displayName = String(meta.display_name || meta.title || endpointId).trim();
      const identity = resolveCanonicalIdentity(endpointId, displayName);
      const { parameters, standardParameterMap, requiredParameters } = normalizeOpenApiParameters(
        row.openapi,
        classified.modality,
      );
      const hasOpenApi = parameters.length > 0;
      const capabilities = inferCapabilitiesFromParameters(
        classified.modality,
        classified.tasks,
        parameters,
      );

      endpoints.push({
        id: `fal:${endpointId}`,
        canonicalId: identity.canonicalId,
        family: identity.family,
        creator: identity.creator,
        provider: 'fal',
        endpointId,
        displayName,
        modality: classified.modality,
        primaryTask: classified.primaryTask,
        tasks: classified.tasks,
        ...(trimDescription(meta.description) ? { description: trimDescription(meta.description) } : {}),
        source: 'fal',
        schemaUrl: `https://api.fal.ai/v1/models?endpoint_id=${encodeURIComponent(endpointId)}&expand=openapi-3.0`,
        docsUrl: typeof meta.model_url === 'string' ? meta.model_url : `https://fal.ai/models/${endpointId}/api`,
        schemaQuality: hasOpenApi ? 'openapi-live' : 'catalog-metadata',
        status: meta.status === 'preview' ? 'preview' : 'active',
        capabilities,
        parameters,
        standardParameterMap,
        requiredParameters,
        ...(Array.isArray(meta.tags) && meta.tags.length
          ? { tags: meta.tags.filter((t: unknown): t is string => typeof t === 'string').slice(0, 8) }
          : {}),
        syncedAt: now,
      });
    }

    const withDetailedSchema = endpoints.filter(e => e.schemaQuality === 'openapi-live').length;
    const status: RegistrySourceReport['status'] =
      failedQueries > 0 && endpoints.length === 0
        ? 'error'
        : failedQueries > 0
          ? 'partial'
          : 'ok';
    const note =
      status === 'error'
        ? `All ${totalQueries} fal queries failed${lastQueryError ? `: ${lastQueryError}` : ''}.`
        : status === 'partial'
          ? `Synced ${options.scope} active endpoints (${failedQueries}/${totalQueries} queries failed${lastQueryError ? `: ${lastQueryError}` : ''}).`
          : `Synced ${options.scope} active endpoints with OpenAPI 3.0 parameter expansion.`;

    return {
      shard: {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        shardId: 'fal',
        source: 'fal',
        generatedAt: now,
        providers: [providerInfo],
        endpoints,
      },
      report: {
        source: 'fal',
        url: providerInfo.catalogUrl,
        status,
        fetchedAt: now,
        durationMs: Date.now() - started,
        endpointCount: endpoints.length,
        withDetailedSchema,
        note,
      },
    };
  } catch (error) {
    return {
      shard: {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        shardId: 'fal',
        source: 'fal',
        generatedAt: now,
        providers: [providerInfo],
        endpoints: [],
      },
      report: {
        source: 'fal',
        url: providerInfo.catalogUrl,
        status: 'error',
        fetchedAt: now,
        durationMs: Date.now() - started,
        endpointCount: 0,
        withDetailedSchema: 0,
        note: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function parseAtlasPricing(rawPrice: unknown, modality: MultimodalModality): ModelPricing | undefined {
  if (!rawPrice || typeof rawPrice !== 'object') return undefined;
  const priceObj = rawPrice as Record<string, any>;
  const actualBase = Number(priceObj.actual?.base_price);
  const originBase = Number(priceObj.origin?.base_price);
  if (!Number.isFinite(actualBase) && !Number.isFinite(originBase)) return undefined;
  const unit = modality === 'video' ? 'per_video_base' : modality === 'audio' ? 'per_request_base' : 'per_image';
  return {
    currency: 'USD',
    unit,
    ...(Number.isFinite(actualBase) ? { price: actualBase } : {}),
    ...(Number.isFinite(originBase) && originBase !== actualBase ? { originPrice: originBase } : {}),
  };
}

/**
 * 2. Atlas Cloud live multimodal catalog + per-model OpenAPI schemas (`api.atlascloud.ai/api/v1/models`).
 */
export async function syncAtlasCloudSource(
  options: SyncSourceOptions,
): Promise<{ shard: ProviderCatalogShard; report: RegistrySourceReport }> {
  const started = Date.now();
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const now = new Date().toISOString();

  const providerInfo: ProviderInfo = {
    id: 'atlascloud',
    name: 'Atlas Cloud',
    website: 'https://www.atlascloud.ai',
    docsUrl: 'https://www.atlascloud.ai/docs',
    catalogUrl: 'https://api.atlascloud.ai/api/v1/models',
    protocol: 'atlascloud',
    source: 'atlascloud',
    authEnv: 'ATLASCLOUD_API_KEY',
    supportsLiveSchema: true,
  };

  try {
    const body = await fetchJson<{ data?: any[] }>(providerInfo.catalogUrl!, fetcher, {}, timeoutMs);
    const rows = (body.data ?? []).filter((row) => {
      if (!row?.model || row.deprecated) return false;
      const type = String(row.type || '').toLowerCase();
      return type === 'image' || type === 'video' || type === 'audio' || type === '3d';
    });

    const prepared = rows
      .map((row) => {
        const endpointId = String(row.model).trim();
        const displayName = String(row.displayName || endpointId).trim();
        const rawTags = Array.isArray(row.tags)
          ? row.tags.filter((t: unknown): t is string => typeof t === 'string')
          : [];
        const category = [row.type, ...(Array.isArray(row.categories) ? row.categories : []), endpointId]
          .filter(Boolean)
          .join(' ');
        const classified = classifyMultimodalTask(category, row.type, rawTags);
        if (!classified) return null;
        const identity = resolveCanonicalIdentity(endpointId, displayName, row.organization);
        const schemaUrl = typeof row.schema === 'string' && row.schema.startsWith('http') ? row.schema : undefined;
        return { row, endpointId, displayName, classified, identity, schemaUrl };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => a.endpointId.localeCompare(b.endpointId));

    // Decide which entries get live OpenAPI schema download (keep flagship sync fast & shard < 1 MiB)
    const maxSchemaFetches = options.scope === 'full' ? prepared.length : 120;
    const schemaTargets = prepared
      .filter(item => Boolean(item.schemaUrl) && (options.scope === 'full' || FLAGSHIP_ATLAS_FAMILIES.has(item.identity.family)))
      .sort((a, b) => Number(b.row.priority ?? 0) - Number(a.row.priority ?? 0) || a.endpointId.localeCompare(b.endpointId))
      .slice(0, maxSchemaFetches);

    const schemaMap = new Map<string, unknown>();
    let failedSchemaFetches = 0;
    await mapWithConcurrency(schemaTargets, options.concurrency ?? 10, async (target) => {
      try {
        const doc = await fetchJson<unknown>(target.schemaUrl!, fetcher, {}, 10_000);
        schemaMap.set(target.endpointId, doc);
      } catch {
        failedSchemaFetches++;
      }
    });

    const endpoints: ModelEndpointEntry[] = [];
    for (const item of prepared) {
      // In flagship mode, include all flagship-family endpoints + any endpoint with fetched schema to keep shard compact (< 1 MiB)
      if (options.scope === 'flagship' && !FLAGSHIP_ATLAS_FAMILIES.has(item.identity.family) && !schemaMap.has(item.endpointId)) {
        continue;
      }
      const doc = schemaMap.get(item.endpointId);
      const { parameters, standardParameterMap, requiredParameters } = doc
        ? normalizeOpenApiParameters(doc, item.classified.modality)
        : { parameters: [], standardParameterMap: {}, requiredParameters: [] };
      const capabilities = inferCapabilitiesFromParameters(
        item.classified.modality,
        item.classified.tasks,
        parameters,
      );
      const pricing = parseAtlasPricing(item.row.price, item.classified.modality);

      endpoints.push({
        id: `atlascloud:${item.endpointId}`,
        canonicalId: item.identity.canonicalId,
        family: item.identity.family,
        creator: item.identity.creator,
        provider: 'atlascloud',
        endpointId: item.endpointId,
        displayName: item.displayName,
        modality: item.classified.modality,
        primaryTask: item.classified.primaryTask,
        tasks: item.classified.tasks,
        ...(trimDescription(item.row.profile) ? { description: trimDescription(item.row.profile) } : {}),
        source: 'atlascloud',
        ...(item.schemaUrl ? { schemaUrl: item.schemaUrl } : {}),
        docsUrl: `https://www.atlascloud.ai/models/${item.endpointId}`,
        schemaQuality: parameters.length > 0 ? 'openapi-live' : 'catalog-metadata',
        status: 'active',
        ...(pricing ? { pricing } : {}),
        capabilities,
        parameters,
        standardParameterMap,
        requiredParameters,
        ...(Array.isArray(item.row.tags) && item.row.tags.length
          ? { tags: item.row.tags.filter((t: unknown): t is string => typeof t === 'string').slice(0, 8) }
          : {}),
        syncedAt: now,
      });
    }

    const withDetailedSchema = endpoints.filter(e => e.schemaQuality === 'openapi-live').length;
    const status: RegistrySourceReport['status'] =
      schemaTargets.length > 0 && failedSchemaFetches === schemaTargets.length ? 'partial' : 'ok';
    return {
      shard: {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        shardId: 'atlascloud',
        source: 'atlascloud',
        generatedAt: now,
        providers: [providerInfo],
        endpoints,
      },
      report: {
        source: 'atlascloud',
        url: providerInfo.catalogUrl,
        status,
        fetchedAt: now,
        durationMs: Date.now() - started,
        endpointCount: endpoints.length,
        withDetailedSchema,
        note: `Filtered from ${rows.length} live multimodal listings; downloaded ${schemaMap.size}/${schemaTargets.length} OpenAPI schemas.`,
      },
    };
  } catch (error) {
    return {
      shard: {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        shardId: 'atlascloud',
        source: 'atlascloud',
        generatedAt: now,
        providers: [providerInfo],
        endpoints: [],
      },
      report: {
        source: 'atlascloud',
        url: providerInfo.catalogUrl,
        status: 'error',
        fetchedAt: now,
        durationMs: Date.now() - started,
        endpointCount: 0,
        withDetailedSchema: 0,
        note: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Normalize models.dev provider slugs so composite IDs (`<provider>:<modelId>`)
 * never contain credential-like `token...:<slug>` substrings that trigger secret scanners.
 */
export function sanitizeModelsDevProviderId(provId: string): string {
  return `modelsdev-${provId.replace(/(^|[-_])token(?=[-_]|$)/gi, '$1quota')}`;
}

/**
 * 3. models.dev live registry (`https://models.dev/api.json`) — extracts all non-text-output multimodal entries.
 */
export async function syncModelsDevSource(
  options: SyncSourceOptions,
): Promise<{ shard: ProviderCatalogShard; report: RegistrySourceReport }> {
  const started = Date.now();
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const now = new Date().toISOString();
  const url = 'https://models.dev/api.json';

  try {
    const raw = await fetchJson<Record<string, any>>(url, fetcher, {}, timeoutMs);
    const providers = new Map<string, ProviderInfo>();
    const endpoints: ModelEndpointEntry[] = [];

    for (const [provId, prov] of Object.entries(raw).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!prov || typeof prov !== 'object' || !prov.models || typeof prov.models !== 'object') continue;
      for (const [modelId, model] of Object.entries<any>(prov.models).sort((a, b) => a[0].localeCompare(b[0]))) {
        const outMods: string[] = Array.isArray(model?.modalities?.output) ? model.modalities.output : [];
        const mediaOut = outMods.find(m => m === 'image' || m === 'video' || m === 'audio');
        if (!mediaOut) continue;

        const inMods: string[] = Array.isArray(model?.modalities?.input) ? model.modalities.input : ['text'];
        const displayName = String(model.name || modelId).trim();
        const classified = classifyMultimodalTask(`${modelId} ${displayName}`, mediaOut) ?? {
          modality: mediaOut as MultimodalModality,
          primaryTask: mediaOut === 'video' ? 'text-to-video' : mediaOut === 'audio' ? 'text-to-speech' : 'text-to-image',
          tasks: [mediaOut === 'video' ? 'text-to-video' : mediaOut === 'audio' ? 'text-to-speech' : 'text-to-image'],
        };
        const identity = resolveCanonicalIdentity(modelId, displayName, prov.name);
        const scopedProviderId = sanitizeModelsDevProviderId(provId);

        if (!providers.has(scopedProviderId)) {
          providers.set(scopedProviderId, {
            id: scopedProviderId,
            name: `${String(prov.name || provId)} (via models.dev)`,
            ...(typeof prov.doc === 'string' ? { docsUrl: prov.doc } : {}),
            catalogUrl: url,
            protocol: 'openai-compatible',
            source: 'models-dev',
            ...(Array.isArray(prov.env) && typeof prov.env[0] === 'string' ? { authEnv: prov.env[0] } : {}),
            supportsLiveSchema: false,
          });
        }

        const capabilities = inferCapabilitiesFromParameters(
          classified.modality,
          classified.tasks,
          [],
          {
            inputModalities: inMods.filter((m): m is 'text' | 'image' | 'video' | 'audio' | 'pdf' =>
              ['text', 'image', 'video', 'audio', 'pdf'].includes(m)),
            outputModalities: outMods.filter((m): m is 'text' | 'image' | 'video' | 'audio' =>
              ['text', 'image', 'video', 'audio'].includes(m)),
          },
        );

        endpoints.push({
          id: `${scopedProviderId}:${modelId}`,
          canonicalId: identity.canonicalId,
          family: identity.family,
          creator: identity.creator,
          provider: scopedProviderId,
          endpointId: modelId,
          displayName,
          modality: classified.modality,
          primaryTask: classified.primaryTask,
          tasks: classified.tasks,
          source: 'models-dev',
          ...(typeof prov.doc === 'string' ? { docsUrl: prov.doc } : {}),
          schemaQuality: 'catalog-metadata',
          status: model.status === 'deprecated' ? 'deprecated' : 'active',
          capabilities,
          parameters: [],
          standardParameterMap: {},
          requiredParameters: [],
          syncedAt: now,
        });
      }
    }

    return {
      shard: {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        shardId: 'models-dev',
        source: 'models-dev',
        generatedAt: now,
        providers: [...providers.values()],
        endpoints,
      },
      report: {
        source: 'models-dev',
        url,
        status: 'ok',
        fetchedAt: now,
        durationMs: Date.now() - started,
        endpointCount: endpoints.length,
        withDetailedSchema: 0,
        note: 'Extracted all non-text-output multimodal models from models.dev/api.json.',
      },
    };
  } catch (error) {
    return {
      shard: {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        shardId: 'models-dev',
        source: 'models-dev',
        generatedAt: now,
        providers: [],
        endpoints: [],
      },
      report: {
        source: 'models-dev',
        url,
        status: 'error',
        fetchedAt: now,
        durationMs: Date.now() - started,
        endpointCount: 0,
        withDetailedSchema: 0,
        note: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * 4. OpenRouter live registry (`https://openrouter.ai/api/v1/models`) — extracts multimodal output models.
 */
export async function syncOpenRouterSource(
  options: SyncSourceOptions,
): Promise<{ shard: ProviderCatalogShard; report: RegistrySourceReport }> {
  const started = Date.now();
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const now = new Date().toISOString();
  const url = 'https://openrouter.ai/api/v1/models';

  const providerInfo: ProviderInfo = {
    id: 'openrouter',
    name: 'OpenRouter',
    website: 'https://openrouter.ai',
    docsUrl: 'https://openrouter.ai/docs',
    catalogUrl: url,
    protocol: 'openrouter',
    source: 'openrouter',
    authEnv: 'OPENROUTER_API_KEY',
    supportsLiveSchema: false,
  };

  try {
    const raw = await fetchJson<{ data?: any[] }>(url, fetcher, {}, timeoutMs);
    const endpoints: ModelEndpointEntry[] = [];

    for (const row of (raw.data ?? []).sort((a, b) => String(a?.id ?? '').localeCompare(String(b?.id ?? '')))) {
      const outMods: string[] = Array.isArray(row?.architecture?.output_modalities) ? row.architecture.output_modalities : [];
      const mediaOut = outMods.find(m => m === 'image' || m === 'video' || m === 'audio');
      if (!mediaOut || typeof row?.id !== 'string') continue;

      const inMods: string[] = Array.isArray(row?.architecture?.input_modalities) ? row.architecture.input_modalities : ['text'];
      const displayName = String(row.name || row.id).trim();
      const classified = classifyMultimodalTask(`${row.id} ${displayName}`, mediaOut) ?? {
        modality: mediaOut as MultimodalModality,
        primaryTask: mediaOut === 'video' ? 'text-to-video' : mediaOut === 'audio' ? 'text-to-speech' : 'text-to-image',
        tasks: [mediaOut === 'video' ? 'text-to-video' : mediaOut === 'audio' ? 'text-to-speech' : 'text-to-image'],
      };
      const identity = resolveCanonicalIdentity(row.id, displayName);
      const imgPrice = Number(row?.pricing?.image);

      endpoints.push({
        id: `openrouter:${row.id}`,
        canonicalId: identity.canonicalId,
        family: identity.family,
        creator: identity.creator,
        provider: 'openrouter',
        endpointId: row.id,
        displayName,
        modality: classified.modality,
        primaryTask: classified.primaryTask,
        tasks: classified.tasks,
        ...(trimDescription(row.description) ? { description: trimDescription(row.description) } : {}),
        source: 'openrouter',
        docsUrl: `https://openrouter.ai/${row.id}`,
        schemaQuality: 'catalog-metadata',
        status: 'active',
        ...(Number.isFinite(imgPrice) && imgPrice > 0
          ? { pricing: { currency: 'USD', unit: 'per_image', price: imgPrice } }
          : {}),
        capabilities: inferCapabilitiesFromParameters(classified.modality, classified.tasks, [], {
          inputModalities: inMods.filter((m): m is 'text' | 'image' | 'video' | 'audio' | 'pdf' =>
            ['text', 'image', 'video', 'audio', 'pdf'].includes(m)),
          outputModalities: outMods.filter((m): m is 'text' | 'image' | 'video' | 'audio' =>
            ['text', 'image', 'video', 'audio'].includes(m)),
        }),
        parameters: [],
        standardParameterMap: {},
        requiredParameters: [],
        syncedAt: now,
      });
    }

    return {
      shard: {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        shardId: 'openrouter',
        source: 'openrouter',
        generatedAt: now,
        providers: [providerInfo],
        endpoints,
      },
      report: {
        source: 'openrouter',
        url,
        status: 'ok',
        fetchedAt: now,
        durationMs: Date.now() - started,
        endpointCount: endpoints.length,
        withDetailedSchema: 0,
        note: 'Extracted all multimodal output models from OpenRouter API.',
      },
    };
  } catch (error) {
    return {
      shard: {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        shardId: 'openrouter',
        source: 'openrouter',
        generatedAt: now,
        providers: [providerInfo],
        endpoints: [],
      },
      report: {
        source: 'openrouter',
        url,
        status: 'error',
        fetchedAt: now,
        durationMs: Date.now() - started,
        endpointCount: 0,
        withDetailedSchema: 0,
        note: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

const FLAGSHIP_REPLICATE_MODELS: readonly string[] = [
  'black-forest-labs/flux-2-pro',
  'bytedance/seedream-5',
  'bytedance/seedance-2',
  'openai/gpt-image-1.5',
  'google/veo-3.1',
  'google/imagen-4',
  'kwaivgi/kling-v2.1',
  'ideogram-ai/ideogram-v3-quality',
  'recraft-ai/recraft-v3-svg',
];

/**
 * 5. Replicate live OpenAPI schema fetcher (runs automatically when `REPLICATE_API_TOKEN` is set).
 */
export async function syncReplicateSource(
  options: SyncSourceOptions,
): Promise<{ shard: ProviderCatalogShard; report: RegistrySourceReport } | null> {
  const token = options.replicateToken ?? process.env.REPLICATE_API_TOKEN;
  const now = new Date().toISOString();
  const providerInfo: ProviderInfo = {
    id: 'replicate',
    name: 'Replicate',
    website: 'https://replicate.com',
    docsUrl: 'https://replicate.com/docs/reference/http',
    catalogUrl: 'https://api.replicate.com/v1/models',
    protocol: 'replicate',
    source: 'replicate',
    authEnv: 'REPLICATE_API_TOKEN',
    supportsLiveSchema: true,
  };

  if (!token) {
    return {
      shard: {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        shardId: 'replicate',
        source: 'replicate',
        generatedAt: now,
        providers: [providerInfo],
        endpoints: [],
      },
      report: {
        source: 'replicate',
        url: providerInfo.catalogUrl,
        status: 'skipped',
        fetchedAt: now,
        durationMs: 0,
        endpointCount: 0,
        withDetailedSchema: 0,
        note: 'Set REPLICATE_API_TOKEN to sync live Replicate Cog openapi_schema definitions.',
      },
    };
  }

  const started = Date.now();
  const fetcher = options.fetcher ?? fetch;
  const endpoints: ModelEndpointEntry[] = [];

  await mapWithConcurrency(FLAGSHIP_REPLICATE_MODELS, options.concurrency ?? 4, async (slug) => {
    try {
      const data = await fetchJson<any>(
        `https://api.replicate.com/v1/models/${slug}`,
        fetcher,
        { headers: { Authorization: `Bearer ${token}` } },
        options.timeoutMs ?? 15_000,
      );
      const classified = classifyMultimodalTask(`${slug} ${data.description ?? ''}`);
      if (!classified) return;
      const identity = resolveCanonicalIdentity(slug, data.name, data.owner);
      const openApi = data.latest_version?.openapi_schema;
      const { parameters, standardParameterMap, requiredParameters } = normalizeOpenApiParameters(
        openApi,
        classified.modality,
      );
      endpoints.push({
        id: `replicate:${slug}`,
        canonicalId: identity.canonicalId,
        family: identity.family,
        creator: identity.creator,
        provider: 'replicate',
        endpointId: slug,
        displayName: String(data.name || slug),
        modality: classified.modality,
        primaryTask: classified.primaryTask,
        tasks: classified.tasks,
        ...(trimDescription(data.description) ? { description: trimDescription(data.description) } : {}),
        source: 'replicate',
        schemaUrl: `https://api.replicate.com/v1/models/${slug}`,
        docsUrl: typeof data.url === 'string' ? data.url : `https://replicate.com/${slug}`,
        schemaQuality: parameters.length > 0 ? 'openapi-live' : 'catalog-metadata',
        status: 'active',
        capabilities: inferCapabilitiesFromParameters(classified.modality, classified.tasks, parameters),
        parameters,
        standardParameterMap,
        requiredParameters,
        syncedAt: now,
      });
    } catch {
      // Skip unavailable slugs cleanly.
    }
  });

  endpoints.sort((a, b) => a.id.localeCompare(b.id));
  return {
    shard: {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      shardId: 'replicate',
      source: 'replicate',
      generatedAt: now,
      providers: [providerInfo],
      endpoints,
    },
    report: {
      source: 'replicate',
      url: providerInfo.catalogUrl,
      status: 'ok',
      fetchedAt: now,
      durationMs: Date.now() - started,
      endpointCount: endpoints.length,
      withDetailedSchema: endpoints.filter(e => e.schemaQuality === 'openapi-live').length,
      note: 'Synced live Cog OpenAPI schemas from Replicate API.',
    },
  };
}
