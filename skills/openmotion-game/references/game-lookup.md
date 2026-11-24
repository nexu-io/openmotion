> Written for OpenMotion; see [source and execution notes](../PROVENANCE.md).

# Reference Grounding & Capability-Boundary Lookup Protocol

LLMs routinely blur signature UX/layout details of named hit games and overestimate accuracy on realtime 3D physics, feel constants, and constructive generators — shipping generic or broken approximations from memory. When a brief hits a trigger below, **perform 1–2 focused, read-only web searches via the host's search tool (when available) before writing `design/plan.md`**, strictly inside OpenMotion's local runtime boundaries.

> **Clarification on `game-flow.md` safety boundary:** Lookup here means **read-only research** for game mechanics, layout grammar, visual references, state machines, and parameter ranges — never download or execute remote scripts, install packages, call third-party generation APIs, or put external URLs in game files.

## 1. Mandatory Lookup Triggers

| Domain | Trigger Condition | Research Target (Never Copy Assets or Full Repos) |
|---|---|---|
| **Named Reference Game & Genre Grammar** | Brief names a specific reference title (e.g., *"like Sheep a Sheep / Vampire Survivors / Balatro / Suika"*) or a distinctive sub-genre whose UX/layout structure defines the fun | Research that **exact reference game/genre first**: ① core loop & signature tension/lifelines; ② **spatial board/arena layout & information-visibility rules** (e.g., central staggered multi-layer mound + narrow-peek blind side-stacks + dimmed readable under-tiles); ③ visual vibe, palette mood & material feel; ④ key tuning baselines |
| **3D Physics & 3C** | Capsule/sphere wall-sliding, slope handling, arcade kart steering & drift state machine, FPS pointer-lock / aim-assist magnetism / recoil damping | State transitions, tangent projection math, playtested damping/friction ranges (GDC talks, arcade racer/FPS feel breakdowns) |
| **2D Feel & Physics** | Platformer jump-arc gravity curves, 2D circle/rigid-body stacking & impulse resolution (e.g., merge physics), steering/Boids avoidance | Tuned gravity/coyote/buffer ms ranges, stable fixed-step impulse and positional correction formulas |
| **Constructive Generation** | Guaranteed-solvable puzzle dealing (tile-stack, parking jam, sokoban), WFC/BSP map generation, A* / flow-field pathfinding | Constructive reverse-dealing algorithms, lightweight grid/graph solvers (pair with the spatial layout grammar above — never replace signature board structure with a flat academic grid) |
| **Vendored Engine APIs** | Non-trivial Three.js camera, instancing, raycasting, animation mixing, or shader patterns | Official Three.js docs/examples matching the draft's vendored `vendor/LICENSE-three.txt` / `vendor/three.module.min.js` (or `templates/game-kits/vendor/` when repo read exists) |

Skip lookup on simple, self-contained **Fast Track** briefs that name no reference game and need only straightforward rules, HUD layouts, or synthesized WebAudio blips.

## 2. Runtime-Safe Borrowing Priority

Every borrowed technique must execute cleanly inside OpenMotion's zero-CDN static bundle and deterministic `logic.js` VM (no `import`/`require`):

1. **P0 — Built-in OpenMotion primitives:** Reuse shipped starter kits (`arcade-2d`, `coop-3d`), vendored Three.js, and bundled CC0 models first.
2. **P1 — Reference game breakdowns & mechanics/parameter baselines (preferred):** Distill the reference game's spatial layout, visibility grammar, state machines, and tested parameter ranges; implement cleanly in original pure JS/CSS/art.
3. **P2 — Minimal same-stack JS/TS references:** Inspect only isolated algorithm snippets from lightweight Web/Canvas/Three.js examples. Never port heavy Unity/Godot scaffolds blindly or copy external asset URLs.
4. **P3 — Author from scratch:** Core game rules, UI, balance curves, and synthesized audio.

## 3. Distill Before Coding (Technical & Reference Brief)

Before coding, write a concise 5–8 line note in `design/plan.md`:
- **Reference layout & visual grammar (when referencing a game/genre):** Signature board/arena geometry, stacking/layering cues, what stays visibly dimmed vs truly hidden, and visual mood/palette alignment.
- **Mechanism:** Exact state machine or algorithm (e.g., 3-state kart drift; constructive reverse-deal over a staggered multi-layer mound + side blind stacks).
- **Parameter baseline:** Concrete starting numbers placed into `logic.js`'s top `config` block.
- **Runtime adaptation:** Coordinate axes, fixed-step `dt` normalization, and deterministic `ctx.random()` usage.

## 4. Offline / No-Search Fallback

If the connected host has no web search tool, never fabricate URLs or claim research occurred. Implement the cleanest proven mathematical approximation (e.g., tangent wall-slide projection, reverse-dealing puzzle generator, clamped spring-damped camera), expose every feel constant in `config`, and record the unverified baseline under `Known gaps (P2)` in `design/verification.md`.
