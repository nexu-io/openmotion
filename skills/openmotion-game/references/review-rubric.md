> See [source and execution notes](../PROVENANCE.md).

# Game review rubric

Run this before setting a game ready or publishing it. Mechanical checks are a floor; actual headless gameplay review (playtest screenshots, assertions, simulation outcomes) is still required, and none of it replaces human play on real devices.

## Gameplay and verification
Game-specific completion checks: six exports; deterministic authoritative rules; bounded validated inputs; no client-trusted damage; relative assets load; clip transitions; reachable win/loss; restart; co-op starts with one player by default; touch joystick/tap and keyboard/mouse (including release/cancel and focus loss); disconnect/rejoin and late join; performance on the weakest target; sound-disabled play; `openmotion_game_validate`; required server-owned `openmotion_game_playtest` with meaningful 1–4 client scripts and inspection of errors, failed requests, screenshots, joined/player-count metrics. Validate real HP/down/revive, solo five-second respawn, dash/nova cooldowns, wave countdown, spawn order and restart. Before publication, require `design/plan.md`, `design/assets.csv` and `design/verification.md`: experience formula, numeric metrics/thresholds, wave/difficulty plan, sources/licenses/costs, actual inputs/results and known gaps. Run `openmotion_game_simulate` for both routes: reference must win, idle must lose terminally; timeout is not a loss. Check `window.__omGame` snapshot/action hooks and `?debug` metrics, then inspect every playtest assertion (player count, phase, net displacement above threshold, no horizontal overflow at 390×844). Missing design files produce non-blocking reminders but still require the Agent to complete the artifacts. Before publication, verify concise title/description/controls, zh-CN i18n and a real project-relative cover set with openmotion_game_update_meta. **Require `openmotion_game_capture_cover` for game-only cover capture. Never operate, attach to or screenshot the user's visible browser, existing profile or desktop. Reject covers containing browser chrome or unrelated windows; metadata enforces at least 960×540 and 16:9 ±5%. A missing headless browser/loopback permission must be reported; do not substitute the user's Chrome.** Review advisory missing-cover/starter-similarity warnings; do not add filler lines to clear them. Report non-blocking publication metadata warnings. Publication requires authorization and stays local.

## Mechanical gate (code and asset level)

Check each item; fix every hit before setting ready.

1. **Placeholders**: no leftover starter strings (the arcade-2d "catch sparks, dodge rocks" sample, `lorem`, `TODO`, empty `src=""`), no starter title as the game title.
2. **Game-first screen**: the playfield fills the viewport from the first frame; no landing-page layout, hero headline or feature list beside the game (see `game-genres.md` quality floor).
3. **Palette follows the approved STYLE FORMULA & combat readability**: palette roles (environment, hero contrast, signal hue) are respected and both heroes and enemies pop clearly against the background. There is no fixed list of banned palettes for games: neon on near-black is right for cyberpunk or synthwave briefs, warm beige for cozy ones. Reject a palette or camera framing when it breaks readability (hero or enemies blend into the ground/skybox, 3D enemies look like tiny unreadable specks in playtest screenshots, signal hue reused on scenery, or critical cues distinguished by color alone).
4. **Asset kit complete and referenced**: every row in `design/assets.csv` is either used by the game or removed; every generated asset is embedded as a complete literal `/motion-api/assets/<assetId>/versions/<versionId>/media` URL (or a relative bundled path, never assembled dynamically by string concatenation) and loads without errors in the playtest failed-request list; each row records source, license and actual approved cost or zero.
5. **Multimodal-first & style fidelity honoured**: separate required assets (human/anime characters, portraits, requested illustration/cover art, background music, spoken voice) from optional polish. When discovery lists a fitting model, generated assets must be used for those required roles, **match the requested rendering medium** (e.g. an `anime` / `二次元` brief must look like 2D/2.5D anime illustration consistent with the game art, never a live-action DSLR photograph pasted onto a vector canvas), and be **visually verified in playtest screenshots inside the active gameplay/character scenes** (loading an image only on the title screen while active gameplay still draws primitive stick-figure characters fails this item). Any fallback of a required asset must record the concrete blocker in `design/plan.md` (user declined consent, account lacks entitlement, no fitting model listed, or host lacks media tools).
6. **Audio floor**: short SFX are synthesized with Web Audio (or generated when a model exists); the audio context starts from a user gesture; a mute toggle exists; the game remains playable muted.
7. **Fallbacks**: every generated image/audio load has a visible loading state and a code-drawn or silent fallback; a failed asset never blanks the canvas or blocks start.
8. **Reduced motion and flashes**: screen shake and full-screen flashes have a toggle or respect `prefers-reduced-motion`; nothing flashes more than three times per second.
9. **Touch and layout**: touch controls exist (buttons at least 56 px), no horizontal overflow at 390×844, `h-dvh`/`100dvh` instead of `100vh` for full-height layouts on mobile.
10. **Copy self-audit**: title, goal line, controls, HUD and end-card strings re-read in every shipped language (English plus `zh-CN` metadata); no broken grammar, unexplained jargon or fake-precise numbers.
11. **Licenses**: `vendor/`, `characters/` and any supplied asset keep their license files; generated assets list provider/model in `design/assets.csv`.

## Playable-ad addendum

For a **Format: playable ad** brief, score each line 0 (missing), 1 (partial) or 2 (meets the [playable-ad recipe](game-playable-ad.md)) and record the scores with evidence in `design/verification.md`. Ship only with no 0 and a total of at least 10 of 12; name every 1 in the final message.

| Line | 2 means |
|---|---|
| First-frame play | Scene and player object drawn on the first frame, no title card; the first touch anywhere starts play and scores within 1 s |
| Tutorial | Animated hand on the exact first-move target with one short line; hides on input, returns after the hint delay |
| Level arc | 3–8 levels: obvious level-1 win, a near-fail level (pilot `maxDanger` 0.6–0.9), a twist; reference wins and idle loses terminally in `openmotion_game_simulate` |
| End card and CTA | Win and fail cards both reached in playtest; CTA (primary) and Play again (secondary); CTA tap logs `cta_click` through `openStore()`, Play again never does |
| Single file | Inlined `index.html` regenerated from the sources; zero requests; no storage, dialogs or SDK stubs; size reported |
| Polish | No overlapping HUD numbers or popups at 390×844; corners free; feedback on every input; three languages fit |

## Optional post-publication trailer acceptance

- Offer a trailer after publishing; run `openmotion_game_trailer` only when requested. Use its server-owned headless recording, never the user's visible browser/profile/desktop.
- Inspect three actual gameplay clips, title/cover, localized title, short captions and Play now/controls in the editable native project. Generic recorded inputs are not a substitute for the required reference-win and idle-loss simulations.
- Report ready only when the existing export pipeline finishes and videoUrl is available. Verify the final MP4 separately from composition JSON or a created project. The output is silent.
- Report missing Chrome/ffmpeg/export runtime, interrupted jobs, errors and retained clips/projectId honestly. No dependency download, paid generation, internet hosting or human video acceptance is implied.

## Multiplayer entry checks

Apply the [automatic-join acceptance checklist](../SKILL.md#mandatory-multiplayer-entry-acceptance).
