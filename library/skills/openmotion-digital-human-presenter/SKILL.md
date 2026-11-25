---
name: openmotion-digital-human-presenter
description: >-
  OpenMotion — Plan and produce a digital-human or talking-head presenter video: lock a reusable presenter identity in Workspace Assets, generate sentence-paced narration, drive lip-sync when available (or frame native cutaways and B-roll cleanly when lip-sync is coming soon), overlay editable captions and Motion cards, and support single-sentence partial updates via asset provenance.
---

# OpenMotion · Digital Human Presenter

Build the presenter video as a native OpenMotion HTML/CSS/JS composition through the installed OpenMotion production workflow (`openmotion_create_project`, `openmotion_edit_project`, `openmotion_open_preview`, `openmotion_export_request`). This Library Skill provides creative and orchestration guidance without registering new MCP Tools. Always obtain spend approval before any paid media generation, and never invent quotes, claims, metrics or dates.

**Use for:** product introductions, founder updates, knowledge explainers and multilingual presenter segments that combine a consistent presenter persona with clean Motion graphics and captions.

## Capability routing

1. **Discover active capabilities first**: Call `openmotion_capability_discover` with `action: "list"` (and `includeComingSoon: true` if checking lip-sync availability).
2. **Presenter identity anchor**:
   - Reuse the user's supplied portrait/footage in Workspace Assets (`openmotion_asset_manage` with `action: "import"` or `"list"`), or generate 1 clean presenter anchor portrait via `openmotion_capability_run` (`capabilityId: "character"` or `"text-to-image"`).
   - Keep lighting neutral, shoulders square, mouth relaxed, and 25–30% negative space for side callout cards or lower-third titles.
3. **Sentence-paced voice narration**:
   - Break the approved script into natural breath-group sentences (6–14 seconds per beat).
   - Generate spoken audio per beat via `openmotion_capability_run` (`capabilityId: "speech"`) and track via `openmotion_job_manage` (`action: "status"`), so a later single-sentence price or wording edit only regenerates that one audio beat.
4. **Talking-head visual execution (live slot vs fallback)**:
   - **When `lipsync` or `digital-human` is `live`**: call `openmotion_capability_discover` (`action: "describe"`, `capabilityId: "lipsync"`) and `action: "quote"`, confirm high-cost spend with the user, then run `openmotion_capability_run` pinning the presenter portrait reference and spoken audio version.
   - **While `lipsync` is `coming_soon`**: tell the user plainly before generating that phoneme lip-sync is not yet active on this workspace, and offer two clean options: (a) use subtle `image-to-video` presenter intro/outro shots paired with full-screen native Motion UI/product visuals during spoken body lines, or (b) frame the presenter portrait inside a clean studio PiP card alongside dynamic waveform + kinetic typography and B-roll cuts.

## Look and Motion

| Element | Starting value |
| --- | --- |
| Framing | 16:9 split stage (presenter 42% left, Motion visual stage 58% right) or 9:16 vertical presenter with top/bottom graphic beats |
| Lower third | Solid theme card, 1.8 s hold on first appearance, presenter name + role |
| Captions | Single-line phrase captions timed to measured audio (`caption_add` via `openmotion_assets_use` `action: "transcript"` or native text track), never covering chin or mouth |
| Cutaway rhythm | Cut to full-stage Motion charts, product callouts or B-roll every 2–3 sentences to avoid static talking-head fatigue |

## Partial Round-2 Edits (Provenance-First)

When the user changes a single sentence (for example updating a price or feature name in beat 2):

1. Inspect the project and affected asset versions via `openmotion_get_project` and `openmotion_asset_manage` (`action: "get"`).
2. Re-run **only** that sentence's `speech` asset (and its paired `lipsync` clip if used), passing `assetId` and `parentVersionId` to preserve version history.
3. Import the new pinned version via `openmotion_asset_manage` (`action: "import_to_project"`), ripple-adjust subsequent timeline beats by the exact measured duration delta in `openmotion_edit_project`, and leave all unchanged presenter clips, Motion scenes and background music untouched.

## Provenance

Original OpenMotion workflow specification for Unified Capability Center orchestration. Apache-2.0.
