import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareModels,
  formatComparisonMarkdown,
  getCanonicalModel,
  getEndpoint,
  listCanonicalModels,
  listEndpoints,
  loadRegistry,
  searchModels,
  validateModelParameters,
} from './query.ts';
import { isMultimodalModality, type MultimodalModality, type MultimodalTask } from './schema.ts';

function flagValue(args: string[], prefix: string): string | undefined {
  const hit = args.find(a => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function printHelp(): void {
  console.log(`@openmotion/multimodal-models CLI

Usage:
  npm run models:query -- stats
  npm run models:query -- list [--modality=image|video|audio|3d] [--family=seedance] [--provider=fal] [--task=text-to-video] [--schema-only] [--canonical]
  npm run models:query -- search <query> [--modality=video] [--canonical] [--limit=20]
  npm run models:query -- inspect <id-or-canonical> [--json]
  npm run models:query -- compare <id1> <id2> [id3...] [--json]
  npm run models:query -- validate <endpoint-id> '<json-params>' [--strict]
`);
}

function runCli(argv: string[]): void {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const registry = loadRegistry();
  const asJson = rest.includes('--json');

  if (command === 'stats') {
    if (asJson) {
      console.log(JSON.stringify({ generatedAt: registry.generatedAt, stats: registry.stats, sources: registry.sources }, null, 2));
      return;
    }
    console.log(`Multimodal Models Registry (schema v${registry.schemaVersion}, synced ${registry.generatedAt})`);
    console.log(`Endpoints: ${registry.stats.totalEndpoints} | Canonical models: ${registry.stats.totalCanonicalModels} | Detailed parameter schemas: ${registry.stats.withDetailedSchema}`);
    console.log('By modality:', registry.stats.byModality);
    console.log('By schema quality:', registry.stats.bySchemaQuality);
    console.log('Top families:', Object.entries(registry.stats.byFamily).slice(0, 15).map(([k, v]) => `${k}(${v})`).join(', '));
    return;
  }

  if (command === 'list') {
    const modRaw = flagValue(rest, '--modality=');
    const modality: MultimodalModality | undefined = modRaw && isMultimodalModality(modRaw) ? modRaw : undefined;
    const family = flagValue(rest, '--family=');
    const provider = flagValue(rest, '--provider=');
    const task = flagValue(rest, '--task=') as MultimodalTask | undefined;
    const canonical = rest.includes('--canonical');
    const detailedSchemaOnly = rest.includes('--schema-only');

    if (canonical) {
      const items = listCanonicalModels({ modality, family, provider, task }, registry);
      if (asJson) { console.log(JSON.stringify(items, null, 2)); return; }
      for (const m of items) {
        console.log(`${m.id.padEnd(36)} [${m.modality.padEnd(5)}] ${m.displayName} (${m.providers.join(', ')})`);
      }
      console.log(`\n${items.length} canonical models`);
      return;
    }

    const items = listEndpoints({ modality, family, provider, task, detailedSchemaOnly }, registry);
    if (asJson) { console.log(JSON.stringify(items, null, 2)); return; }
    for (const ep of items) {
      console.log(
        `${ep.id.padEnd(56)} [${ep.modality.padEnd(5)}/${ep.primaryTask.padEnd(23)}] params=${String(ep.parameters.length).padStart(2)} (${ep.schemaQuality})`,
      );
    }
    console.log(`\n${items.length} endpoints`);
    return;
  }

  if (command === 'search') {
    const positional = rest.filter(a => !a.startsWith('--'));
    const query = positional.join(' ');
    const modRaw = flagValue(rest, '--modality=');
    const modality: MultimodalModality | undefined = modRaw && isMultimodalModality(modRaw) ? modRaw : undefined;
    const limit = Number(flagValue(rest, '--limit=') ?? 20);
    const canonical = rest.includes('--canonical');
    const items = searchModels(query, { modality, limit, canonical }, registry);
    if (asJson) { console.log(JSON.stringify(items, null, 2)); return; }
    for (const item of items) {
      const detail = 'parameters' in item ? `params=${item.parameters.length} [${item.schemaQuality}]` : `endpoints=${item.endpointIds.length} [${item.providers.join(', ')}]`;
      console.log(`${item.id.padEnd(52)} ${item.displayName} — ${detail}`);
    }
    return;
  }

  if (command === 'inspect') {
    const target = rest.find(a => !a.startsWith('--'));
    if (!target) { printHelp(); process.exitCode = 1; return; }
    const ep = registry.endpoints[target] ?? getEndpoint(target, registry);
    const canonical = getCanonicalModel(target, registry);
    if (!ep && !canonical) {
      console.error(`Model not found: ${target}`);
      process.exitCode = 1;
      return;
    }
    if (asJson) {
      console.log(JSON.stringify({ endpoint: ep, canonical }, null, 2));
      return;
    }
    const chosen = ep ?? canonical!;
    console.log(`# ${chosen.displayName} (${chosen.id})`);
    console.log(`Creator: ${chosen.creator} | Family: ${chosen.family} | Modality: ${chosen.modality} | Tasks: ${chosen.tasks.join(', ')}`);
    if (chosen.description) console.log(`Description: ${chosen.description}`);
    if (ep) {
      console.log(`Provider: ${ep.provider} | Schema: ${ep.schemaQuality}${ep.schemaUrl ? ` (${ep.schemaUrl})` : ''}`);
      if (ep.pricing?.price !== undefined) {
        console.log(`Pricing: $${ep.pricing.price} ${ep.pricing.currency} (${ep.pricing.unit})`);
      }
      console.log(`\nParameters (${ep.parameters.length}):`);
      console.log('| Wire Key | Standard Key | Type | Required | Default | Values / Bounds |');
      console.log('| --- | --- | --- | --- | --- | --- |');
      for (const p of ep.parameters) {
        const bounds = p.enum?.length
          ? p.enum.join(', ')
          : p.min !== undefined || p.max !== undefined
            ? `${p.min ?? ''}..${p.max ?? ''}${p.step ? ` (step ${p.step})` : ''}`
            : p.maxItems !== undefined
              ? `maxItems=${p.maxItems}`
              : '—';
        const def = p.default !== undefined && typeof p.default !== 'object' ? String(p.default) : '—';
        console.log(`| \`${p.key}\` | ${p.standardKey ? `\`${p.standardKey}\`` : '—'} | ${p.type} | ${p.required ? 'yes' : 'no'} | ${def} | ${bounds} |`);
      }
    }
    if (canonical && canonical.endpointIds.length > 1) {
      console.log(`\nAll endpoints for canonical model \`${canonical.id}\` (${canonical.endpointIds.length}):`);
      for (const id of canonical.endpointIds) console.log(`  - ${id}`);
    }
    return;
  }

  if (command === 'compare') {
    const ids = rest.filter(a => !a.startsWith('--'));
    if (ids.length < 2) {
      console.error('Provide at least two model IDs to compare.');
      process.exitCode = 1;
      return;
    }
    const result = compareModels(ids, registry);
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(formatComparisonMarkdown(result));
    return;
  }

  if (command === 'validate') {
    const positional = rest.filter(a => !a.startsWith('--'));
    const [target, rawJson] = positional;
    if (!target || !rawJson) {
      console.error('Usage: validate <endpoint-id> \'<json-params>\' [--strict]');
      process.exitCode = 1;
      return;
    }
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const strictUnknown = rest.includes('--strict');
    const result = validateModelParameters(target, parsed, { strictUnknown }, registry);
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 1;
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2));
}
