> Written for OpenMotion; see [source and execution notes](../PROVENANCE.md).

# Core Loop Engines, Genre Modifiers, and Quality Floor

Read alongside [3C contracts](game-3c-modules.md) during Brief planning. Pick **one primary Core Loop Engine** (plus at most one complementary secondary engine; avoid mixing contradictory tension arcs like abrupt puzzle walls with relaxing endless flow). Copy its Target Bar, Hard Fail, and probe checks into `design/plan.md`.

## 1. Universal Quality Floor (Every Game)

- **Game-first viewport:** Full-screen playfield from frame one. Title/end overlays stay compact and centered (never a landing page beside a boxed game). First input starts play within 1 s.
- **3-second clarity:** Goal readable in ≤ 12 words plus concise key/touch hints; zero tutorial paragraphs.
- **Multi-channel juice:** Core verb triggers ≥ 3 feedback types within 1 frame (hit-stop, shake, particles, floating numbers, flash, squash/stretch, pitch-stepped WebAudio). Name them in `design/verification.md`.
- **Session & instant retry:** Arcade/casual runs target 30–120 s with a stated ramp; death/loss to restart takes ≤ 2 s. Store local best score unless playable-ad rules forbid storage.
- **Art & asset floor:** One role-based palette from `design/style.md`. Heroes and key objects need readable silhouettes (never bare flat circles/boxes). When the brief involves human/anime characters, illustrations, key art, music, or voice and a fitting OpenDesign/provider model is listed, generate those assets first (see `game-stylization.md`) rather than drawing people from primitives; fall back to bundled CC0 or crisp procedural art when unavailable or declined — never unverified external URLs.
- **Single tuning block & touch parity:** Place all gameplay/feel tunables in one top-level `config` object in `logic.js`. Provide genre-fit touch controls (≥ 56 px targets; full portrait playability at 390×844).
- **Test hook contract:** Expose `window.__omGame = { getState, getStats, sendAction }`. `getState()` must return `{ selfId, players: { [selfId]: { connected: true, x, z } }, phase, result }` with top-level `phase` in `'playing' | 'win' | 'loss'` (store turn/level sub-states in `subPhase`, or pass `expectedPhase` to playtest). Export `pilot(state)` and `referenceRoute` from `logic.js`.

## 2. Starter Kits

- **`coop-3d`:** Multiplayer briefs with `genre: "shooter"`, `style: "3d"`, or default genre (Three.js arena in `vendor/`, KayKit `characters/`, rooms, revive, waves).
- **`arcade-2d`:** All solo briefs (full-screen canvas, fixed-step `logic.js`, multi-input, juice helpers, portrait switch, `window.__omGame`). **Always pass `style: "3d"` on solo 3D briefs** so `create` copies `vendor/` (vendored Three.js); keep the `arcade-2d` loop/input/hook and render with Three.js.
- **Minimal room `starter`:** Non-3D multiplayer genres other than shooter.
- If a draft lacks the kit, read `templates/game-kits/<kit>/` when repo read is available; otherwise match the same contract.

## 3. Core Loop Engines (Pick 1 Primary)

### Puzzle & Space Pressure (`puzzle-pressure`)
*Examples: tile-stack match (Sheep-a-Sheep style), screw/bolt unscrewing, parking-jam, tight-grid match.*
- **Driver:** Finite buffer/space tension + partial occlusion + "one move short" compulsion.
- **Target bar:**
  - Two-beat arc: Level 1 delivers a fast confident win (10–20 s); Level 2+ builds real buffer pressure where naive play regularly reaches the final 20–30% of tiles/steps before risking failure.
  - Boards are guaranteed solvable by construction (reverse-dealing or validated state invariants, never naive random scatter).
  - 2–3 bounded recovery lifelines (undo, shuffle, temporary tray) each counter a distinct fail state by restoring hope rather than auto-winning.
- **Hard fail:** Unsolvable random deals; Level 1 causes accidental failure on reasonable play; Level 2 clears easily via random clicks; zero visual alert when ≤ 2 buffer slots remain; stripping visually exposed covered tiles to `kind: null` / opaque padlock boxes in `viewFor` (partially covered board tiles must keep their dimmed symbols readable for player planning — only genuinely buried face-down piles such as deep blind side-stacks stay hidden until exposed); `pilot(state)` selecting illegal blocked tiles or peeking into unrevealed hidden piles.
- **Probe:** Run `openmotion_game_simulate` (fixed seed) across 3 input tiers (`reference` wins L1–L2 cleanly; explicit weak/greedy step array wins L1 and struggles/fails late on L2; `idle` hits terminal `loss` via a silent `config.idleLossTicks` inactivity guard — never bolt a frantic visible timer onto an untimed puzzle). When local Node shell access exists, also run a 20–50 seed sweep on `logic.js` to verify L1 > 90% and L2 naive win rate ≤ 15%.

### Strategy & Build Synergy (`strategy-combo`)
*Examples: deckbuilders, tactical cards, survivor/roguelike builds, tower defense, auto-battlers.*
- **Driver:** Meaningful cost/resource trade-offs + multiplicative synergy + input randomness before player decisions.
- **Target bar:**
  - Randomness lands **before** decisions (hand draw, 3-choice upgrades, telegraphed enemy intent) so players solve with agency.
  - Turns 1–3 (or early waves) offer ≥ 2 viable choices per decision point; synergistic combos produce visibly non-linear payoff (≥ 1.5× naive additive picks).
  - At least 2 distinct build archetypes can clear the run against escalating peaks/bosses.
- **Hard fail:** Dead hands / zero playable options for 2+ consecutive turns; a single dominant card/tower clears > 80% of runs regardless of synergy; upgrades are flat +1% tweaks with no behavioral shift.
- **Probe:** Run `openmotion_game_simulate` comparing `reference` (synergy policy), an explicit degraded/naive step array, and `idle` (for turn-based games, use `config.idleAutoPassTicks` so sustained zero-input auto-ends turns and enemies force terminal `loss`). Verify clear tier separation; optionally run multi-seed Node sweeps when shell access exists.

### Skill, Flow & Dynamic Tension (`skill-flow`)
*Examples: kart racing, 3D/2D shooters, endless merge/physics (Suika), platformers, `.io` arenas, one-button runners.*
- **Driver:** Risk-reward execution at control's edge + escalating tempo + comeback/near-miss saves.
- **Target bar:**
  - Smoothly ramping tempo or lap/wave cadence (never an unfair brick wall on attempt one).
  - High-skill maneuvers (drift boost, headshots, chain merges, near-miss grazes, David-vs-Goliath takedowns) trigger immediate, unmistakable reward.
  - Racing/arena rivals follow real lines with bounded catch-up (rival pace clamped within ~±15%, never blatant teleportation); survival/action games include a brief near-death cushion (post-hit i-frames ≥ 0.4 s) to enable clutch saves.
- **Hard fail:** First mistake ends the run in < 10 s, or difficulty stays flat indefinitely; AI rivals freeze or visibly cheat; player skill fails to separate finish times/scores.
- **Probe:** Run `openmotion_game_simulate` (`reference` terminal win with `winners: [playerId]` — including a concrete `config` milestone for endless/3-miss designs — plus degraded struggle and `idle` terminal loss `< 2500` ticks) on authoritative `logic.js`, and use `openmotion_game_playtest` as the primary 3C/physics/visual harness checking displacement, wall-slide, aiming/collision, and frame/layout integrity.

### Progression & Variable Rewards (`progression-rng`)
*Examples: chest-opening RPGs, incremental clickers, idle gear loops, collection builders.*
- **Driver:** High-frequency variable-ratio anticipation + milestone power jumps + qualitative rule unlocks.
- **Target bar:**
  - Low cognitive load with rapid reward cadence: maximum wait between noticeable power jumps or rarity reveals stays ≤ 20–30 s in early play.
  - Pseudo-random / pity protection caps unlucky streaks; pair numeric growth with periodic qualitative unlocks (new trait, auto-trigger, visual tier upgrade).
  - Balanced sources and sinks prevent instant overflow or dead stalls.
- **Hard fail:** Repetitive tapping wall with zero visible change; unguarded pure RNG causing long dry streaks; runaway `NaN`/`Infinity` overflow or trivial instant max-out.
- **Probe:** Run `openmotion_game_simulate` over the session tick budget verifying milestone unlocks, bounded pity counts, finite numbers, and terminal `idle` loss (or defined session fail condition).

## 4. Compact Genre Modifiers (Layer When Relevant)

- **Platformer:** Coyote time (~0.1 s), jump buffer (~0.1 s), variable jump height, lead camera, ≥ 1 checkpoint + exit, ≥ 2 hazards; pixel art uses integer scaling (`image-rendering: pixelated`).
- **One-button / hypercasual:** Exactly one input bound (tap/click/Space/Enter), < 3 s clarity with high-contrast target ring vs incoming hazards, tightening timing window logged per minute, near-miss/perfect bonus, concrete milestone win in `config` (so `simulate(reference)` returns `winners: [selfId]`, with optional endless continue), restart ≤ 2 s.
- **Racing:** Track bounds, ≥ 2 AI racers on racing lines that can overtake, live rank (`1st/2nd`), lap/checkpoint counter, drift/boost, finish time screen; touch steer + throttle.
- **Horror / puzzle escape:** ≥ 2 chained clues/puzzles, telegraphed threat (audio/light cues), darkness + light source, fog/ambience, touch-reachable interactions.
- **Story / visual novel:** Consistent scene art, tap-to-complete / second-tap-to-advance typewriter box, ≥ 3 stateful choices, ≥ 2 distinct endings, back-log and scene restart; readable at 390×844.
- **Co-op survival:** ≥ 3 visually and behaviorally distinct enemy roles (e.g., fast chasers, heavy objective-siege units, ranged casters with telegraphed shots) plus a Boss wave with an animated ground telegraph and countdown, ally revive with visible progress ring, resource pickups, and a bright high-contrast focal objective readable on both `1280×720` and `390×844` (never dark muddy arena or clipped header). Verify 1- and 2-player (plus up to 4-player) `simulate` without hitting the 50 ms VM tick ceiling, verify auto-join from `?room=` via `openmotion_game_playtest`, and report the actual direct-join invite URL (`playUrl?room=<id>`) with clear local/LAN scope.
- **Versus reaction / party (2–4 players):** Server-authoritative signal timing and tap ordering (ignore client timestamps), false-start penalty, 10–20 fast rounds (~60 s), live ranking, large portrait buttons.

## 5. Playable Ads

A brief with **Format: playable ad** (portrait, single player) follows [game-playable-ad.md](game-playable-ad.md) instead of the title-screen and session rules above, plus its no-storage ban, single-file inlined `index.html`, and §10/§11 QA & delivery overrides (keeping §1's quality floor where not overridden).
