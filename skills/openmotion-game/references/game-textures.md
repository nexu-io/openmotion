> See [source and execution notes](../PROVENANCE.md).

# Texture Tile Factory

> **Asset reference for game-generation.** Use for any seamless / tileable texture
> (ground, walls, floors, track surfaces, skyboxes) and its PBR map set, from a
> reference image or a generated one. Enter at any phase (only the seam fix, or
> only maps from an existing tile). Generate through `openmotion_assets_use`
> `action=generate` after `openmotion_media_use` discovery, a stated plan and
> spending approval. Embed the game's STYLE FORMULA (see `game-stylization.md`)
> in every generation prompt.
>
> No external scripts are required. The post-process below runs in game code
> (Canvas 2D or a small WebGL pass) at load time. A user-supplied local tool
> may replace it, but its absence never blocks the pipeline.

Turn a reference into an engine-ready texture: a **seamless edit** with an
edit-capable image model that keeps the reference's material, style and
colors, then a **deterministic post-process** in code that guarantees tiling
and derives the PBR maps.

Work language: mirror the user's language in chat; keep all generation
prompts in English.

## Prerequisites

- An image model discovered with `openmotion_capability_discover` (`action:"models" modality:"image" refresh:true`) or `openmotion_media_use action=models modality=image refresh=true`, following the `openmotion-media` provider order (`account` → `opendesign` → other configured providers). For reference-based seamless edits, pick a model reporting `supportsImageReference:true` (preferring `tier:"fast"` / `batch-tiles` or `tier:"flagship"` from live `tier`/`bestFor`/`description`). Use only returned IDs.
- The reference as a library asset (`assetId` + `versionId`): a previous generation, or a user file imported with `openmotion_assets_use action=import`.
- No generation model, or the user declines → skip Phase 1 and build the tile procedurally (value noise / fBm on a canvas with wrap-around sampling, which is seamless by construction), then run Phases 2–3.

## Phase 0 — Reference intake

- Use the sharpest square region of the reference; perspective or depth of field produces mush at the seam.
- **Measure before generating** with the Phase 3 seam ratio. If the tile is already seamless (ratio ≈ 1.0), skip Phase 1.
- Pick `{id}`: short, lowercase, one per material (`sand`, `brick_red`).

## Phase 1 — Seamless edit

- Fill the EDIT prompt from **Prompt templates** below. `{MATERIAL}` = 3–6 concrete words from the reference. Append the alignment add-on for bricks/planks/tiles, the anti-repetition add-on for tiled previews and the watermark add-on for stock images.
- Submit after approval:

```json
{"action":"generate","requestId":"tex-sand-01","model":"<provider>:<discovered-image-edit-model>","modality":"image","prompt":"<EDIT prompt>. <STYLE FORMULA>","references":[{"assetId":"<ref asset>","versionId":"<ref version>"}],"parameters":{}}
```

  Pass only options declared in the model's live `generationOptions` / provider reference (do not send bare `aspect_ratio` or `output` unless the live profile supports them, and crop/scale to a power-of-two square in Phase 2).
- Poll `action:"status"`, then `action:"read"` the result and **look at it next to the reference**: same material, same colors, nothing added or removed, no restyle. If it restyled, at most one retry within the approved asset/retry budget with a stronger "do not restyle" clause (extra attempts beyond the approved budget require fresh consent). If a structured seam survives, switch to the offset-inpaint pass (Prompt templates §2) instead of rerolling: two identical failures mean the approach is wrong, not the seed.

Edit models tend to blur the outer border slightly and drift the palette. Do not fight that in the prompt; Phase 2 cancels both.

## Phase 2 — Post-process and PBR maps (in code)

Load the completed version from `/motion-api/assets/<assetId>/versions/<versionId>/media` into an offscreen canvas and run, in order:

1. **Trim** the blurred border (about 4% per side) and rescale back to a power-of-two size (256 or 512). Skip for non-generated input.
2. **Palette lock** (when a reference exists): per-channel histogram matching of the output against the reference so the color identity survives.
3. **Seam fix**: offset the tile by 50% on both axes, then cross-fade a narrow band (8–12% of the width, cosine weights) across the now-central seams with the unshifted tile. For structured materials keep the band narrow so units stay sharp. Repeat once if Phase 3 still flags a ratio above ~1.3.
4. **Maps** with wrap-around sampling so tileability survives every map:
   - height = luminance, lightly blurred;
   - normal = Sobel on height (wrap at edges), packed to RGB;
   - roughness = inverted, contrast-stretched height (stone/earth) or a constant (metal, plastic).

Use them as `map`, `normalMap` and `roughnessMap` on `MeshStandardMaterial` with `RepeatWrapping`, or as a repeating `CanvasPattern` in 2D. Cache the derived canvases; never recompute them per frame.

## Phase 3 — Verify and package

- Render the basecolor tiled 2×2 and **inspect it**: features wrap, no grid banding, no brightness step at joints. Also inspect 1:1 crops of both wrap junctions and the tile center; downscaled previews hide smears and ghost elements.
- Seam ratio (≈ 1.0 = seamless; flag anything above 1.3): mean absolute difference across the wrap edges divided by the mean neighbour difference inside the tile.

```js
function seamRatio(img) { // img: ImageData
  const { data: d, width: w, height: h } = img, px = (x, y, c) => d[(y * w + x) * 4 + c];
  let seam = 0, base = 0, ns = 0, nb = 0;
  for (let i = 0; i < w; i++) for (let c = 0; c < 3; c++) { seam += Math.abs(px(i, 0, c) - px(i, h - 1, c)); ns++; }
  for (let j = 0; j < h; j++) for (let c = 0; c < 3; c++) { seam += Math.abs(px(0, j, c) - px(w - 1, j, c)); ns++; }
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) for (let c = 0; c < 3; c++) {
    base += Math.abs(px(x, y, c) - px(x + 1, y, c)) + Math.abs(px(x, y, c) - px(x, y + 1, c)); nb += 2;
  }
  return (seam / ns) / (base / nb);
}
```

Record each material in `design/assets.csv` (asset id/version, model, cost, seam ratio). Summarize for the user: material, seam ratio, where it is used. Offer next steps without launching them: tile variants against visible repetition, transition tiles between two materials.

---

## Prompt templates

All prompts go to the discovered edit-capable model, aspect `1:1`, high
quality where listed, with the reference attached as a library reference
(`references:[{assetId,versionId}]`), never a raw URL.
## 1. Seamless edit (Phase 1)

```
Reproduce the attached image as faithfully as possible: the SAME {MATERIAL},
same colors, same lighting, same shapes and detail, pixel-level similarity
everywhere possible. Only make the MINIMAL adjustments needed so the image
becomes a perfectly seamless tileable texture: the left edge must continue
into the right edge and the top edge into the bottom edge with no visible
seam when tiled. Do not restyle, do not add or remove elements, do not
change colors or scale. Square 1:1.
```

`{MATERIAL}` — 3–6 concrete words from the reference
("hand-painted cracked dry earth with small grey stones").

Add-ons, appended as extra sentences when they apply:

- structured materials (bricks, planks, tiles):
  `The repeating units must be aligned so rows continue across the tile
  borders: unit boundaries at the left edge continue into the right edge
  and across top/bottom.`
- the reference is itself a tiled preview (visible periodic repetition):
  `Reduce the visible periodic repetition of distinctive features so the
  pattern feels organic.`
- stock image: `Remove any watermark text.`

## 2. Offset-inpaint pass — structured seams that survive Phase 1

Move the seam to the center and have the model repaint only the cross:

1. Offset the tile by 50% on both axes (the seam becomes a center cross). Save the offset PNG with authorized local file access and import it with `openmotion_assets_use action=import` to get a reference `assetId`/`versionId`. If no local file write is available, skip this pass and rely on the Phase 2 code seam fix.
2. Send the rolled tile as an image reference to the same edit-capable model:

```
This {MATERIAL} game texture is damaged along a vertical line and a
horizontal line through the center: some pattern elements there are faded,
semi-transparent, streaky or cut in half. Replace every damaged element
with a brand-new complete one painted in the exact same crisp style: fully
opaque, sharp confident strokes, same element size, same colors. No blur,
no soft transparent elements, no smoothing - the repaired area must be
indistinguishable in sharpness and detail from the rest of the image. Keep
everything outside the damaged lines unchanged. The final image must be a
perfectly seamless tileable texture: the left edge continues into the
right edge and the top edge continues into the bottom edge with no visible
seam when tiled. Flat even lighting, no shadows, no vignette.
```

Wording matters (live failed-run history): "repair the seam" biases the
model toward smoothing and produces blurry ghost elements along the line —
say "replace damaged elements with new complete ones" and explicitly
forbid faded/semi-transparent results. Asking the model to "keep the
borders unchanged" alone is NOT reliable — it usually repaints globally —
so the prompt also demands the whole output stay tileable.

3. **Never trust the model's full output** — it repaints the whole image
   regardless of "keep the borders unchanged", and its repaint outside the
   cross carries drift, ghosts and translucent smears. Composite in code:
   take from the model output **only a band around the center cross**
   (about 20% of the tile width, feathered a few pixels), keep the rest of
   the rolled original, then roll back by 50% so the repaired cross becomes
   the wrap and run the Phase 2 post-process.

The edge-seam ratio alone can look perfect while an interior defect hides
in the patched zone — Phase 3 inspection must include **1:1 (100% zoom)
crops** of the wrap areas and the tile center; a downscaled 2×2 preview
hides translucent smears (a live failed run of this skill).
