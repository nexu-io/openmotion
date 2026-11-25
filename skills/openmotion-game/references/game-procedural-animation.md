> See [source and execution notes](../PROVENANCE.md).

# Procedural animation — non-humanoid branch (Three.js)

Use this for creatures and machines the bundled humanoid characters cannot
cover: dragons, quadrupeds, snakes, spiders, fish, slimes, drones, mechs.
No 3D generation or rigging model is listed at review and no Blender helper
ships with this Skill, so build the creature as a **hierarchy of meshes in
Three.js and animate it in code**. This is deterministic, needs no external
tools and runs inside the performance budget.

## Build the rig in code

```
root (Group)          ← world position, facing, bob
 └ body  → chest → neck → head
 └ tail_0 → tail_1 → tail_2 → tail_3
 └ wing_L_inner → wing_L_outer   (and R)
 └ leg_LF_upper → leg_LF_lower   (×4)
```

- Each segment is a `Group` pivoted at its joint, holding one mesh (capsule,
  lathe, extruded silhouette or tapered cylinder) offset so it rotates about
  the joint, not its center.
- Proportions are fractions of one body length so the same code scales to any
  size; keep them in a config object next to the motion constants.
- Share geometry and materials across instances; for swarms, animate an
  `InstancedMesh` per segment type and write matrices per instance.
- Optional skinning: for a smooth serpent or tail, build a `SkinnedMesh`
  from a `TubeGeometry` and a bone chain, weighting each vertex to its two
  nearest bones by distance along the spine. Count weighted vertices > 0
  before relying on it.

## Motion recipes per creature type

All motion is a sum of sinusoids evaluated per frame.
Core idiom: `angle(t) = A * sin(2π * t/T + φ)` per bone, with phase offsets φ
creating wave propagation and gait patterns.

| Creature | Skeleton | Locomotion formula |
|---|---|---|
| Winged (dragon, bird) | spine chain + 2-segment wings + tail | fly: wings ±35–45°, outer segment lags inner by 0.15–0.25 of the cycle (flex illusion); body bobs in COUNTER-phase to the downstroke; legs tucked (constant); tail wave |
| Quadruped (wolf, dog) | spine + neck/head + 4 legs (2 segments) + tail | walk: diagonal pairs in counter-phase — LF+RH at φ=0, RF+LH at φ=π; spine sways laterally at half amplitude; head bob small |
| Hexapod (insect) | thorax + 6 legs | alternating tripod: legs {L1,R2,L3} φ=0, {R1,L2,R3} φ=π |
| Octopod (spider) | cephalothorax + 8 legs | two tetrapod groups in counter-phase; adjacent legs offset by π/4 for ripple |
| Serpentine (snake) | 8–12 segment spine chain | traveling wave: segment i gets φ = i * 2π/N, lateral rotation ±20–30°; amplitude grows toward tail |
| Aquatic (fish) | spine chain + fins | same traveling wave but amplitude concentrated in rear third; fins counter-flap at 2× frequency, small amplitude |
| Slime / blob (no skeleton) | none — or 1 root bone | squash & stretch on scale: `sz = 1 + A*sin(ωt)`, `sx = sy = 1/sqrt(sz)` (volume preservation); add small location bounce synced to squash |

Idle for any creature: breathing (chest scale or rotation ±2–4°, 4 s cycle),
slow head sway, tail/appendage micro-wave, wing micro-adjust.

Implementation: `angle(t) = A * Math.sin(2 * Math.PI * t / T + phi)` evaluated in
the render loop from game time (not wall-clock, so pauses and slow-motion
work), applied to `rotation` of each segment group. Blend gait amplitude by
speed (idle → walk → run) instead of switching clips abruptly. For slime-class
creatures skip the hierarchy and animate `mesh.scale`/`position` directly.
Keep gameplay state in `logic.js`; animation is presentation only and never
decides hits or positions.

## Visual QC (headless)

1. Add a debug key (active only under `?debug` or a dev constant) that
   freezes the creature and steps it to the next sample phase. Drive it with
   `openmotion_game_playtest` key scripts, review the returned screenshots at
   several phases (one short run per phase when the report holds one
   screenshot per client), and inspect them. Remove or disable the key before cover
   capture.
2. Check that phases differ, the motion logic is right (wing area shrinks on
   the upstroke and opens on the downstroke; diagonal legs move together), and
   joints do not separate visibly.
3. **Phase-sampling pitfall:** sampling at uniform steps that alias with the
   cycle period makes every capture look identical. Sample at non-uniform
   fractions, e.g. 0.0, 0.23, 0.41, 0.68, 0.87 of the period.
4. Acceptable defects: slight gaps at segment joints (hide them with joint
   spheres or overlapping caps), no per-toe detail.

## Supplied or future rigged models

If the user supplies a rigged non-humanoid GLB, or a later media catalogue
lists a rigging model (see the discovery contract in
`game-3d-animation.md`), consume it exactly like a humanoid GLB:
`GLTFLoader` + `AnimationMixer`, clips by name, inspected first with
`node scripts/game-glb-inspect.mjs`. Keep the procedural version as the
fallback until the supplied model passes inspection and an in-game check.
