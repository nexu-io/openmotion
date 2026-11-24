> Written for OpenMotion; see [source and execution notes](../PROVENANCE.md).

# Staged Build, Dual Tracks, Gates, and Stop-Loss

Quality comes from a closed loop: an explicit acceptance contract, a playable build, honest verification, and disciplined stop-loss. Gates block on broken rules, Hard Fail violations, or off-brief drift — never on minor polish.

## Track selection

Select the track strictly by the routed modules so complex games never skip verification and simple 2D games avoid unnecessary overhead. **Precedence:** On **Fast Track**, this track supersedes the 5-stage sequence in `game-design-system.md` (which becomes optional) and default starter instructions.

| Track | Rule (Deterministic — Never Downgrade Subjectively) | Workflow |
|---|---|---|
| **Full Track** | **Any** holds: `realtime-3d`, `puzzle-pressure`, `strategy-combo`, multiplayer, multi-level progression (including playable ads), or generated multimodal assets | Full 5-stage pipeline below with Gate 1 (gameplay) and Gate 2 (independent visual review) |
| **Fast Track** | **None** of the above hold (solo, single-screen 2D `skill-flow` or simple `progression-rng`, zero generated assets) | Compact brief + Signature Twist + 3–5 Hard Fails → build core + `config` + Juice → single combined verification gate (`validate`, `simulate`, `playtest` + screenshot review) → cover & deliver |

## Full Track stages

| Stage | Work | Exit |
|---|---|---|
| **1. Brief & Lookup** | Write [brief](game-brief.md) (including Signature Twist, Peak Moment, open-style self-negation if unlocked), Acceptance Contract, `design/style.md`, and `design/assets.csv` (planning generated images/video/audio whenever not restricted). Run [external lookup](game-lookup.md) if triggered, plus read-only `openmotion_media_use` discovery | Five pre-code questions answered; batch any missing user decision with the single upfront multimodal asset confirmation when providers are live |
| **2. Graybox core** | Build the core loop from the neutral starter chassis with placeholders honoring `assets.csv` and top `config`. Kick off approved image/audio/video asset jobs once authorized | Gate 1 |
| **Gate 1: is it a game?** | Verify Acceptance Contract, Signature Twist feel, & Hard Fails (§Verification boundaries); count feel channels; review brief | Zero P0, gameplay P1 fixed. In interactive chat, share the playable link if any follow-up asset decision remains; in unattended runs, log and continue |
| **3. Vertical slice** | Bring one complete level/arena to final art, Peak Moment presentation, feel, and audio quality by wiring in approved generated assets (images, I2V spritesheets/clips, BGM/SFX, or 3D meshes when available) or procedural craft | Gate 2 |
| **Gate 2: does it look right?** | Capture the slice and run an independent visual review against `design/style.md` and 3C functional-visual Hard Fails | Zero P0, visual P1 fixed. Ready for optional trailer once status is `ready` |
| **4. Content expansion** | Expand levels, enemies, cards, or tracks to slice quality (parallelize independent content files when host supports sub-agents) | Smoke playtest per added batch |
| **5. Assemble and deliver** | Swap placeholders via manifest, final smoke playtest, `capture_cover`, final `verification.md`, `validate`, `update_meta`, `set_status("ready")`, authorized publish | Final message with `config` levers & P2 list |

**File ownership:** Parallelize content, never core rules. One owner maintains `logic.js` (one self-contained file in the bounded VM), `design/*`, `index.html`, and `assets.csv`.

## Verification boundaries

Keep authoritative rules, progression, and win/loss conditions in `logic.js` for **every** game (never build a fake parallel physics stub). Use each harness for what it actually proves:

- **Deterministic three-tier simulation (`openmotion_game_simulate`):** Primary balance/spread harness for `puzzle-pressure`, `strategy-combo`, and `progression-rng`, and win/loss sanity check for `realtime-2d`/`realtime-3d`. Always pass the exact game `id`. Note that `openmotion_game_simulate` runs on **one fixed seed** (`'game-simulation'`), caps total scripted inputs at `100,000`, and caps summary JSON at `32 KiB`:
  1. **Skilled (`scripts: "reference"`):** Must terminate with `{ over: true, winners: [...] }` (and synergy/skill beats naive play). **Endless / 3-miss arcade rule:** Even when the brief describes an endless or 3-miss score-chaser, define a **real player-facing** win milestone in `config` (e.g., survive 45 s or reach 30–40 parries/combo) so `isGameOver` registers `{ over: true, winners: [playerId] }` on the exact same code path for humans and `simulate` (optionally offer a client "Continue Endless" button after victory — never gate victory behind a simulation-only flag), and script `referenceRoute` cleanly through that win. Never leave `winners` permanently empty.
  2. **Weak (explicit degraded `GameSimulationStep[]` array — thinned/delayed or naive greedy actions; do not pass `"degraded"` as a string):** Should progress partway and struggle or lose. If weak wins as easily as skilled, difficulty is too flat.
  3. **Idle (`scripts: "idle"`):** Must reach a terminal `loss` (`over: true, winners: []`) cleanly within default simulation budgets (`< 2500` ticks; timeout `over: false` is not a loss). For untimed puzzles or turn-based games, tune silent `config.idleAutoPassTicks` / `config.idleLossTicks` into **`1200–2200` ticks** (e.g., 60–110 s at 20 Hz) — generous enough for real thinking yet guaranteed to pass default `simulate` probes without a frantic visible clock.
  - **Simulation budget & speed discipline:** Keep `referenceRoute` sparse and non-overlapping (avoid multi-entry full-span rules across 4 players that trip the `100,000` scripted-input cap), keep `maxTicks ≤ 2500`, and export a compact `summarize(state)`. When local Node shell access is available, run fast 50–200 seed sweeps directly on `logic.js` (`< 1 s`) for numeric tuning before running **one** clean MCP `simulate` confirmation set (`reference` + `weak` + `idle`) instead of 15–30 incremental MCP simulation loops. Batch related source changes into single `openmotion_game_write_files` calls.
- **Headless browser playtest (`openmotion_game_playtest`) — focused & budgeted:** Primary 3C, physics, and visual harness for `realtime-3d` and continuous-physics `realtime-2d`, and layout/runtime gate for all games. Always test at least one negative/boundary path (wall-scrape, wrong click, missed timing, or failure recovery), verify any rules/help/deck modal opens and closes cleanly via its close button (bind explicit `dialog.close()` / `Escape` handlers in addition to `<form method="dialog">`), and capture both opening and active mid-play states (**on multi-level games, always capture and visually inspect Level 2 / peak mid-game pressure state — never only an easy Level-1 tutorial screen**):
  - **`discrete-ui` cap:** Do balance/solvability math in `simulate` / Node, and keep `openmotion_game_playtest` to **1–2 consolidated runs per turn** (covering active peak-level stacking/hand readability, max-density `390×844` layout, and console/network cleanliness, plus a follow-up only when fixing a failure).
  - **`realtime-3d` / multiplayer pacing:** Build incrementally on the shipped kit (`coop-3d` / `arcade-2d`) and write a working playable baseline early in the turn before extra polish. Run 1 focused Gate-1 hazard/physics playtest (and multi-client auto-join check for co-op) plus 1 Gate-2 visual/cover review. Reserve budget to finish `capture_cover → verification.md → validate → update_meta → ready → publish` cleanly within the same turn — never burn the entire turn iterating minor visuals and leave the game stuck in `building`.
- **Anti-reward-hacking rule:** Keep Acceptance Contract thresholds fixed for the iteration. Never let `pilot`/`referenceRoute` cheat by clicking illegal blocked tiles or peeking at genuinely hidden face-down deck/blind-pile order (do **not** blank out partially covered board tiles in `viewFor` — those symbols stay dimmed yet readable to players), and never weaken assertions to force a green run — fix the game or tune one `config` value at a time. A test that always passes regardless of bad input is not evidence of a working rule.
- **Unavailable headless Chrome fallback:** If Chrome/loopback is unavailable, run `validate` and `simulate`, explicitly report all skipped visual/playtest checks as blocked by environment limits, and never fall back to the user's visible browser.

## Independent review

Give a fresh-context reviewer **only** `design/plan.md` (Acceptance Contract), `design/style.md` (or target image), and actual `openmotion_game_playtest` / `capture_cover` captures. It returns `pass` or `fail` and at most the 3 highest-impact P0/P1 issues. Without sub-agents, run a separate read-only review pass reading only those files — never grade your own build from memory.

## Stop-loss rules

- **Three issue levels:** **P0 blocking** (errors, freezes, Hard Fail violation, unwinnable/unlosable loop, collapsed FPS); **P1 experience** (in-scope feel/difficulty at Gate 1, style drift/readability/HUD clipping at Gate 2); **P2 polish** (minor details and rare edge cases). Fix P0 and in-scope P1; log P2 in `design/verification.md` under `## Known gaps (P2)` and do not fix it inside the loop.
- **Scope discipline:** Gate 1 ignores final art; Gate 2 ignores balance numbers; content items get a smoke playtest only. Stop when a gate passes or after 2 rounds that barely improve the result.
- **Rank by frequency:** A rare non-blocking edge case across simulation and playtest runs is P2.
- **Round limits:** At most 3 P1 rounds per gate, then hand remaining P1 issues to the user. Fix P0 until resolved; if P0 keeps returning across 2 rounds, trigger the brief pivot rule.
- **No token cap:** Cut waste (via Fast Track and stop-loss), not quality.

## Reporting P2 to the user

Automated harnesses eliminate hard defects (raising the floor to a solid playable build), while final feel nuance belongs to human hands:
- Surface the 3–5 highest-leverage `config` parameters (e.g., drift grip, spawn ramp, lifeline count) in plain language so a 30-second playtest tweak takes one follow-up message.
- List at most **five numbered P2 items** (highest impact first, one sentence each stating what the issue is and what it affects; if more exist, add `"N more details are recorded."`) and close with one question asking which items to fix, or to leave them. Fix only chosen items, then re-verify.
