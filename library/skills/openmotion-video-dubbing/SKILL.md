---
name: openmotion-video-dubbing
description: >-
  OpenMotion — Localize an existing video into target spoken languages with two coordinated modes: fast one-click dubbing when the dubbing capability is live, or fine-grained timestamped ASR transcription, duration-matched translation, segmented TTS re-voicing and editable bilingual/localized captions in an OpenMotion project.
---

# OpenMotion · Video Dubbing & Localization

Localize a source video's voiceover and captions into one or more target languages while keeping an editable OpenMotion project (`openmotion_create_project`, `openmotion_manage_project`, `openmotion_edit_project`, `openmotion_export_request`). This Library Skill adds localization workflow rules without registering new MCP Tools. Always confirm target language(s), glossary terms and paid generation consent before submitting paid audio/video jobs.

**Use for:** product demos, tutorials, founder announcements and marketing films that need localized voice tracks and synchronized captions across languages (such as English, Chinese, Japanese, Spanish or French).

## Dual-Mode Execution Strategy

First call `openmotion_capability_discover` (`action: "list"`, `includeComingSoon: true`) to check active audio/video localization capabilities:

### Mode A — Fast One-Click Dubbing (when `dubbing` is `live`)
- Call `openmotion_capability_discover` (`action: "describe"` and `action: "quote"`, `capabilityId: "dubbing"`) to check `preserveBgm` / `lipSync` options and estimated spend.
- Present the quote and get explicit user approval before running `openmotion_capability_run` (`capabilityId: "dubbing"`), then track with `openmotion_job_manage` (`action: "status"`).
- Deliver the localized video file directly for standalone requests, or import the pinned version into an independent project copy via `openmotion_asset_manage` (`action: "import_to_project"`).

### Mode B — Fine-Grained Stepwise Dubbing (live today & preferred for strict terminology or pacing control)
1. **Extract timestamped transcript (`asr-transcribe`)**:
   - Run `openmotion_capability_run` with `capabilityId: "asr-transcribe"` (or `openmotion_assets_use` `action: "transcript"` `command: "submit"` / `"get"`) on the source video/audio to obtain exact phrase start/end windows.
2. **Duration-matched translation**:
   - Translate each phrase to match the original spoken window within **±10% syllable/speaking duration** so cuts and visual callouts stay aligned without awkward speed-warping. Preserve brand names, product SKUs and user glossary terms verbatim.
   - Show the bilingual phrase table briefly when terminology or tone is sensitive.
3. **Phrase-aligned speech synthesis (`speech`)**:
   - Confirm spend approval for the planned speech segments, then synthesize clean target-language audio via `openmotion_capability_run` (`capabilityId: "speech"`), tracking each job via `openmotion_job_manage`.
   - Measure actual spoken duration (`openmotion_asset_manage` `action: "get"` + local `ffprobe`); if a translated line runs slightly long, tighten the phrasing or apply a gentle constant-speed adjustment (`<= 1.12x`) rather than clipping words.
4. **Assemble independent localized project copy**:
   - Duplicate the source project with `openmotion_manage_project` (`action: "duplicate"`) so the original-language cut stays intact.
   - Import the localized speech versions via `openmotion_asset_manage` (`action: "import_to_project"`), balance/duck original dialogue when needed, and write localized or bilingual caption tracks (`openmotion_assets_use` `action: "transcript"`, `command: "caption_add"` or `"captions"`).

## Partial Round-2 Edits (Single-Line Re-Dub)

When the user revises a translated term or price in one sentence:
1. Read the localized project and inspect the affected speech asset's `capabilityId`, `references` and `parentVersionId` via `openmotion_asset_manage` (`action: "get"`).
2. Regenerate **only** that single phrase's `speech` version (`assetId` + `parentVersionId`), update its caption cue and audio clip in `openmotion_edit_project`, and keep every other localized segment untouched.

## Provenance

Original OpenMotion localization workflow for the Unified Capability Center. Apache-2.0.
