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

The Unified Capability Center (`32` declarative capabilities: `14 live` + `18 coming_soon`) and two-layer progressive Skill layout (`skills/` core resident + `library/skills/` on-demand vertical packs) were verified across turn-0 context scaling, deterministic gateway contracts, Super Agent approval/artifact integration, and live dual-surface hot-swapping.

### 3.1 Turn-0 Static Context Scaling (`14 → 60` Capabilities)

Measured as exact UTF-8 bytes of the turn-0 static payload injected into every session (`tools/list` JSON schemas + `phase1.instructions` + resident `skills/openmotion-media/SKILL.md`, estimated at `~3.8 bytes/token`):

- **New 4 Capability Center meta-tools** (`openmotion_capability_discover`, `openmotion_capability_run`, `openmotion_job_manage`, `openmotion_asset_manage`): **`14,902 B`** (`~3,922` tokens), strictly `O(1)` regardless of capability count.
- **Legacy 3 media/asset tools** (`openmotion_media_use`, `openmotion_assets_use`, `openmotion_assets`): `31,054 B` (`~8,172` tokens) at `main@3aa94dfce`, growing to **`51,855 B`** (`~13,646` tokens) on `main@f8f2249d` after `scenario`, `batch`, `trigger`, and `web_publish` were added to `openmotion_assets_use`.
- **Full `main@f8f2249d` phase1 surface** (34 tools including 12 Game Studio tools):
  - Pre-meta `main@f8f2249d` (34 tools): `122,211 B` (`~32,161` tokens)
  - Dual-track transition branch (38 tools, compatibility active): `137,112 B` (`~36,082` tokens, `+3,922` tokens during rollout)
  - Media/asset steady state after splitting non-asset actions and retiring the 3 legacy aliases (35 tools, before any split domain tools): `85,258 B` (`~22,436` tokens; **`-36,953 B` / `-9,724` tokens** freed from legacy media/asset schemas)

Scaling projection against naive 1-capability-per-tool exposure (original isolated media baseline @ `3aa94dfce`, where `main` had 22 tools / `87,008 B`):

| Capability & Vertical SOP Scale | Naive Flat Scaling<br>*(1 capability = 1 tool + resident SOPs)* | Pre-Change `main`<br>*(22 Tools @ `3aa94dfce`)* | **Steady State (Legacy Retired)**<br>*(23 Tools @ `3aa94dfce`)* |
| --- | --- | --- | --- |
| **Initial live baseline** (11–14 caps + 0 vertical) | 30 Tools · `67,052 B` (~17,646 tok) | 22 Tools · `87,008 B` (~22,897 tok) | **23 Tools · `70,856 B` (~18,647 tok, -18.6% vs `main`)** |
| **Catalog full rollout** (32 caps + 5 vertical) | 50+ Tools · `109,188 B` (~28,734 tok) | *Cannot express dedicated schemas* | **23 Tools · `70,856 B` (~18,647 tok)** |
| **Mid-term scale** (40 caps + 10 vertical) | 59 Tools · `141,705 B` (~37,291 tok) | *Cannot express dedicated schemas* | **23 Tools · `70,856 B` (-50.0% vs flat)** |
| **Long-term matrix** (60 caps + 15 vertical) | 79 Tools · `188,060 B` (~49,490 tok) | *Cannot express dedicated schemas* | **23 Tools · `70,856 B` (-62.3% vs flat)** |

> **Dual-track transition note**: Keeping the 3 legacy compatibility tools registered during rollout temporarily adds `+3,922` static tokens so active sessions, Super Agent workflows, and existing Library Skills migrate safely without breaking.

### 3.2 Gateway Guard & Contract Verification

| Verification Slice | Covered Scenarios | Gateway Guarantee |
| --- | --- | --- |
| **Structured parameter injection & capability-driven routing** | `remove-background` transparent alpha, `relight` lighting enum, multi-ref `character` consistency, `native-audio` audio flag, `dedicated-model` `optionToParameter` | Evaluates `prompt-preset` eligibility via `shared/model-capabilities.ts` and `modelReferenceLimit`, auto-injects required defaults, rejects invalid enums with `invalid_enum` at zero spend, and translates control IDs to vendor fields. |
| **Unreleased boundaries, deprecation, pagination & channels** | `lipsync`, `upscale-4k`, `video-edit` (`coming_soon`), soft `deprecated` redirect, independent `channels: { gui, mcp }`, strict `discover(list)` `offset`/`limit` bounds | Blocks unreleased execution with `CAPABILITY_COMING_SOON` (zero spend, no silent downgrade); hides deprecated entries from `list` while returning `replacementCapabilityId`; validates pagination integers strictly across MCP and HTTP. |
| **Full-path `dryRun` preflight & Super Agent safety** | Capability `dryRun`, raw model fallback `dryRun`, unavailable explicit model rejection, `asr-transcribe` `dryRun`, HTTP strict `dryRun === true`, Super Agent `approval('generation')`, `asset_manage(read)` media wrapping, strict artifact extraction | Guarantees zero paid submissions across every `dryRun` path (including raw model fallback and HTTP `/api/capabilities/run`), enforces generation approval and `conversationId`/`requestId` injection in Super Agent, wraps `asset_manage(read)` previews, and prevents `get`/`update`/`trash` from polluting Artifact Viewer. |
| **Executor hot-swap & extensibility hooks** | Cloud model swapped to deterministic local `script`, `requestId` replay and `REQUEST_ID_CONFLICT`, remote config sync, custom real-time quote estimator (including raw model quotes) | Zero caller/schema change when swapping from cloud model to local script (zero remote calls); enforces idempotency replay and parameter-mismatch conflict checks; verifies remote override merge and custom quote hook injection. |

### 3.3 Dual-Surface Hot-Swap Verification & R&D Integration Handoff

Verified against a live local Studio + Gateway instance using only a workspace `capabilities-override.json` patch (zero source edits or rebuilds):

1. **Audio secondary workbench (`dubbing`)**: Flipping `dubbing` from `coming_soon` to `live` promoted the entry in the Audio top navigation menu and switched the Sound Studio secondary workbench from the Coming Soon placeholder to the live dubbing composer (source media upload + target language, preserve background audio, and lip-sync controls).
2. **Image secondary workbench (`upscale-4k`)**: Flipping `upscale-4k` to `live` unlocked the `4K upscale` tile in the Image mega menu and auto-mounted its secondary composer with reference slots and the `scale` dropdown.
3. **Runtime control options (`relight`)**: Appending a new lighting option in the override immediately appeared in both Studio's `AssetComposer` dropdown and `openmotion_capability_discover(action="describe", capabilityId="relight")`.

| Next Integration Step | Reserved Extension Point | Expected Change Scope |
| --- | --- | --- |
| Connect production dedicated models or local scripts (e.g., RMBG, 4K upscale, lip-sync, dubbing) | `shared/capability-registry.ts` (`dedicated-model` + `optionToParameter`) or `gateway/capability-scripts.ts` (`script`) | **≤ 2 files** (zero Studio UI or MCP schema changes) |
| Connect Cloud remote capability catalog | `OPENMOTION_CAPABILITY_CONFIG_URL` or `setCapabilityRemoteConfigFetcher()` in `gateway/capability-center.ts` | **1 initialization hook** |
| Connect real-time credit/spend quoting | `registerCapabilityQuoteEstimator()` in `gateway/capability-center.ts` | **1 async estimator** |
| Complete Phase 2 migration & retire legacy aliases | Follow Section 4 roadmap below before editing `shared/mcp-profiles.json` | Phased domain split + 1 profile cleanup |

---

## 4. Legacy Compatibility & Decommissioning Roadmap

Recent `main` additions expanded `openmotion_assets_use` beyond pure media/asset operations (bringing the legacy 3 tool schemas to `51.9 KB`). To retire the legacy aliases safely without turning `openmotion_asset_manage` into a monolithic tool, decommissioning follows an explicit action-by-action split:

| Legacy Tool / Action | Current Status | Target Home & Phase |
| --- | --- | --- |
| `openmotion_media_use` (`inspect`, `models`, `reference`) | **Migrated** | `openmotion_capability_discover` (`list`, `describe`, `quote`, `providers` with optional `provider` guide, `models`). |
| `openmotion_assets_use` (`generate`) | **Migrated** | `openmotion_capability_run` (with `capabilityId` or raw `model` fallback + `dryRun`). |
| `openmotion_assets_use` / `openmotion_media_use` (`jobs`, `status`, `cancel`, `retry_save`, `resume`) | **Migrated** | `openmotion_job_manage` (`list`, `status`, `cancel`, `retry_save`, `resume`). |
| `openmotion_assets_use` (`list`, `get`, `read`, `import`, `update`, `import_to_project`, `brand_kit`) | **Migrated** | `openmotion_asset_manage`. |
| `openmotion_assets` (redundant alias without `read`) | **Ready to retire first** | Remove in Phase 2 once telemetry confirms zero callers. |
| `openmotion_assets_use(action="transcript")` | **Partial (`asr-transcribe` submit only)** | `asr-transcribe` currently submits a `TranscriptionJob` whose status/segments are still managed via `transcript` (not `openmotion_job_manage`). Migrate full transcript status/read/edit commands in Phase 2. |
| `openmotion_assets_use(action="web_publish")` | **Retained on legacy tool** | Extract to a dedicated publishing tool (e.g. `openmotion_web_publish`) shared by Design, Game, and Motion in Phase 2 — do **not** fold into `openmotion_asset_manage`. |
| `openmotion_assets_use` (`scenario`, `batch`, `trigger`) | **Retained on legacy tool** | Extract to focused workflow/automation tools in Phase 2 — do **not** fold into `openmotion_asset_manage`. |
| Existing Library Skills & Super Agent prompts | **Dual-track active** | Batch-update existing `library/skills/` references and `gateway/super-agent.ts` instructions in Phase 2 after domain splits land; retire `openmotion_media_use` and `openmotion_assets_use` from `shared/mcp-profiles.json` in Phase 3 once telemetry reaches zero. |
