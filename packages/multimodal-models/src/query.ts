import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GenerationOption, GenerationOptions } from '../../../shared/generation-options.ts';
import { buildCanonicalModels, classifyParameterTier, computeRegistryStats } from './normalize.ts';
import {
  assertValidShard,
  REGISTRY_SCHEMA_VERSION,
  type CanonicalModelRecord,
  type ModelComparisonResult,
  type ModelComparisonRow,
  type ModelEndpointEntry,
  type MultimodalModality,
  type MultimodalRegistry,
  type MultimodalTask,
  type ParameterFieldSchema,
  type ParameterValidationIssue,
  type ParameterValidationResult,
  type ProviderCatalogShard,
  type ProviderInfo,
  type RegistryIndexManifest,
  type RegistrySourceReport,
  type StandardParameterKey,
} from './schema.ts';

const PACKAGE_DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));

let cachedRegistry: MultimodalRegistry | null = null;

/**
 * Build a complete in-memory `MultimodalRegistry` from provider catalog shards.
 * Works identically in Node, tests, and browser bundles without filesystem access.
 */
export function createRegistryFromShards(
  shards: readonly ProviderCatalogShard[],
  meta: {
    generatedAt?: string;
    syncScope?: 'flagship' | 'full';
    sources?: readonly RegistrySourceReport[];
  } = {},
): MultimodalRegistry {
  const providers: Record<string, ProviderInfo> = {};
  const endpoints: Record<string, ModelEndpointEntry> = {};

  for (const shard of shards) {
    assertValidShard(shard);
    for (const provider of shard.providers) {
      if (!providers[provider.id]) providers[provider.id] = provider;
    }
    for (const ep of shard.endpoints) {
      endpoints[ep.id] = ep;
    }
  }

  const endpointList = Object.values(endpoints).sort((a, b) => a.id.localeCompare(b.id));
  const canonicalModels = buildCanonicalModels(endpointList);
  const stats = computeRegistryStats(endpointList, canonicalModels);

  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    generatedAt: meta.generatedAt ?? shards[0]?.generatedAt ?? new Date().toISOString(),
    syncScope: meta.syncScope ?? 'flagship',
    providers,
    endpoints,
    canonicalModels,
    sources: meta.sources ?? [],
    stats,
  };
}

/**
 * Load the persisted registry database from `packages/multimodal-models/data/`.
 */
export function loadRegistry(options: { dataDir?: string; forceReload?: boolean } = {}): MultimodalRegistry {
  const dir = options.dataDir ?? PACKAGE_DATA_DIR;
  if (!options.dataDir && !options.forceReload && cachedRegistry) {
    return cachedRegistry;
  }

  const manifestPath = path.join(dir, 'index.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RegistryIndexManifest;
  const shards: ProviderCatalogShard[] = manifest.shards.map((relPath) =>
    JSON.parse(readFileSync(path.join(dir, relPath), 'utf8')) as ProviderCatalogShard,
  );
  const registry = createRegistryFromShards(shards, {
    generatedAt: manifest.generatedAt,
    syncScope: manifest.syncScope,
    sources: manifest.sources,
  });

  if (!options.dataDir) cachedRegistry = registry;
  return registry;
}

export function clearRegistryCache(): void {
  cachedRegistry = null;
}

export interface EndpointFilter {
  modality?: MultimodalModality;
  task?: MultimodalTask;
  provider?: string;
  family?: string;
  creator?: string;
  schemaQuality?: ModelEndpointEntry['schemaQuality'];
  detailedSchemaOnly?: boolean;
  supportsNativeAudio?: boolean;
  supportsFirstLastFrame?: boolean;
  supportsTransparentBackground?: boolean;
  supportsLayerDecomposition?: boolean;
  hasParameter?: StandardParameterKey | string;
  minReferenceImages?: number;
  minDurationSeconds?: number;
  query?: string;
}

function matchesQuery(needle: string, fields: readonly (string | undefined)[]): boolean {
  const tokens = needle.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const haystack = fields.filter(Boolean).join(' ').toLowerCase();
  return tokens.every(token => haystack.includes(token));
}

export function listEndpoints(
  filter: EndpointFilter = {},
  registry: MultimodalRegistry = loadRegistry(),
): ModelEndpointEntry[] {
  const q = filter.query?.trim();
  return Object.values(registry.endpoints)
    .filter((ep) => {
      if (filter.modality && ep.modality !== filter.modality) return false;
      if (filter.task && !ep.tasks.includes(filter.task)) return false;
      if (filter.provider && ep.provider.toLowerCase() !== filter.provider.toLowerCase()) return false;
      if (filter.family && ep.family.toLowerCase() !== filter.family.toLowerCase()) return false;
      if (filter.creator && ep.creator.toLowerCase() !== filter.creator.toLowerCase()) return false;
      if (filter.schemaQuality && ep.schemaQuality !== filter.schemaQuality) return false;
      if (filter.detailedSchemaOnly && ep.schemaQuality === 'catalog-metadata') return false;
      if (filter.supportsNativeAudio && !ep.capabilities.supportsNativeAudio) return false;
      if (filter.supportsFirstLastFrame && !ep.capabilities.supportsFirstLastFrame) return false;
      if (filter.supportsTransparentBackground && !ep.capabilities.supportsTransparentBackground) return false;
      if (filter.supportsLayerDecomposition && !ep.capabilities.supportsLayerDecomposition) return false;
      if (filter.minReferenceImages !== undefined && (ep.capabilities.maxReferenceImages ?? 0) < filter.minReferenceImages) {
        return false;
      }
      if (filter.minDurationSeconds !== undefined && (ep.capabilities.duration?.max ?? 0) < filter.minDurationSeconds) {
        return false;
      }
      if (filter.hasParameter) {
        const target = filter.hasParameter;
        const matched = Boolean(ep.standardParameterMap[target as StandardParameterKey])
          || ep.parameters.some(p => p.key === target || p.standardKey === target);
        if (!matched) return false;
      }
      if (q && !matchesQuery(q, [ep.id, ep.canonicalId, ep.displayName, ep.family, ep.creator, ep.provider, ep.description, ...(ep.tags ?? []), ...ep.tasks])) {
        return false;
      }
      return true;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface CanonicalModelFilter {
  modality?: MultimodalModality;
  task?: MultimodalTask;
  family?: string;
  creator?: string;
  provider?: string;
  supportsNativeAudio?: boolean;
  supportsFirstLastFrame?: boolean;
  supportsTransparentBackground?: boolean;
  hasParameter?: StandardParameterKey;
  query?: string;
}

export function listCanonicalModels(
  filter: CanonicalModelFilter = {},
  registry: MultimodalRegistry = loadRegistry(),
): CanonicalModelRecord[] {
  const q = filter.query?.trim();
  return Object.values(registry.canonicalModels)
    .filter((model) => {
      if (filter.modality && model.modality !== filter.modality) return false;
      if (filter.task && !model.tasks.includes(filter.task)) return false;
      if (filter.family && model.family.toLowerCase() !== filter.family.toLowerCase()) return false;
      if (filter.creator && model.creator.toLowerCase() !== filter.creator.toLowerCase()) return false;
      if (filter.provider && !model.providers.includes(filter.provider.toLowerCase())) return false;
      if (filter.supportsNativeAudio && !model.capabilities.supportsNativeAudio) return false;
      if (filter.supportsFirstLastFrame && !model.capabilities.supportsFirstLastFrame) return false;
      if (filter.supportsTransparentBackground && !model.capabilities.supportsTransparentBackground) return false;
      if (filter.hasParameter && !model.standardParameters[filter.hasParameter]) return false;
      if (q && !matchesQuery(q, [model.id, model.displayName, model.family, model.creator, model.description, ...(model.tags ?? []), ...model.tasks, ...model.providers])) {
        return false;
      }
      return true;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function endpointQualityScore(ep: ModelEndpointEntry): number {
  const tier = ep.schemaQuality === 'openapi-live' ? 300 : ep.schemaQuality === 'verified-curated' ? 200 : 100;
  return tier + ep.parameters.length;
}

/**
 * Resolve an endpoint by exact ID (`provider:endpointId`), canonical ID (picking the richest schema endpoint),
 * or bare `endpointId` (preferring detailed schemas over metadata-only listings).
 */
export function getEndpoint(
  idOrAlias: string,
  registry: MultimodalRegistry = loadRegistry(),
): ModelEndpointEntry | undefined {
  if (registry.endpoints[idOrAlias]) return registry.endpoints[idOrAlias];
  const lower = idOrAlias.trim().toLowerCase();

  // 1. Exact case-insensitive match on full `provider:endpointId`
  const exactFullId = Object.values(registry.endpoints).find(ep => ep.id.toLowerCase() === lower);
  if (exactFullId) return exactFullId;

  // 2. Canonical model ID -> pick its highest-quality endpoint (already ranked by schema quality + param count)
  const canonical = registry.canonicalModels[lower]
    ?? Object.values(registry.canonicalModels).find(m => m.id.toLowerCase() === lower);
  if (canonical?.endpointIds.length) {
    return registry.endpoints[canonical.endpointIds[0]];
  }

  // 3. Fallback to bare `endpointId` match, preferring detailed schemas
  const bareMatches = Object.values(registry.endpoints)
    .filter(ep => ep.endpointId.toLowerCase() === lower)
    .sort((a, b) => endpointQualityScore(b) - endpointQualityScore(a) || a.id.localeCompare(b.id));
  return bareMatches[0];
}

export function getCanonicalModel(
  idOrAlias: string,
  registry: MultimodalRegistry = loadRegistry(),
): CanonicalModelRecord | undefined {
  if (registry.canonicalModels[idOrAlias]) return registry.canonicalModels[idOrAlias];
  const lower = idOrAlias.trim().toLowerCase();
  const byId = Object.values(registry.canonicalModels).find(
    m => m.id.toLowerCase() === lower || m.displayName.toLowerCase() === lower,
  );
  if (byId) return byId;
  const ep = getEndpoint(idOrAlias, registry);
  return ep ? registry.canonicalModels[ep.canonicalId] : undefined;
}

export function searchModels(
  query: string,
  options: { modality?: MultimodalModality; limit?: number; canonical?: boolean } = {},
  registry: MultimodalRegistry = loadRegistry(),
): (ModelEndpointEntry | CanonicalModelRecord)[] {
  const limit = options.limit ?? 20;
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const candidates: (ModelEndpointEntry | CanonicalModelRecord)[] = options.canonical
    ? listCanonicalModels({ modality: options.modality }, registry)
    : listEndpoints({ modality: options.modality }, registry);

  if (!tokens.length) return candidates.slice(0, limit);

  const scored = candidates
    .map((item) => {
      const id = item.id.toLowerCase();
      const name = item.displayName.toLowerCase();
      const family = item.family.toLowerCase();
      const creator = item.creator.toLowerCase();
      const desc = (item.description ?? '').toLowerCase();
      const tags = (item.tags ?? []).join(' ').toLowerCase();
      const full = `${id} ${name} ${family} ${creator} ${tags} ${item.tasks.join(' ')} ${desc}`;
      if (!tokens.every(t => full.includes(t))) return null;

      let score = 0;
      for (const t of tokens) {
        if (id === t || name === t) score += 100;
        else if (id.includes(t)) score += 35;
        if (name.includes(t)) score += 30;
        if (family === t) score += 25;
        else if (family.includes(t)) score += 15;
        if (creator.includes(t)) score += 10;
        if (tags.includes(t)) score += 8;
      }
      if ('schemaQuality' in item) {
        if (item.schemaQuality === 'openapi-live') score += 12;
        else if (item.schemaQuality === 'verified-curated') score += 10;
      }
      return { item, score };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));

  return scored.slice(0, limit).map(s => s.item);
}

/**
 * Extract default parameter values for an endpoint (keyed by provider-native wire keys).
 */
export function extractEndpointDefaults(endpoint: ModelEndpointEntry): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const param of endpoint.parameters) {
    if (param.default !== undefined) {
      defaults[param.key] = param.default;
    }
  }
  return defaults;
}

function checkFieldType(field: ParameterFieldSchema, value: unknown): boolean {
  switch (field.type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    case 'enum':
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  }
}

/**
 * Validate caller parameters (supporting both canonical `StandardParameterKey`s and provider wire keys)
 * against a model endpoint's declared parameter schema, and translate them into a provider-native payload.
 */
export function validateModelParameters(
  endpointOrId: string | ModelEndpointEntry,
  input: Record<string, unknown>,
  options: { strictUnknown?: boolean } = {},
  registry: MultimodalRegistry = loadRegistry(),
): ParameterValidationResult {
  const endpoint = typeof endpointOrId === 'string' ? getEndpoint(endpointOrId, registry) : endpointOrId;
  if (!endpoint) {
    return {
      valid: false,
      issues: [{ key: 'model', code: 'unknown_parameter', message: `Unknown model endpoint: ${String(endpointOrId)}` }],
      defaults: {},
      resolvedPayload: {},
    };
  }

  const defaults = extractEndpointDefaults(endpoint);
  const byWireKey = new Map(endpoint.parameters.map(p => [p.key, p]));
  const issues: ParameterValidationIssue[] = [];
  // Keep schema defaults out of `resolvedPayload` so unchanged fields stay omitted
  // and inherit saved/provider defaults (`defaults` is returned separately).
  const resolvedPayload: Record<string, unknown> = {};

  // Translate canonical standard keys -> provider-native wire keys when wire key isn't directly provided.
  for (const [rawKey, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (byWireKey.has(rawKey)) {
      resolvedPayload[rawKey] = value;
      continue;
    }
    const mappedWire = endpoint.standardParameterMap[rawKey as StandardParameterKey];
    if (mappedWire && byWireKey.has(mappedWire)) {
      if (!(mappedWire in input)) {
        resolvedPayload[mappedWire] = value;
      }
      continue;
    }
    if (options.strictUnknown) {
      issues.push({
        key: rawKey,
        code: 'unknown_parameter',
        message: `Parameter "${rawKey}" is not declared on ${endpoint.id}.`,
      });
    } else {
      resolvedPayload[rawKey] = value;
    }
  }

  for (const field of endpoint.parameters) {
    const val = resolvedPayload[field.key];
    if (val === undefined || val === null) {
      if (field.required) {
        issues.push({
          key: field.key,
          standardKey: field.standardKey,
          code: 'missing_required',
          message: `Required parameter "${field.key}" (${field.label}) is missing.`,
        });
      }
      continue;
    }

    // Allow custom object dimensions for allowCustom enum fields (e.g. fal image_size: { width, height })
    if (field.type === 'enum' && field.allowCustom && typeof val === 'object' && val !== null && !Array.isArray(val)) {
      continue;
    }

    if (!checkFieldType(field, val)) {
      issues.push({
        key: field.key,
        standardKey: field.standardKey,
        code: 'invalid_type',
        message: `Parameter "${field.key}" expects ${field.type}, received ${Array.isArray(val) ? 'array' : typeof val}.`,
      });
      continue;
    }

    if (field.enum?.length && !field.allowCustom) {
      const allowed = field.enum;
      const matches = allowed.includes(val as string | number | boolean)
        || (typeof val === 'number' && allowed.includes(String(val)))
        || (typeof val === 'string' && /^\d+(?:\.\d+)?$/.test(val) && allowed.includes(Number(val)));
      if (!matches) {
        issues.push({
          key: field.key,
          standardKey: field.standardKey,
          code: 'invalid_enum',
          message: `Parameter "${field.key}" must be one of [${allowed.join(', ')}], received ${JSON.stringify(val)}.`,
        });
      }
    }

    if (typeof val === 'number') {
      if (field.min !== undefined && val < field.min) {
        issues.push({
          key: field.key,
          standardKey: field.standardKey,
          code: 'out_of_range',
          message: `Parameter "${field.key}" must be >= ${field.min} (received ${val}).`,
        });
      }
      if (field.max !== undefined && val > field.max) {
        issues.push({
          key: field.key,
          standardKey: field.standardKey,
          code: 'out_of_range',
          message: `Parameter "${field.key}" must be <= ${field.max} (received ${val}).`,
        });
      }
    }

    if (Array.isArray(val)) {
      if (field.minItems !== undefined && val.length < field.minItems) {
        issues.push({
          key: field.key,
          standardKey: field.standardKey,
          code: 'invalid_length',
          message: `Parameter "${field.key}" requires at least ${field.minItems} items.`,
        });
      }
      if (field.maxItems !== undefined && val.length > field.maxItems) {
        issues.push({
          key: field.key,
          standardKey: field.standardKey,
          code: 'invalid_length',
          message: `Parameter "${field.key}" accepts at most ${field.maxItems} items (received ${val.length}).`,
        });
      }
    }

    if (typeof val === 'string') {
      if (field.minLength !== undefined && val.length < field.minLength) {
        issues.push({
          key: field.key,
          standardKey: field.standardKey,
          code: 'invalid_length',
          message: `Parameter "${field.key}" must be at least ${field.minLength} characters.`,
        });
      }
      if (field.maxLength !== undefined && val.length > field.maxLength) {
        issues.push({
          key: field.key,
          standardKey: field.standardKey,
          code: 'invalid_length',
          message: `Parameter "${field.key}" must be at most ${field.maxLength} characters.`,
        });
      }
    }

    // Cross-field requirements (e.g. resolution="4k" requires ratio="16:9")
    const choiceMeta = field.choices?.find(c => c.value === val);
    if (choiceMeta?.requires?.length) {
      for (const req of choiceMeta.requires) {
        const siblingVal = resolvedPayload[req.field] ?? defaults[req.field];
        if (!req.values.includes(siblingVal as string | number | boolean)) {
          issues.push({
            key: field.key,
            standardKey: field.standardKey,
            code: 'dependency_mismatch',
            message: `Parameter "${field.key}=${String(val)}" requires "${req.field}" to be one of [${req.values.join(', ')}].`,
          });
        }
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    defaults,
    resolvedPayload,
  };
}

function summarizeParam(param: ParameterFieldSchema | undefined): string {
  if (!param) return '—';
  const parts: string[] = [];
  if (param.enum?.length) {
    const shown = param.enum.length > 6
      ? `${param.enum.slice(0, 5).join(', ')}, … (${param.enum.length})`
      : param.enum.join(', ');
    parts.push(`[${shown}]`);
  } else if (param.min !== undefined || param.max !== undefined) {
    parts.push(`${param.min ?? '?'}..${param.max ?? '?'}`);
  } else if (param.type === 'array' && param.maxItems !== undefined) {
    parts.push(`array(max ${param.maxItems})`);
  } else {
    parts.push(param.type);
  }
  if (param.default !== undefined && typeof param.default !== 'object') {
    parts.push(`def=${String(param.default)}`);
  }
  return parts.join(' ');
}

function getStandardParamRecord(
  model: ModelEndpointEntry | CanonicalModelRecord,
): Partial<Record<StandardParameterKey, ParameterFieldSchema>> {
  if ('standardParameters' in model) return model.standardParameters;
  const out: Partial<Record<StandardParameterKey, ParameterFieldSchema>> = {};
  for (const p of model.parameters) {
    if (p.standardKey && !out[p.standardKey]) out[p.standardKey] = p;
  }
  return out;
}

/**
 * Compare 2+ multimodal endpoints or canonical models side by side across capabilities and configurable parameters.
 */
export function compareModels(
  ids: readonly string[],
  registry: MultimodalRegistry = loadRegistry(),
): ModelComparisonResult {
  const models: (ModelEndpointEntry | CanonicalModelRecord)[] = [];
  for (const id of ids) {
    const ep = registry.endpoints[id];
    if (ep) {
      models.push(ep);
      continue;
    }
    const canonical = getCanonicalModel(id, registry) ?? getEndpoint(id, registry);
    if (!canonical) throw new Error(`Model not found in registry: ${id}`);
    models.push(canonical);
  }

  const paramMaps = models.map(m => getStandardParamRecord(m));
  const allStdKeys = [...new Set(paramMaps.flatMap(m => Object.keys(m) as StandardParameterKey[]))].sort();
  const sharedStandardParameters = allStdKeys.filter(k => paramMaps.every(m => Boolean(m[k])));
  const uniqueStandardParameters: Record<string, StandardParameterKey[]> = {};
  models.forEach((m, i) => {
    uniqueStandardParameters[m.id] = allStdKeys.filter(
      k => Boolean(paramMaps[i][k]) && paramMaps.every((other, j) => j === i || !other[k]),
    );
  });

  const rows: ModelComparisonRow[] = [];
  const addRow = (
    attribute: string,
    category: ModelComparisonRow['category'],
    getter: (m: ModelEndpointEntry | CanonicalModelRecord, idx: number) => string,
  ) => {
    const values: Record<string, string> = {};
    models.forEach((m, i) => {
      values[m.id] = getter(m, i);
    });
    rows.push({ attribute, category, values });
  };

  addRow('Creator', 'meta', m => m.creator);
  addRow('Modality', 'meta', m => m.modality);
  addRow('Tasks', 'meta', m => m.tasks.join(', '));
  addRow('Providers', 'meta', m => ('providers' in m ? m.providers.join(', ') : m.provider));
  addRow('Schema Quality', 'meta', m => ('schemaQuality' in m ? m.schemaQuality : `${m.endpointIds.length} endpoints`));
  addRow('Inputs -> Outputs', 'capability', m => `${m.capabilities.inputModalities.join('+')} -> ${m.capabilities.outputModalities.join('+')}`);
  addRow('Aspect Ratios', 'capability', m => m.capabilities.aspectRatios?.join(', ') ?? '—');
  addRow('Resolutions / Sizes', 'capability', m => (m.capabilities.resolutions ?? m.capabilities.sizes)?.join(', ') ?? '—');
  addRow('Duration (s)', 'capability', m => {
    const d = m.capabilities.duration;
    if (!d) return '—';
    const range = d.min !== undefined && d.max !== undefined ? `${d.min}–${d.max}s` : (d.values?.join(', ') ?? '—');
    return `${range}${d.supportsAuto ? ' (+auto)' : ''}`;
  });
  addRow('Max Ref Images', 'capability', m => m.capabilities.maxReferenceImages !== undefined ? String(m.capabilities.maxReferenceImages) : '—');
  addRow('Native Audio', 'capability', m => m.capabilities.nativeAudioAlwaysOn ? 'Always on' : m.capabilities.supportsNativeAudio ? 'Toggle' : 'No');
  addRow('First + Last Frame', 'capability', m => m.capabilities.supportsFirstLastFrame ? 'Yes' : 'No');
  addRow('Transparent BG', 'capability', m => m.capabilities.supportsTransparentBackground ? 'Yes' : 'No');

  for (const key of allStdKeys) {
    if (key === 'prompt') continue;
    addRow(`param:${key}`, 'parameter', (_m, i) => summarizeParam(paramMaps[i][key]));
  }

  return { models, rows, sharedStandardParameters, uniqueStandardParameters };
}

export function formatComparisonMarkdown(comparison: ModelComparisonResult): string {
  const headers = ['Attribute', ...comparison.models.map(m => `${m.displayName} (\`${m.id}\`)`)];
  const sep = headers.map(() => '---');
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...comparison.rows.map(row => `| ${row.attribute} | ${comparison.models.map(m => row.values[m.id] ?? '—').join(' | ')} |`),
  ];
  return lines.join('\n');
}

/**
 * Bridge helper: convert a registry `ModelEndpointEntry` into OpenMotion's shared `GenerationOptions` UI contract.
 */
export function toOpenMotionGenerationOptions(endpoint: ModelEndpointEntry): GenerationOptions {
  const fields: GenerationOption[] = [];

  for (const [index, p] of endpoint.parameters.entries()) {
    if (p.standardKey === 'prompt' || p.type === 'array' || p.type === 'object') continue;
    if (p.standardKey === 'inputImage' || p.standardKey === 'endImage' || p.standardKey === 'maskImage' || p.standardKey === 'inputVideo' || p.standardKey === 'inputAudio') {
      continue;
    }

    const tier = p.tier ?? classifyParameterTier(endpoint.modality, p.key, p.standardKey, p.type);
    const sharedMeta = {
      ...(p.standardKey ? { standardKey: p.standardKey } : {}),
      tier,
      uiOrder: p.uiOrder ?? index,
      ...(p.description ? { description: p.description } : {}),
    };

    if (p.type === 'enum' && p.enum?.length) {
      const primitiveChoices = p.enum.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
      if (!primitiveChoices.length) continue;
      const choiceMetaByValue = new Map(p.choices?.map(c => [c.value, c]) ?? []);
      fields.push({
        key: p.key,
        label: p.label,
        kind: 'choice',
        choices: primitiveChoices.map((value) => {
          const meta = choiceMetaByValue.get(value);
          const requires = meta?.requires?.length
            ? Object.fromEntries(
                meta.requires
                  .filter(r => r.values.length > 0 && (typeof r.values[0] === 'string' || typeof r.values[0] === 'number'))
                  .map(r => [r.field, r.values[0] as string | number]),
              )
            : undefined;
          return {
            value,
            label: meta?.label ?? String(value),
            ...(requires && Object.keys(requires).length ? { requires } : {}),
          };
        }),
        ...(typeof p.default === 'string' || typeof p.default === 'number' ? { default: p.default } : {}),
        ...(p.standardKey === 'aspectRatio' || p.key === 'image_size' ? { presentation: 'ratio' as const } : {}),
        ...(p.standardKey === 'count' ? { presentation: 'count' as const } : {}),
        ...(p.required ? { required: true } : {}),
        ...(p.allowCustom ? { allowCustom: true } : {}),
        ...sharedMeta,
      });
    } else if (p.type === 'boolean') {
      fields.push({
        key: p.key,
        label: p.label,
        kind: 'boolean',
        ...(typeof p.default === 'boolean' ? { default: p.default } : {}),
        ...(p.required ? { required: true } : {}),
        ...sharedMeta,
      });
    } else if (p.type === 'integer' || p.type === 'number') {
      fields.push({
        key: p.key,
        label: p.label,
        kind: 'number',
        ...(typeof p.default === 'number' ? { default: p.default } : {}),
        ...(p.min !== undefined ? { min: p.min } : {}),
        ...(p.max !== undefined ? { max: p.max } : {}),
        step: p.step ?? (p.type === 'integer' ? 1 : 0.1),
        ...(p.standardKey === 'count' ? { presentation: 'count' as const } : {}),
        ...(p.required ? { required: true } : {}),
        ...sharedMeta,
      });
    } else if (p.type === 'string') {
      fields.push({
        key: p.key,
        label: p.label,
        kind: 'text',
        ...(typeof p.default === 'string' ? { default: p.default } : {}),
        ...(p.required ? { required: true } : {}),
        ...sharedMeta,
      });
    }
  }

  fields.sort((a, b) => (a.uiOrder ?? Number.MAX_SAFE_INTEGER) - (b.uiOrder ?? Number.MAX_SAFE_INTEGER));

  const delivery: GenerationOptions['delivery'] =
    endpoint.provider === 'codex' || endpoint.tags?.includes('prompt-delivery') ? 'prompt' : 'provider';

  return { delivery, fields };
}
