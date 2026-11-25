# `@openmotion/multimodal-models`

A standalone, zero-dependency, live-syncable multimodal AI model database and TypeScript contract inside the OpenMotion repository. It tracks **image, video, audio (speech / music / SFX), and 3D** generation and editing models across providers, normalizing their capabilities and configurable parameters into one strongly-typed registry.

## What this package provides

- **Complete erasable TypeScript schema ([src/schema.ts](./src/schema.ts)):** Full types for `MultimodalModality`, `MultimodalTask`, `StandardParameterKey`, `ParameterFieldSchema`, `ModelCapabilities`, `ModelEndpointEntry`, `CanonicalModelRecord`, and `MultimodalRegistry`, compatible with Node `--experimental-strip-types` and strict `tsc`.
- **Closed-vocabulary standard parameter taxonomy + raw wire keys ([src/normalize.ts](./src/normalize.ts)):** Maps provider-specific field names (`ratio`, `aspect_ratio`, `image_size`, `generate_audio`, `audio`, `end_image_url`, `last_frame_url`, `num_images`, `n`, `music_length_ms`, etc.) to canonical `StandardParameterKey`s while keeping every provider's native OpenAPI wire schema intact.
- **Multi-source live sync ([src/sources.ts](./src/sources.ts), [src/sync.ts](./src/sync.ts)):** Pulls live OpenAPI 3.0 parameter schemas and catalogs from public multimodal registries, merges them with curated verified profiles ([src/curated.ts](./src/curated.ts)), and writes deterministic per-provider JSON shards under [data/](./data/) (each kept below the repository's 1 MiB file limit).
- **Query, comparison, validation, and OpenMotion bridge ([src/query.ts](./src/query.ts)):**
  - `loadRegistry()` / `createRegistryFromShards(...)`
  - `listEndpoints(filter)` & `listCanonicalModels(filter)`
  - `getEndpoint(idOrAlias)` & `getCanonicalModel(idOrAlias)`
  - `searchModels(query, options)`
  - `validateModelParameters(endpoint, params)` — accepts either canonical `StandardParameterKey`s or provider-native wire keys, checks types/enums/bounds/dependencies, and emits a resolved wire payload
  - `compareModels(ids)` & `formatComparisonMarkdown(result)` — side-by-side capability and parameter diff matrix
  - `toOpenMotionGenerationOptions(endpoint)` — converts any endpoint's schema into OpenMotion's `GenerationOptions` UI shape

## Quick CLI usage

Run directly from the repository root (using the pinned Node version from `.github/workflows/ci.yml`):

```bash
# Refresh the database from live upstream OpenAPI & model catalogs (flagship scope)
npm run models:sync

# Full catalog sweep (downloads OpenAPI schemas across all active endpoints)
npm --prefix packages/multimodal-models run sync:full

# Print registry statistics and source coverage
npm run models:query -- stats

# List video models that have detailed parameter schemas
npm run models:query -- list --modality=video --schema-only

# Search across all modalities and providers
npm run models:query -- search seedance
npm run models:query -- search "gpt-image"

# Inspect every configurable parameter for a model (wire key, standard key, type, default, enum/range)
npm run models:query -- inspect bytedance/seedance-2.5
npm run models:query -- inspect fal:openai/gpt-image-2.6/sunburst/text-to-image

# Side-by-side comparison matrix (Markdown or --json)
npm run models:query -- compare bytedance/seedance-2.5 kuaishou/kling-3.0-pro google/veo-3.1 openai/sora-2-pro
npm run models:query -- compare openai/gpt-image-2.6-sunburst bytedance/seedream-5.5 bfl/flux-2-pro

# Validate & translate canonical parameters into a provider-native wire payload
npm run models:query -- validate opendesign:doubao-seedance-2-5-260628 '{"prompt":"Ocean waves","aspectRatio":"16:9","duration":10,"generateAudio":true}'
```

## Programmatic usage

```ts
import {
  compareModels,
  formatComparisonMarkdown,
  getEndpoint,
  listEndpoints,
  toOpenMotionGenerationOptions,
  validateModelParameters,
} from './packages/multimodal-models/src/index.ts';

// 1. Find video models with native audio and >= 15s max duration
const longAudioVideos = listEndpoints({
  modality: 'video',
  supportsNativeAudio: true,
  minDurationSeconds: 15,
  detailedSchemaOnly: true,
});

// 2. Inspect & validate parameters using canonical keys
const seedance = getEndpoint('fal:bytedance/seedance-2.5/us/text-to-video')!;
const check = validateModelParameters(seedance, {
  prompt: 'A drone glides over a misty mountain ridge at sunrise',
  aspectRatio: '16:9',
  duration: '10',
  generateAudio: true,
});
console.log(check.valid, check.resolvedPayload);

// 3. Compare models side by side
const diff = compareModels(['bytedance/seedance-2.5', 'google/veo-3.1', 'openai/sora-2-pro']);
console.log(formatComparisonMarkdown(diff));

// 4. Bridge to OpenMotion Studio GenerationOptions UI controls
const uiOptions = toOpenMotionGenerationOptions(seedance);
```

## Data layout

```text
packages/multimodal-models/data/
├── index.json                 # Manifest, provider catalog, source reports, aggregate stats
├── sources-report.json        # Sync audit log (URLs, timestamps, schema coverage, timings)
└── providers/
    ├── curated.json           # Verified OpenDesign Cloud + first-party official API specs
    ├── fal.json               # Live fal.ai endpoints with OpenAPI 3.0 parameter schemas
    ├── atlascloud.json        # Live Atlas Cloud multimodal catalog + OpenAPI schemas + pricing
    ├── models-dev.json        # Live multimodal output models indexed from models.dev
    └── openrouter.json        # Live multimodal output models indexed from OpenRouter
```

Setting `REPLICATE_API_TOKEN` before running `npm run models:sync` additionally enables live `openapi_schema` syncing from Replicate (`providers/replicate.json`).

## Validation & tests

```bash
npm run models:test
```

This runs strict TypeScript checking (`tsc -p packages/multimodal-models/tsconfig.json`) and deterministic unit tests covering OpenAPI normalization, canonical parameter mapping, runtime parameter validation, cross-model comparison, shard integrity, and the OpenMotion `GenerationOptions` bridge.

## Acknowledgements

This package's schema design and live data sources draw on public specifications and open-source community registries:

- **OpenAPI 3.0 live multimodal parameter catalogs:** [fal.ai Platform Models API](https://api.fal.ai/v1/models?expand=openapi-3.0), [Atlas Cloud Models API](https://api.atlascloud.ai/api/v1/models), and [Replicate Cog OpenAPI Schema](https://github.com/replicate/cog).
- **Public model registry catalogs:** [models.dev](https://github.com/anomalyco/models.dev) (`https://models.dev/api.json`) and [OpenRouter Models API](https://openrouter.ai/api/v1/models).
- **Standardized multimodal parameter taxonomy references:** [LobeHub `packages/model-bank`](https://github.com/lobehub/lobehub), [ComfyUI Cloud Partner Nodes](https://github.com/Comfy-Org/ComfyUI), [Vercel AI SDK](https://github.com/vercel/ai), and OpenMotion's own verified endpoint contracts in [shared/generation-options.ts](../../shared/generation-options.ts) and [shared/opendesign-models.ts](../../shared/opendesign-models.ts).
