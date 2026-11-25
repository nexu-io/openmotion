> Written for OpenMotion; see [source and execution notes](../PROVENANCE.md).

# Game Brief Standard

The brief is the single source of truth for the run: build against it, check every gate against it, and revise it first when evidence disagrees. Store the brief in `design/plan.md` (~1 page), the style formula in `design/style.md`, and the asset contract in `design/assets.csv`.

## Writing Rules

- **Describe player experience and observable bars, not code structure.** State what the player feels, concrete numeric thresholds, and what must never happen — not class or function names.
- **Tag every decision:** `[locked]` user-specified (ask before changing); `[target]` experience goal (means may change); `[assumption]` default (revise freely on evidence). Untagged lines count as `[assumption]`.
- **Every claim needs a check.** If you cannot name how a line will be verified (simulation, playtest probe, capture, or human play), cut it.

## Routing Header & Acceptance Contract (Top of `design/plan.md`)

Start `design/plan.md` by locking the run's concrete routing and verifiable quality bar:

- **Routing:** `Track` (`Fast` / `Full`) · `3C` (`discrete-ui` / `realtime-2d` / `realtime-3d`) · `Primary Loop` (+ optional secondary) · `Lookup Triggers` (list or `none`).
- **Acceptance Contract (3–5 game-specific rules):** Instantiate the Target Bars and Hard Fails from [3C contracts](game-3c-modules.md) and [core loops](game-genres.md) into concrete, measurable pass/fail thresholds for **this** game (e.g., *"Wall graze retains ≥ 65% speed and never stops the kart"*; *"On fixed seed, L1 trivial wins and L2 greedy fails past 65% progress while `reference` wins; 30-seed Node sweep confirms L2 naive win rate ≤ 15%"*). Include the `reference`-win / degraded-struggle / `idle`-loss contract here so thresholds are never duplicated.
- **Top `config` levers:** List the 4–6 highest-leverage feel/difficulty parameters exposed in `logic.js`'s top `config` block for 30-second human calibration.

## Creative Divergence & Signature Hook (Anti-Convergence)

Passing technical gates creates a bug-free prototype; **originality and delight** require breaking default model convergence and kit inertia right at brief time:

- **Honor explicit user style; keep open style truly open:** If the user specifies a visual style, theme, mood, or reference game, mark it `[locked]` and follow it faithfully. Whenever the user leaves theme or visual style **open**, never fall back to a preset style list or inherit the starter kit's graybox shell:
  1. **Self-negate the first cliché:** Write one line in `design/plan.md` naming the single most predictable title, palette, and setting cliché that comes to mind first for this genre — then **explicitly reject it**.
  2. **Derive from open creative axes:** Invent a fresh visual premise from the full open space of physical craft/art media, times of day and lighting moods, everyday or cultural objects, and emotional registers (playful, crisp, tactile, dramatic, surreal, sunlit, bold, etc.) so the world grows organically out of the core verb rather than a recycled house skin.
- **Signature Twist & Peak Moment (required on every game, even when style is locked):**
  - **1 Signature Twist:** One clever rule interplay or player-agency hook beyond the textbook genre baseline that delivers an immediate *"wait, that's smart!"* moment (never settle for the minimum safe checklist implementation).
  - **1 Peak Moment:** One unmistakable gameplay + audio-visual climax (e.g., combo phase shift, weapon/deck evolution surge, clutch reversal, or playful visual payoff) so the session has real emotional rise-and-fall.

## The Nine Sections

Use these headings in `design/plan.md` (Fast Track may compress sections 4, 6, and 9 to 1–2 lines each). Keep `## Difficulty plan`, `## Brief changes`, and `## Follow-up opportunities` (publication turns follow-up bullets into user next-step prompts).

| Section | Write | Why It Matters | Check |
|---|---|---|---|
| **1. Pitch & Signature Twist** | "X meets Y, plus **one Signature Twist**" + audience, platform, session length. When the brief specifies a visual style or **"like X"**, lock that fidelity (`[locked]`: preserve recognizable spatial structure, visibility, and mood with original non-infringing titles/assets). When open, record your one-line **cliché rejected** + fresh creative premise | Delivers user intent while preventing bland, repetitive AI templates | Readable in two sentences; twist is playable, not decorative |
| **2. Experience target & Peak Moment** | `"The player feels ___ because the game constantly ___"`, 1–2 emotions, plus **one concrete Peak Moment** that escalates audio-visual & gameplay excitement | Mechanics and pacing derive from emotion and climax, not checklist inertia | Gate 1 play + Gate 2 climax review |
| **3. Core loop** | 30-second loop (`verb → feedback → reward`), ≤ 2 core verbs, first meaningful action within 10 s | 30 seconds of fun repeated is the game | Reference executes core verb within first 10 s |
| **4. Retention hooks** | Pick 2–3 aligned with the chosen Loop Engine (near-miss tension, combo synergy, flow ramp, pity rewards, local best score) | Drives "one more run" without diluting focus | Multi-tier simulation spread & session length |
| **5. Feel** | ≥ 3 concrete feedback channels on the core verb (hit-stop, shake, particles, floating numbers, flash, squash/stretch, WebAudio) | Feel decides the first 30 seconds | Counted & verified in `design/verification.md` |
| **6. Share design** | One shareable moment, screenshot-ready end screen (score + best in one line), striking first 5 seconds | Players share results and clutch moments | 5 s highlight capturable; clean end screen |
| **7. Style** | 60–90 word English style formula (`design/style.md`) built from open visual axes (zero recycled kit palette), 3 keywords, functional readability roles (ground vs hero vs signal contrast) | Shared visual anchor + gameplay readability | Gate 2 independent visual review |
| **8. Scope & budget** | Must have / must not / not this time; planned multimodal asset scope (unless zero-spend requested); performance budget from [game-flow.md](game-flow.md); open-world requests start as one playable district/arena | Prevents scope creep while actively leveraging multimodal quality gains | Validate + `?debug` stats |
| **9. Asset manifest** | Every row in `design/assets.csv` (`asset,source,license,cost` + source class & contract). Actively plan high-ROI generated **images** (backdrops, heroes, cards/tiles, seamless 3D textures), **short video clips / I2V animations**, and **audio** (and **3D models** once live) via OpenDesign/media tools whenever not restricted, referencing completed versions by their literal `/motion-api/assets/<assetId>/versions/<versionId>/media` URL; list procedural/CC0 fallbacks for offline or zero-spend runs | Breaks the hand-coded visual ceiling intentionally instead of defaulting to flat primitives | Every row loads cleanly or falls back without errors |

## Five Pre-Code Questions

1. Can the pitch + **Signature Twist** be stated in two crisp sentences, and is there one unmistakable **Peak Moment**?
2. Is the core verb playable within 10 seconds?
3. Are 3–5 concrete, game-specific Hard Fails written in the Acceptance Contract?
4. When visual direction is open, did you explicitly name and reject the genre's default cliché instead of copying a template skin?
5. Are `[locked]` user choices separated from `[assumption]` defaults, and does `assets.csv` plan real multimodal upgrades wherever they lift craft?

## Correcting the Brief

- **Review at every gate** against simulation, playtest, and visual evidence.
- **Three-tier response:** Wrong number → tune `config` (brief stays). Means fails → update `[target]`/`[assumption]` and record under `## Brief changes`. `[locked]` goal impossible → stop and ask the user with evidence and two alternatives.
- **Pivot instead of polishing:** If the core loop fails Gate 1 twice, stop tuning numbers and propose 2–3 alternative core verbs.
- **Brief leads code:** When the user says something is wrong, update `design/plan.md` before editing code.

## Tolerance

`design/plan.md` is read by people and agents, never strict-parsed by tools. Heading order and tag phrasing may vary; missing sections are reminders, not errors. Only `design/assets.csv` is consumed by code, and loaders must tolerate missing columns and fall back to procedural placeholders rather than failing.

## Skeleton

```markdown
# <Game title>

## Routing & Acceptance Contract
## Pitch
## Experience target
## Core loop
## Retention hooks
## Feel
## Share design
## Style
## Scope and budget
## Difficulty plan
## Brief changes
## Follow-up opportunities
```
