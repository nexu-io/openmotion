> See [source and execution notes](../PROVENANCE.md).

# Stylization — the style contract for AI-generated game assets

Self-contained specification of the stylization layer for game pipelines.
Owns everything that makes independently generated assets look like ONE game.
Designed to be dropped into any game-generation skill: if your pipeline
generates a single pixel of game art, it consumes this contract.

**Interface in one paragraph:** the pipeline derives ONE text string (the
STYLE FORMULA) per game, gets it user-approved once, then inserts it
byte-identical into every asset-generation prompt of every subsystem
(sprites, animations, tiles, backgrounds, textures, 3D). This file defines
how the formula is built, how prompts are assembled around it, which discovered
models to call with what parameters, when real generated assets must replace
code-drawn art (section 9), and how style consistency is verified.

---

## 1. Why stylization exists

Every asset is produced by an independent model call — the model has no
memory of previous calls. Different subsystems (and different team members'
skills) generate different asset kinds. Without a shared rule the result is
"three different games on one screen": photoreal floor + pixel-art hero +
cartoon background.

The STYLE FORMULA is the glue: the only piece of shared context that travels
into every generation.

## 2. STYLE FORMULA recipe

One English paragraph, **60–90 words**, composed once per game right after
the design brief is parsed, shown to the user for approval, stored in the
pipeline's state (e.g. `gdd.json.style_formula`).

Concatenate five open structural blocks, in order — fill each slot from the user's explicit style or fresh creative direction rather than reusing any preset palette:

| # | Block | Pins down | Structural slot pattern |
|---|---|---|---|
| 1 | Rendering medium | what physical or artistic craft it is "made with" | `[chosen medium, texture grain, and surface finish]` |
| 2 | Shape & line language | silhouettes, proportions, and edge treatment | `[form vocabulary, contour thickness/contrast, and edge style]` |
| 3 | Palette **by role** | readability, not uniformity | `[environment/ground value & hue family], [contrasting hero hue/luminance that pops cleanly], [one unmistakable signal hue reserved for hazards/pickups]` |
| 4 | Light & mood | time of day, light quality, and emotional register | `[lighting direction/temperature, atmosphere, and emotional tone]` |
| 5 | Game-readability | figure-ground separation + **perspective word** | `high contrast between game elements and backgrounds, clean readable silhouettes, consistent [genre perspective word] perspective across all assets` |

Rules:

- **Block 3 is roles, not one global gamma.** Environment gets its base
  colors; the hero gets colors that CONTRAST with that base (the hero must
  pop, never blend); hazards/pickups get one distinct signal hue. A single
  flat color list paints the whole world one gamma and kills element
  readability — style identity lives in blocks 1, 2 and 4, color serves
  readability.
- **The perspective word in block 5 must match the genre**: platformer /
  runner → `side-view`; top-down → `top-down`; puzzle / clicker → `flat
  frontal`. A top-down game with a side-view hero sprite is the most common
  cross-asset failure; the formula is where it is prevented. (3D pipelines:
  see section 8 — the perspective word is replaced, not reused.)
- If the user supplied a style reference image, describe ITS rendering style
  in your own precise words in block 1 — never paste image URLs into the
  formula.
- **Keep one rendering medium across the whole game (no photoreal drift on anime/2D briefs).** When the user asks for `anime` / `二次元` / `真人二次元` / `半写实二次元` / cartoon / pixel art, pin Block 1 explicitly to a 2D illustration medium that matches the game canvas (for example `2D Japanese cel-shaded anime illustration with crisp ink lineart and stylized anime proportions` or `semi-real 2.5D painterly anime game illustration, NOT live-action DSLR photography, NOT photorealistic skin pores`). Never generate a real-world live-action photograph for a character portrait and place it onto a flat vector/anime game screen. Always inspect each generated character image via `action:"read"` and reject/regenerate within budget if it drifts into live-action photography.
- Do NOT put into the formula: asset-specific content (that's the per-asset
  description), background/keying instructions (that's the kind suffix),
  pixel dimensions or resolutions.
- **Keep raster payload lightweight**: request 1K / game-appropriate sizes for in-game sprites, tiles and backdrops instead of defaulting to 4K multi-megabyte PNGs, keeping total raster assets well under ~8 MB per game for fast browser loading (during `web_publish`, large >=256 KiB PNG/JPEG library assets are automatically transcoded to WebP — lossless for PNGs to preserve exact RGBA pixels, quality 82 for JPEGs).

### STYLE TOKEN (compressed form)

Some downstream fields are length-limited (e.g. an external 3D provider's
texture prompt, often ≤600 chars — the full formula usually fits; some UI fields may not). When a
consumer cannot take the full formula, it takes the **STYLE TOKEN**: blocks
1 + 3-condensed + one accent from block 4, ≤120 chars, derived ONCE from the
approved formula and then also frozen byte-identical. Structure:
`[medium], [ground palette role], [contrasting hero & signal accents], [lighting mood], [line/shape language]`.
The formula is the source of truth; the token is its compression — never
maintain two competing style strings.

## 3. The byte-identical contract

> The formula is inserted into EVERY generation prompt of EVERY subsystem
> **without changing a single byte**. No paraphrasing, no shortening, no
> "improving". Including single-asset regenerations during iteration.
> Re-deriving the formula mid-game is allowed only when the user explicitly
> asks to change the art style — that re-opens the approval gate and
> invalidates all existing assets.

Consumers and their obligations:

| Consumer | Obligation |
|---|---|
| Static asset generation (sprites, tiles, backgrounds, UI) | formula verbatim in every prompt (assembly in section 4) |
| Character animation (sprite-sheet generation from a base sprite) | formula verbatim in sheet prompts; the animation view parameter MUST match the formula's perspective word (`side-view` → sidescroller view, `top-down` → top-down view) |
| Environment textures | formula verbatim + seamless suffix (section 4) |
| 3D (bundled or procedural meshes; external image-to-3D only if discovered) | formula verbatim in concept, texture and skybox image prompts; engine lighting derived from the formula (section 8) |
| Level/map presentation sheets | formula or token in the sheet prompt so map icons match the asset kit |

## 4. Prompt assembly for 2D assets

Every asset prompt is a concatenation of exactly four parts, in order:

```
<kind template> + <asset description> + <STYLE FORMULA byte-identical> + <kind suffix>
```

The asset description is a stable 3-4 word shorthand from the design doc
(`the round blue slime`), never a character name.

### Kind templates and suffixes

**sprite** (characters, objects — needs transparency; drop the key-color suffix when the model supports `background:"transparent"`, section 5)
- template: `game sprite of <description>, single character/object, full body visible, centered,`
- suffix: `, on a solid uniform bright <KEY COLOR> background, no shadows cast on the background, no ground plane, nothing cropped at the edges`

**tile** (repeating surfaces)
- template: `seamless tileable game texture tile of <description>, uniform pattern density,`
- suffix: `, perfectly seamless edges that wrap horizontally and vertically, no border, no vignette, flat even lighting, no single focal object`

**background** (full-frame)
- template: `game background of <description>, wide establishing view,`
- suffix: `, no characters, no UI elements, slightly muted detail so foreground game elements stay readable, soft depth layering`

**texture** (3D surface)
- template: `seamless tileable surface texture of <description>,`
- suffix: `, perfectly seamless edges, flat even lighting, no perspective, no objects, photographed-flat appearance`

**ui** (buttons, icons — needs transparency; same rule)
- template: `game UI element: <description>, single element, centered,`
- suffix: `, on a solid uniform bright <KEY COLOR> background, crisp edges, no drop shadow outside the element`

## 5. Transparency: native alpha or `remove-background` first, key color as fallback

Check the chosen image model's live `generationOptions` and live capabilities before choosing a method:

1. **Native transparency.** If the model's discovered `generationOptions` list a `background` option with `"transparent"` (or `bestFor` includes `transparent-cutout`), request `parameters.background: "transparent"` and drop the key-color suffix. Always verify the returned PNG really has an alpha channel (a drawn checkerboard is not transparency).
2. **Dedicated `remove-background` capability.** When an opaque asset (for example from a painterly or opaque-only model, or an edited sprite) needs a clean transparent cutout and `openmotion_capability_discover(action="list")` reports `remove-background` with both `status: "live"` and `available: true`, call `openmotion_capability_run(capabilityId="remove-background", references=[{assetId, versionId}])` rather than simulating background removal with ad-hoc edit prompts (include this step in the upfront asset/spend plan). Do **not** select `remove-background` when `available: false` (for example when only opaque-only models are configured).
3. **Key-color fallback.** When neither native transparency nor an executable (`status: "live"` and `available: true`) `remove-background` capability is available or approved, generate on a solid key color and key it out in code (Canvas `getImageData` pass at load time, or a shader).

**Choosing the key color (fallback only) is a per-asset step, driven by the
formula's palette:**

1. default: bright magenta `#FF00FF`;
2. if the asset's own colors (its description OR the formula's role palette)
   are anywhere near pink/magenta/purple → bright green `#00FF00`;
3. if both are taken → bright blue `#0000FF`.

The chosen color goes into BOTH the prompt suffix and the keying code.
Real shipped failure: a pink donut generated on magenta — unkeyable, the
donut hole stayed pink in the game. Keying must also clear
ENCLOSED key-colored regions (a donut hole is not connected to the image
corners, so corner flood-fill alone misses it).

## 6. Models and volumes

Discover with `openmotion_capability_discover` (`action:"list"` and `action:"models" modality:"image" refresh:true`) or `openmotion_media_use action=models modality=image refresh=true`, and follow the `openmotion-media` provider order (OpenDesign account, then OpenDesign Cloud, then other configured providers). Select models dynamically from the returned `tier`, `bestFor`, `description`, `supportsImageReference`, `maxInputImages`, and `generationOptions` rather than hardcoding model version IDs. Prefer dedicated capabilities (`remove-background`, `relight`, `image-blend`) via `openmotion_capability_run` when discovery reports them with `status:"live"` and `available:true`.

| What | Discovery selection rule (OpenDesign first) | Composition target & live params | Volume per game |
|---|---|---|---|
| Key art, cover art, title screen, character portraits, visual-novel scenes | Image model with `tier:"flagship"` matching `bestFor` / `description` (`hero-art`, `character-portraits`, `painterly-scenes`, `text-rendering`) | Target `16:9` scenes or `3:4`/`1:1` portraits; send only parameters declared in the model's live `generationOptions` / provider reference (never guess unsupported `aspect_ratio` or `output` fields) and crop/pad cleanly in code | 1–4 hero images |
| Sprites, props, tiles, card art, UI icons | Image model with `tier:"fast"` matching `bestFor` (`batch-sprites`, `transparent-cutout`, `batch-tiles`, `card-art`); prefer native `background:"transparent"` when listed for cutouts | Square centered framing using only live-listed params; reserve `tier:"flagship"` for hero focal art so full batches finish fast | ≤8 assets, submitted upfront together |
| Backgrounds, seamless textures | Fast or flagship image model matching `backgrounds` / `batch-tiles` in `bestFor` / `description` | Target `16:9` (background) or `1:1` (tile/texture) using only live-listed `generationOptions` | ≤4 |
| Variants, cutouts, relighting, and multi-ref blends | Dedicated capabilities (`remove-background`, `relight`, `image-blend`) via `openmotion_capability_run` when reported `status:"live"` and `available:true`, or an image model returned with `supportsImageReference:true` passing `references:[{assetId,versionId}]` | within `maxInputImages` and live-listed params | as needed |
| 3D concept/reference images | any fitting discovered image model above | Square centered framing using live-listed params | one per prop |

- **Tier models & overlap work for speed:** submit the entire approved asset batch concurrently right after planning so the gateway runs jobs in parallel while you author `logic.js`, `index.html`, and `client.js`; pair 1–4 hero visuals on a `tier:"flagship"` model with `tier:"fast"` models for sprite cutouts and opaque tiles/cards to avoid multi-minute tail queues.
- Keep style cohesion via the verbatim STYLE FORMULA across tiers (never mix wildly different art directions).
- Pick resolution at generation time from the catalogue profile; never upscale afterwards.
- **Regeneration budget: 2 attempts per asset** within the approved spend (style drift / keying /
  tiling failures), then take the best attempt and compensate in code
  (tint, scale, 1px overlap). Style drift usually heals with a re-roll of
  the SAME prompt; only edit the description when the content itself is wrong. Extra attempts beyond the approved list need a new approval.
- The only legitimate full-set regeneration: the user asked to change the
  whole style (new formula → new approval → all assets redone). Never
  regenerate everything in response to point feedback.
- When no image model is listed or the user declines spend, draw with Canvas/SVG/Three.js and record the gap; see section 9.

## 7. Scale, proportion and coherence checks

- Every object in the design doc carries `relative_scale` — height in
  hero-units (hero = `1.0`, spike trap ≈ `0.6`, doorway ≈ `2.0`). It drives
  in-game sizing and the contact sheet; it is NOT inserted into generation
  prompts.
- **Contact sheet before asset approval:** inspect all generated image assets together in **one** batch call — `openmotion_asset_manage(action="read", items=[{assetId, versionId}, ...])` or `openmotion_assets_use(action="read", items=[{assetId, versionId}, ...])` (composites up to 12 images onto one labeled grid over neutral gray so style cohesion, palette separation, framing, and transparent alpha cutouts are visible side-by-side without injecting 8–10 full-resolution images into later turns). Use single-asset `read` with `maxEdge: 512` only when zooming in on one doubtful asset. A problem caught here costs one regen; caught after coding it costs a debugging session.
- Per-set style checklist: same rendering style on every asset (block 1)?
  outlines consistent (block 2)? palette roles respected — hero contrasts
  environment, signal hue only on hazards/pickups (block 3)? one perspective
  everywhere (block 5)?
- Final in-game sizes (2D): sprite 128px, tile 256px (power-of-two), background
  1280×720. Downscale with NEAREST for pixel-art formulas (LANCZOS smears
  them), LANCZOS otherwise.

## 8. 2D vs 3D stylization — what changes

3D consumes the same formula but through different mechanics:

| Aspect | 2D | 3D (bundled GLBs, Three.js meshes) |
|---|---|---|
| Style carrier | formula in every asset prompt | formula in concept, texture and skybox image prompts; engine lighting from blocks 3–4 |
| Background for subject shots | native transparent background, else solid key color (section 5) | concept images for modelling reference: pure flat white, no shadow, no ground (also the input rule for any discovered image-to-3D provider); textures and skyboxes need no keying |
| Perspective word | `side-view` / `top-down` / `flat frontal` everywhere | replaced by `three-quarter isometric view` on concept images (shows top + two sides — maximum shape information for modelling); in-game camera is free |
| Style drift fix | regenerate the asset (budget: 2) | retint materials or swap generated textures on the same mesh — never rebuild a well-shaped mesh for color reasons |
| Extra style surface | — | engine lighting: light color, fog and ambient intensity must be derived from formula blocks 3-4, or a perfectly styled texture set still reads off-style in-game |
| Geometry style | — | add a geometry clause to 3D concept prompts when the formula implies it (`low-poly faceted`, `smooth rounded blobby`); polycount tiers: ~8000 hero/interactive props, ~3000 + lowpoly for small decoration |

**Full style change in 3D** (user asks to restyle the whole game): new
formula → **re-approval gate** (never skip it) → regenerate textures →
**re-derive engine lighting, fog and ambient from the new formula's blocks
3-4** → revisit the geometry clause. New textures on old lighting and old
primitives read as "a picture slapped on the old game" — this exact failure
shipped once (Roblox-style scene "restyled" to Mafia 3 by swapping textures
only).

**Realism ceiling (say it at the gate):** OpenMotion discovery listed no
3D generation or rigging model at review. Characters come from the bundled
CC0 GLBs (`characters/` Mage/Knight) or carefully modelled Three.js
geometry; a photoreal target ("like Mafia 3") cannot be honestly met. State
the limit at the approval gate and offer the achievable version: stylized
low-poly with PBR materials (`MeshStandardMaterial` / `MeshPhysicalMaterial`),
an HDRI or gradient environment map, generated textures and skybox from the
image models above, fog, tone mapping and light post-processing within the
performance budget. If a later catalogue lists a 3D model, follow the
discovery contract in `game-3d-animation.md`.

Everything else (byte-identical contract, palette roles, regen budget,
checks) applies to 3D unchanged.

## 9. Multimodal-first trigger

Procedural Canvas art is right for abstract, geometric, pixel or minimalist games. It is the wrong tool for people and illustration. A run that spends millions of tokens hand-drawing a racing driver or an anime heroine from circles and bezier paths, then ships with beeps for music, fails the brief even if the code is clever.

**Generate real assets first** when the brief contains any of the following and discovery lists a fitting model:

- a realistic or anime/illustrated human character, portrait, mascot or visual-novel cast;
- polished illustration: cover, poster, key art, title screen, story scenes, detailed backgrounds;
- background music, a theme song mood, or atmosphere that depends on sound;
- spoken character lines, narration or an announcer.

In that case plan the assets in `design/assets.csv`, ask one batched spend question (asset, count, provider/model), and after approval generate through `openmotion_assets_use action=generate`. Keep gameplay-critical shapes (hitboxes, tracks, bullets, tiles that must collide precisely) in code; use generated images for what players look at: characters, scenery, UI art, covers. Wire each completed version by its `/motion-api/assets/<assetId>/versions/<versionId>/media` URL.

**Code-made art is the fallback**, used when no fitting model is listed, the host lacks the media tools, or the user declines. Then say so plainly in the plan and final message, and keep the art floor from `game-genres.md`: outlines, two-tone shading, real silhouettes, synthesized music and SFX rather than silence. Never draw a human portrait from primitives while a generation question is still unanswered.
