> Written for OpenMotion; see [source and execution notes](../PROVENANCE.md).

# 3C Interaction and Functional-Visual Contracts

Apply **only the one section** matching your game's control and camera profile. Copy its Target Bar and Hard Fail criteria into `design/plan.md` as concrete project checks. Functional visuals are gameplay readability — build them into the playable slice rather than deferring them as decoration.

| Profile | Section | Typical Games |
|---|---|---|
| Discrete click, tap, drag, or turn input | [`#discrete-ui`](#discrete-ui) | Tile/match puzzles, card/deckbuilders, board, idle/gacha |
| Continuous 2D movement, aim, or physics | [`#realtime-2d`](#realtime-2d) | Platformers, survivors/roguelikes, merge physics, `.io`, one-button |
| Continuous 3D movement, driving, or aim | [`#realtime-3d`](#realtime-3d) | 3D shooters, kart racing, 3D runners, co-op arenas |

---

## discrete-ui

**Discrete UI** — Use when gameplay advances through selections, drags, placements, or turns without continuous avatar velocity.

- **Target bar:**
  - **High-contrast figure-ground & occlusion clarity:** Interactive cards and clickable tiles must stay unmistakably brighter and higher-contrast than the dark table surface (avoid muddy dark-on-dark small text). Partially covered board tiles must keep their `kind`/symbol present in `viewFor()` and rendered visually with a clear staggered reveal margin (`≥ 25–35%` tile offset) plus `35–45%` cool muted dim/hatch so underlying symbols stay scannable for look-ahead planning (never replace partially covered tiles with opaque black squares or padlock icons), while clickable items show crisp bright rims/shadows. Even an easy Level 1 in a layered puzzle should include at least 1–2 genuine overlapping pairs so players learn the unlock contrast immediately on screen 1.
  - **Single prominent gaze-zone readout:** Anchor primary constraints — energy/cost, remaining tray slots, and enemy next-turn intent (action icon + **large bold value + timing**, e.g. `攻击 7 · 回合结束`) — in one unified, high-contrast slot directly on or beneath the target's HP bar / board header, updating synchronously on input (never tiny badge text or duplicated across distant corners).
  - Every valid input triggers proportional feedback channels ([feel & craft](game-feel-craft.md)) within 1 frame (easing/scale motion, particle or floating number, pitch-escalating WebAudio chime on chains).
  - Touch targets are ≥ 48–56 px with clean spacing (`≥ 10–12 px` gap) and hit forgiveness; drag actions preview the target slot and snap crisply on release.
- **Hard fail:**
  - Player cannot distinguish occluded/disabled items from clickable ones, covered tiles are blacked out with unreadable silhouettes, or taps produce zero visual/audio feedback.
  - Overlapping cards, truncated cost/effect numbers, truncated header labels, or clipped tray/prop buttons at `390×844` portrait layout under max HUD density (full hand / near-full tray).
  - Double-submit on rapid taps, or animation locks blocking input > 500 ms without clear progress state.
- **Playtest contract & lookup triggers:**
  - Pass `movementThreshold: 0` in `openmotion_game_playtest`, while still populating `window.__omGame.getState()` with `{ selfId, players: { [selfId]: { connected: true, x: 0, z: 0 } }, phase, result }` and top-level `phase` in `'playing' | 'win' | 'loss'` (store turn/level sub-states in `subPhase`, or pass `expectedPhase`). Keep `playtest` lean (**1–2 consolidated runs per turn** checking active state + max-density `390×844` screenshot); run multi-seed solvability/balance sweeps in fast logic (`simulate` / Node).
  - **Lookup trigger:** Multi-layer board packing or constructive reverse-dealing for guaranteed solvable puzzles → [external lookup](game-lookup.md).

---

## realtime-2d

**Realtime 2D** — Use when continuous 2D position/velocity, timing windows, or 2D rigid-body/circle physics drive the core verb.

- **Target bar:**
  - Forgiving hitboxes: player hurtbox is 10–20% smaller than its visual sprite; pickups/attacks are honest or slightly generous; platformers include coyote time (~80–120 ms) and jump buffering (~100 ms).
  - Boundaries resolve smoothly (edge sliding or clean restitution) on fixed-step simulation in `logic.js`, independent of display refresh rate.
  - Foreground entities separate clearly from muted backgrounds via silhouette outlines and role-based contrast; danger states (low HP, near-full bin, telegraphed attacks) escalate visually and audibly before failure.
- **Hard fail:**
  - Frame-rate-dependent speed or tunneling through walls/floors on fast travel.
  - Unavoidable off-screen hits with zero telegraph, or hazards blending into background hue/value.
  - Stuck movement when keys release off-canvas, on window blur, or when switching keyboard and touch mid-run.
- **Playtest contract & lookup triggers:**
  - Verify `scriptedMovement` in `openmotion_game_playtest`, test opposing-key/blur release safety, and inspect 1280×720 and 390×844 screenshots for contrast and readability.
  - **Lookup trigger:** 2D circle-stacking/impulse resolution (e.g., merge physics), tuned platformer jump-arc gravity curves, or steering/Boids avoidance → [external lookup](game-lookup.md).

---

## realtime-3d

**Realtime 3D** — Use when players steer, aim, or navigate in a Three.js 3D scene (first-person, third-person, or chase-camera).

- **Target bar:**
  - **Wall & obstacle forgiveness:** Grazing walls/barriers projects velocity along the tangent, preserving ≥ 60% speed and gently pushing clear — never stopping dead on shallow contact.
  - **Camera comfort & speed cues:** Smooth damped camera follow with stable horizon (no unrequested roll or wall clipping). Racing/runners place rhythmic roadside landmarks, contrasting track edges, and subtle FOV/trail shift on boost so speed reads immediately.
  - **Aiming & steering feel:** Web FPS/TPS gives mild aim forgiveness (10–20% wider target hitbox or subtle reticle magnetism), visible hit confirmation within 50 ms (reticle flash + audio tick + enemy flash/knockback), and automatic recoil recovery. Vehicle drift separates enter, hold, and release recovery (auto-straighten within ~0.3 s + mini-boost).
  - **Scene budget, portrait framing & readability:** Distinct ground/track/wall/entity luminance roles, deliberate tone mapping/exposure (never muddy dark arenas or white-out bloom), and non-truncating safe-area HUD on both `1280×720` and `390×844` ([feel & craft](game-feel-craft.md)) within ≤ 100 draw calls, pixelRatio ≤ 1.5, and no heavy default shadows. **Responsive portrait camera (`aspect < 1`):** on startup and resize, adapt camera FOV, distance, or orthographic frustum for `390×844` portrait so the primary arena, focal objective, and hero/kart stay fully framed with side visibility — never cropping sides off-screen or trapping the playfield in dead black margins. Give transient center HUD callouts (countdowns, Boss alerts) a dark scrim or contrasting outline so they never blend into same-hue 3D signage behind them.
  - **Telegraphs & combat feel:** Top-down/arena 3D action uses animated telegraph effects (expanding ring/progress fill), bounded melee/aim magnetism, per-actor hit-stop (`45–110 ms`), and audio ducking so Boss warnings cut through combat noise.
- **Hard fail:**
  - Grazing a wall drops speed to 0 or traps the avatar/kart in geometry; releasing drift causes uncontrollable spin-out.
  - Firing directly at a visible enemy misses due to broken raycast/hitbox alignment, targets show zero hit reaction, or recoil leaves the camera permanently tilted.
  - Camera clips inside walls/floor, dark low-contrast scene hides the focal objective/heroes on mobile, featureless plane gives zero sense of speed, or HUD truncates/overlaps the center crosshair/road apex.
- **Playtest contract & lookup triggers:**
  - Run targeted `openmotion_game_playtest` scripts that explicitly exercise the core hazard — e.g., throttle + steer into a barrier (assert `speed > 0` and tangential advance) or aim/fire at a visible target (assert hit state transition). On closed racing circuits, stop the playtest script *before* looping back near start so `scriptedMovement` (start-to-end distance `> 0.5`) measures real progress honestly. Inspect screenshots for camera clipping, landmarks, and HUD clearance.
  - **Lookup trigger (mandatory before coding):** 3D capsule wall-slide collision, arcade kart steering/drift state machine, FPS pointer-lock/aim-assist/recoil damping, or non-trivial Three.js camera/shader math → [external lookup](game-lookup.md).
