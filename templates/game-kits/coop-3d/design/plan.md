# 3D Co-op Starter Chassis — blank draft (replace completely)

This is a **theme-neutral multiplayer engineering scaffold** (room sync, 20 Hz tick, revive/respawn, Three.js budget), NOT a finished game design. Replace the neutral graybox arena, target prop, enemy silhouettes, lighting, HUD copy, and generic Skill 1/2 verbs completely to match the user's brief. Tags: [locked] user decision, [target] experience goal, [assumption] default to revise.

## Pitch & Signature Twist
[assumption] Replace with the user's game pitch, one-line genre cliché rejected (when style is open), and one concrete Signature Twist beyond a plain arena defense loop.

## Experience target & Peak Moment
[target] Replace with the target player feeling and one unmistakable gameplay + audio-visual Peak Moment (e.g., evolution surge, clutch rescue, or arena phase shift).

## Core loop
[target] Define the real 30-second verb → feedback → reward loop from the brief; first meaningful action within 10 seconds of start.

## Retention hooks
[assumption] Define escalating wave/build choices, synergy spikes, and local best record aligned with the brief.

## Feel
[target] Replace placeholder oscillator blips and graybox meshes with tiered hit-stop, camera shake, directional particles, and expressive audio.

## Share design
[assumption] Define the shareable highlight moment and concise one-line summary on the end screen.

## Style
[assumption] Author an original 60–90 word English style formula in `design/style.md` from open creative axes (or `[locked]` user style) — never keep the neutral graybox chassis colors.

## Scope and budget
- One arena/district, 1–4 co-op players; keyboard/mouse and touch controls. Start alone; invite teammates directly via `?room=` link.
- [assumption] Plan generated image/video/audio (and 3D models once live) via OpenDesign/media tools whenever they elevate craft and are not restricted; fall back cleanly to bundled CC0 characters and procedural geometry when offline or zero-spend is requested.
- Render target: 60 FPS desktop, 30 FPS weakest declared mobile device; at most 100 draw calls, 100,000 rendered triangles, four animated players, 64 visible enemies and 32 shot trails. SwiftShader timing does not establish hardware acceptance.

## Metrics and thresholds
- Downed allies revive after 40 consecutive nearby ticks; solo respawn takes 100 ticks (five seconds). Skills must respect server cooldowns.
- Identical seed, player count and input routes must produce identical summaries and final results.
- Headless browser checks: expected player count, active phase, scripted net movement greater than 0.5 world units, and no horizontal overflow at 390x844.

## Reference-win / idle-loss contract
- Reference route must win: all configured players finish five waves with objective HP above zero within 2,500 ticks. Run the game-provided reference through openmotion_game_simulate.
- Idle must lose: zero input must produce a loss with no winners and objective HP zero within 2,000 ticks. Automatic touch aiming still requires fresh input; it must not make zero-input play win.
- A weaker degraded route (reference inputs thinned or delayed) should struggle and often lose; if it wins as easily as the reference, the waves are too easy.

## Difficulty plan
Simulation runs at 20 Hz. The config block in logic.js owns the actual values: enemy count 4 + 2 per wave, HP 2 + floor(wave/3), speed 1.1 + 0.12 per wave. Hunters pressure living players; siege enemies threaten the crystal. First wave waits 40 ticks; cleared waves give a heal/repair and 80-tick breather. Nova timing and rescue create alternatives to standing still. Tune only after comparing reference, degraded and idle results, preserving the declared thresholds for that iteration.

## Art and delivery
Keep every asset source/license/cost in assets.csv. Cover capture and multi-client testing run only through server-owned headless tools; never operate the user's browser or desktop. Record measured results, unavailable checks and the P2 polish backlog in verification.md. Publication is local and needs authorization.

## Brief changes
- None yet.

## Follow-up opportunities
- Add a final boss with a clearly telegraphed crystal attack.
- Tune the hunter and siege mix while preserving reference-win and idle-loss thresholds.
- Add an ally-protection skill with a readable cooldown and touch button.
