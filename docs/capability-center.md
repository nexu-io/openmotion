# Unified Capability Center & Plug-in Guide

OpenMotion's **Unified Capability Center** (`shared/capability-registry.ts` + `gateway/capability-center.ts`) provides one declarative source of truth for atomic and generative media capabilities across **Studio GUI menus/composers**, **HTTP `/api/capabilities`**, and **MCP 4 Meta-Tools** (`openmotion_capability_discover`, `openmotion_capability_run`, `openmotion_job_manage`, `openmotion_asset_manage`).

---

## 1. Architecture Overview

1. **Single registration, dual-surface propagation**:
   - Every capability in `shared/capability-registry.ts` defines its `id`, `modality`, `status` (`live | coming_soon | deprecated | hidden`), per-channel switches (`channels: { gui, mcp }`), structured `input.controls`, reference limits, `costTier`, and `executor`.
   - Studio GUI (`ImageMegaMenu`, `VideoMegaMenu`, `AudioNavMenu`, `AssetComposer`, `creationModels`) and MCP (`openmotion_capability_discover` / `openmotion_capability_run`) consume the exact same definitions.
2. **Immutable provenance for partial edits**:
   - Every generated `AssetVersion` in Workspace Assets records `capabilityId` and `capabilityOptions` alongside `model`, `parameters`, `references`, and `parentVersionId`, allowing Agents to re-run only the affected asset during round-2 edits.
3. **Three-layer hot configuration**:
   - `defaultCapabilities` (shipped baseline) → `capabilities-remote-cache.json` (synced from Cloud) → `capabilities-override.json` (workspace local override).

---

## 2. How to Plug In or Swap Executors (Zero UI / MCP Schema Code Changes)

### Recipe A: Light up or swap to a dedicated model (`dedicated-model`)

When AMR or a BYOK provider exposes a dedicated endpoint (for example background removal, 4K upscale, inpainting, or lip-sync) that accepts structured parameters rather than prompt templates, update the entry in `shared/capability-registry.ts` (or push an override JSON):

```ts
{
  id: 'upscale-4k',
  status: 'live',
  channels: { gui: true, mcp: true },
  executor: {
    kind: 'dedicated-model',
    providers: ['opendesign', 'account', 'fal'],
    models: ['real-esrgan-4k'],
    recommendedModel: 'real-esrgan-4k',
    mode: 'text-to-image',
    defaultParameters: { output_format: 'png' },
    optionToParameter: { scale: 'upscale_factor' },
  },
}
```

- Studio's `ImageMegaMenu` automatically promotes `4K Upscale` from *Coming soon* to active;
- `AssetComposer` automatically renders the `scale` dropdown (`4x` / `2x`);
- `openmotion_capability_discover(action="describe", capabilityId="upscale-4k")` exposes the `scale` JSON Schema and maps `options.scale` to `parameters.upscale_factor`.

### Recipe B: Plug in a deterministic local script (`script`)

1. Add a handler in `gateway/capability-scripts.ts`:
   ```ts
   export const builtinCapabilityScripts: Record<string, CapabilityScriptHandler> = {
     'ffmpeg-stem-extract': async ({ store, references, options }) => {
       // Process references[0].filename into a temp output file...
       return { sourcePath: outputFile, name: 'Extracted Vocal', cleanup: () => rm(outputFile, { force: true }) };
     },
   };
   ```
2. Point the capability in `shared/capability-registry.ts` (or override JSON) to `executor: { kind: 'script', scriptId: 'ffmpeg-stem-extract' }`.
   Request deduplication (`requestId`), conflict checks (`REQUEST_ID_CONFLICT`), and `AssetLibrary` version provenance are handled automatically by `capabilityRun`.

### Recipe C: Two-step soft deprecation of an underused capability

Set `status: 'deprecated'` (or `'hidden'`) and optional `replacementCapabilityId` in `shared/capability-registry.ts` or remote overrides:

```json
{
  "overrides": [
    { "id": "legacy-filter", "status": "deprecated", "replacementCapabilityId": "image-edit" }
  ]
}
```

- Immediately hides the item from GUI menus and `openmotion_capability_discover(action="list")` (zero context bloat);
- Historical assets keep their `capabilityId` metadata; direct calls return `CAPABILITY_DEPRECATED` naming `image-edit`.

### Recipe D: Wire Cloud Remote Config & Real-Time Spend Quotes

- **Remote hot-config**: Set `OPENMOTION_CAPABILITY_CONFIG_URL` or register `setCapabilityRemoteConfigFetcher(fetcher)` in `gateway/capability-center.ts` (triggered via `POST /motion-api/capabilities/sync` or `openmotion_capability_discover` with `refresh: true`).
- **Real-time credit/spend quotes**: Register `registerCapabilityQuoteEstimator(estimator)` in `gateway/capability-center.ts` to replace the static tier fallback behind `openmotion_capability_discover(action="quote")` and `openmotion_capability_run(dryRun=true)`.

---

## 3. Architecture Verification & Context Scaling Benchmark

The Unified Capability Center and two-layer progressive Skill layout (`skills/` core resident + `library/skills/` on-demand vertical packs) were verified against the pre-change `main` baseline (`3aa94dfce`) across context scaling, deterministic gateway contracts, and live dual-surface hot-swapping.

### 3.1 Turn-0 Static Context Scaling (`11 → 60` Capabilities)

Measured as exact UTF-8 bytes of the turn-0 static payload injected into every session (`tools/list` JSON schemas + `phase1.instructions` + resident `skills/openmotion-media/SKILL.md`, estimated at `~3.8 bytes/token`):

- **Legacy 3 media/asset tools** (`openmotion_media_use`, `openmotion_assets_use`, `openmotion_assets`): `31,054 B` (`~8,172` tokens) due to repeated inline sub-schemas.
- **New 4 Capability Center meta-tools** (`openmotion_capability_discover`, `openmotion_capability_run`, `openmotion_job_manage`, `openmotion_asset_manage`): `14,902 B` (`~3,922` tokens, **-52%** smaller).

| Capability & Vertical SOP Scale | Naive Flat Scaling<br>*(1 capability = 1 tool + resident SOPs)* | Pre-Change `main`<br>*(22 Tools)* | Dual-Track Transition<br>*(26 Tools, compat active)* | **Steady State (Legacy Retired)**<br>*(23 Tools)* |
| --- | --- | --- | --- | --- |
| **Current live** (11 caps + 0 vertical) | 30 Tools · `67,052 B` (~17,646 tok) | 22 Tools · `87,008 B` (~22,897 tok) | 26 Tools · `101,909 B` (~26,819 tok) | **23 Tools · `70,856 B` (~18,647 tok)** |
| **Catalog full rollout** (31 caps + 5 vertical) | 50 Tools · `109,188 B` (~28,734 tok) | *Cannot express dedicated schemas* | 26 Tools · `101,909 B` (~26,819 tok) | **23 Tools · `70,856 B` (~18,647 tok)** |
| **Mid-term scale** (40 caps + 10 vertical) | 59 Tools · `141,705 B` (~37,291 tok) | *Cannot express dedicated schemas* | 26 Tools · `101,909 B` (~26,819 tok) | **23 Tools · `70,856 B` (-50.0% vs flat)** |
| **Long-term matrix** (60 caps + 15 vertical) | 79 Tools · `188,060 B` (~49,490 tok) | *Cannot express dedicated schemas* | 26 Tools · `101,909 B` (~26,819 tok) | **23 Tools · `70,856 B` (-62.3% vs flat)** |

> **Dual-track transition note**: Keeping the 3 legacy compatibility tools registered during rollout temporarily adds `+3,922` static tokens (`+17.1%` vs `main`) so active sessions and in-flight jobs migrate safely. Once telemetry confirms legacy calls have drained, removing those 3 aliases from `shared/mcp-profiles.json` drops steady-state turn-0 payload to `70,856 B` (**`-18.6%` vs `main`**, strictly `O(1)` as capabilities scale).

### 3.2 Gateway Guard & Contract Verification (20 Deterministic Cases)

| Verification Slice | Covered Scenarios | Gateway Guarantee |
| --- | --- | --- |
| **Structured parameter injection & routing** (`A1–A5`) | `remove-background` transparent alpha, `relight` lighting enum, multi-ref `character` consistency, `native-audio` audio flag, `dedicated-model` `optionToParameter` | Auto-injects required defaults (`background: "transparent"`, `generate_audio: true`), rejects invalid enums with `invalid_enum` at zero spend, filters incompatible single-ref models, and translates control IDs to vendor fields. |
| **Unreleased boundaries, deprecation & channels** (`B1–B5`) | `lipsync`, `upscale-4k`, `video-edit` (`coming_soon`), soft `deprecated` redirect, independent `channels: { gui, mcp }` | Blocks unreleased execution with `CAPABILITY_COMING_SOON` (zero spend, no silent downgrade to generic i2i/i2v); hides deprecated entries from `list` while returning `replacementCapabilityId` on direct calls; enforces per-channel gating. |
| **On-demand orchestration, preflight & provenance** (`C1–C5`) | On-demand `openmotion-digital-human-presenter` & `openmotion-video-dubbing` Library Skills + `asr-transcribe`, `dryRun` without `requestId`, `AssetVersion.capabilityId` provenance, `job_manage` | Keeps vertical SOPs at zero resident tokens until installed; supports zero-spend `dryRun` validation and cost quoting; persists `capabilityId` and `capabilityOptions` on every generated `AssetVersion`. |
| **Executor hot-swap & extensibility hooks** (`D1–D5`) | Cloud model swapped to deterministic local `script`, `requestId` replay and `REQUEST_ID_CONFLICT`, remote config sync, custom real-time quote estimator | Zero caller/schema change when swapping from cloud model to local script (zero remote calls); enforces idempotency replay and parameter-mismatch conflict checks; verifies remote override merge and custom quote hook injection. |

### 3.3 Dual-Surface Hot-Swap Verification & R&D Integration Handoff

Verified against a live local Studio + Gateway instance using only a workspace `capabilities-override.json` patch (zero source edits or rebuilds):

1. **Audio secondary workbench (`dubbing`)**: Flipping `dubbing` from `coming_soon` to `live` promoted the entry in the Audio top navigation menu and switched the Sound Studio secondary workbench from the Coming Soon placeholder to the live dubbing composer (source media upload + target language, preserve background audio, and lip-sync controls).
2. **Image secondary workbench (`upscale-4k`)**: Flipping `upscale-4k` to `live` moved it out of the Coming Soon footer into the active Image mega menu and auto-mounted its secondary composer with reference slots and the `scale` dropdown.
3. **Runtime control options (`relight`)**: Appending a new lighting option in the override immediately appeared in both Studio's `AssetComposer` dropdown and `openmotion_capability_discover(action="describe", capabilityId="relight")`.

| Next Integration Step | Reserved Extension Point | Expected Change Scope |
| --- | --- | --- |
| Connect production dedicated models or local scripts (e.g., RMBG, 4K upscale, lip-sync, dubbing) | `shared/capability-registry.ts` (`dedicated-model` + `optionToParameter`) or `gateway/capability-scripts.ts` (`script`) | **≤ 2 files** (zero Studio UI or MCP schema changes) |
| Connect Cloud remote capability catalog | `OPENMOTION_CAPABILITY_CONFIG_URL` or `setCapabilityRemoteConfigFetcher()` in `gateway/capability-center.ts` | **1 initialization hook** |
| Connect real-time credit/spend quoting | `registerCapabilityQuoteEstimator()` in `gateway/capability-center.ts` | **1 async estimator** |
| Retire legacy compatibility aliases after transition | Remove `openmotion_media_use`, `openmotion_assets_use`, `openmotion_assets` from `shared/mcp-profiles.json` | **1 config edit** (`-4,250` static tokens) |
