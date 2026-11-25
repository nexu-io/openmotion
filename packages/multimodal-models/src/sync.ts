import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCuratedShard } from './curated.ts';
import { buildCanonicalModels, computeRegistryStats } from './normalize.ts';
import {
  assertValidShard,
  REGISTRY_SCHEMA_VERSION,
  type ProviderCatalogShard,
  type ProviderInfo,
  type RegistryIndexManifest,
  type RegistrySourceReport,
} from './schema.ts';
import {
  syncAtlasCloudSource,
  syncFalSource,
  syncModelsDevSource,
  syncOpenRouterSource,
  syncReplicateSource,
  type FetchLike,
} from './sources.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_SHARD_BYTES = 950 * 1024; // Stay comfortably under the repository's 1 MiB per-file Git limit.

export interface RunSyncOptions {
  scope?: 'flagship' | 'full';
  outputDir?: string;
  fetcher?: FetchLike;
  sources?: readonly ('curated' | 'fal' | 'atlascloud' | 'models-dev' | 'openrouter' | 'replicate')[];
  dryRun?: boolean;
}

function fitShardBudget(shard: ProviderCatalogShard): ProviderCatalogShard {
  const serialize = (s: ProviderCatalogShard) => JSON.stringify(s, null, 2);
  if (Buffer.byteLength(serialize(shard), 'utf8') <= MAX_SHARD_BYTES) return shard;

  // Step 1: trim long parameter descriptions cleanly without losing any parameter key/type/enum/range.
  const trimmedDescriptions: ProviderCatalogShard = {
    ...shard,
    endpoints: shard.endpoints.map(ep => ({
      ...ep,
      ...(ep.description ? { description: ep.description.slice(0, 160) } : {}),
      parameters: ep.parameters.map(p => ({
        ...p,
        ...(p.description ? { description: p.description.slice(0, 120) } : {}),
      })),
    })),
  };
  if (Buffer.byteLength(serialize(trimmedDescriptions), 'utf8') <= MAX_SHARD_BYTES) return trimmedDescriptions;

  // Step 2: drop parameter descriptions if still above budget (preserve all types/enums/defaults/ranges).
  const compact: ProviderCatalogShard = {
    ...trimmedDescriptions,
    endpoints: trimmedDescriptions.endpoints.map(ep => ({
      ...ep,
      parameters: ep.parameters.map(({ description: _desc, ...rest }) => rest),
    })),
  };
  return compact;
}

async function loadPreviousShard(outputDir: string, shardId: string): Promise<ProviderCatalogShard | null> {
  try {
    const raw = await readFile(path.join(outputDir, 'providers', `${shardId}.json`), 'utf8');
    const parsed = JSON.parse(raw) as ProviderCatalogShard;
    assertValidShard(parsed);
    return parsed.endpoints.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export async function runSync(options: RunSyncOptions = {}): Promise<{
  manifest: RegistryIndexManifest;
  shards: ProviderCatalogShard[];
  reports: RegistrySourceReport[];
}> {
  const scope = options.scope ?? 'flagship';
  const outputDir = options.outputDir ?? path.join(PACKAGE_ROOT, 'data');
  const wanted = new Set(
    options.sources ?? ['curated', 'fal', 'atlascloud', 'models-dev', 'openrouter', 'replicate'],
  );
  const now = new Date().toISOString();

  const shards: ProviderCatalogShard[] = [];
  const reports: RegistrySourceReport[] = [];

  if (wanted.has('curated')) {
    const curated = buildCuratedShard();
    shards.push(curated);
    reports.push({
      source: 'curated',
      status: 'ok',
      fetchedAt: now,
      durationMs: 0,
      endpointCount: curated.endpoints.length,
      withDetailedSchema: curated.endpoints.length,
      note: 'OpenDesign Cloud, OpenAI, Google, ByteDance, Kling, BFL, Ideogram, Recraft, ElevenLabs, and Suno verified profiles.',
    });
  }

  const tasks: Promise<{ shard: ProviderCatalogShard; report: RegistrySourceReport } | null>[] = [];
  if (wanted.has('fal')) tasks.push(syncFalSource({ scope, fetcher: options.fetcher }));
  if (wanted.has('atlascloud')) tasks.push(syncAtlasCloudSource({ scope, fetcher: options.fetcher }));
  if (wanted.has('models-dev')) tasks.push(syncModelsDevSource({ scope, fetcher: options.fetcher }));
  if (wanted.has('openrouter')) tasks.push(syncOpenRouterSource({ scope, fetcher: options.fetcher }));
  if (wanted.has('replicate')) tasks.push(syncReplicateSource({ scope, fetcher: options.fetcher }));

  const settled = await Promise.all(tasks);
  const removedShardIds: string[] = [];
  for (const res of settled) {
    if (!res) continue;
    if (res.shard.endpoints.length > 0) {
      reports.push(res.report);
      shards.push(fitShardBudget(res.shard));
      continue;
    }
    if (res.report.status === 'error') {
      const previous = await loadPreviousShard(outputDir, res.shard.shardId);
      if (previous) {
        shards.push(previous);
        reports.push({
          ...res.report,
          note: `${res.report.note ? `${res.report.note} ` : ''}(preserved previous on-disk shard with ${previous.endpoints.length} endpoints)`,
        });
        continue;
      }
    }
    reports.push(res.report);
    removedShardIds.push(res.shard.shardId);
  }

  for (const shard of shards) {
    assertValidShard(shard);
  }

  const allEndpoints = shards.flatMap(s => s.endpoints);
  const providerMap = new Map<string, ProviderInfo>();
  for (const shard of shards) {
    for (const provider of shard.providers) {
      if (!providerMap.has(provider.id)) providerMap.set(provider.id, provider);
    }
  }

  const canonicalModels = buildCanonicalModels(allEndpoints);
  const stats = computeRegistryStats(allEndpoints, canonicalModels);

  const manifest: RegistryIndexManifest = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    generatedAt: now,
    syncScope: scope,
    shards: shards.map(s => `providers/${s.shardId}.json`),
    providers: [...providerMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    sources: reports,
    stats,
  };

  if (!options.dryRun) {
    const providersDir = path.join(outputDir, 'providers');
    await mkdir(providersDir, { recursive: true });
    for (const shard of shards) {
      const target = path.join(providersDir, `${shard.shardId}.json`);
      const text = `${JSON.stringify(shard, null, 2)}\n`;
      if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
        // Fallback to compact JSON if pretty-printing exceeds 1 MiB.
        await writeFile(target, `${JSON.stringify(shard)}\n`, 'utf8');
      } else {
        await writeFile(target, text, 'utf8');
      }
    }
    for (const staleId of removedShardIds) {
      await rm(path.join(providersDir, `${staleId}.json`), { force: true });
    }
    await writeFile(path.join(outputDir, 'index.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await writeFile(
      path.join(outputDir, 'sources-report.json'),
      `${JSON.stringify({ generatedAt: now, syncScope: scope, stats, sources: reports }, null, 2)}\n`,
      'utf8',
    );
  }

  return { manifest, shards, reports };
}

function isEntryMain(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url)));
}

if (isEntryMain()) {
  const scopeArg = process.argv.find(a => a.startsWith('--scope='))?.split('=')[1];
  const scope = scopeArg === 'full' ? 'full' : 'flagship';
  const dryRun = process.argv.includes('--dry-run');
  const { manifest, reports } = await runSync({ scope, dryRun });
  console.log(`Synced multimodal model registry (${scope}${dryRun ? ', dry-run' : ''}):`);
  for (const r of reports) {
    console.log(
      `  - ${r.source.padEnd(11)} ${r.status.padEnd(7)} endpoints=${String(r.endpointCount).padStart(4)} detailed=${String(r.withDetailedSchema).padStart(4)} (${r.durationMs}ms)${r.note ? ` — ${r.note}` : ''}`,
    );
  }
  console.log(
    `Total: ${manifest.stats.totalEndpoints} endpoints, ${manifest.stats.totalCanonicalModels} canonical models, ${manifest.stats.withDetailedSchema} with detailed parameter schemas.`,
  );
  console.log(`Modalities:`, manifest.stats.byModality);
}
