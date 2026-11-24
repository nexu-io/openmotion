> See [source and execution notes](../PROVENANCE.md).

# Animated 3D Characters and Scenes (Three.js + GLB)

> **Asset reference for game-generation.** Use for every 3D asset — choosing,
> loading, animating and styling GLB characters and props in Three.js, and
> building the scene around them. Style: concept, texture and skybox images
> follow `game-stylization.md` §8 and its formula.

## Capability boundary & reserved 3D gateway slot (state it honestly)

OpenMotion media discovery listed **no 3D generation, image-to-3D, rigging
or animation-preset model** at review; the OpenDesign catalogue currently
covers image, video, speech and music. **Reserved 3D gateway slot:** always
check live `openmotion_media_use` discovery first — once 3D mesh or
auto-rigging models appear in the signed-in OpenDesign API or configured
providers, plan them in `design/assets.csv`, obtain spend approval, generate
via `openmotion_assets_use`, inspect returned `.glb` binaries with
`node scripts/game-glb-inspect.mjs <file.glb>`, and wire them directly.
While no 3D model is live yet, record the reserved slot cleanly in
`design/assets.csv` and use the available paths below. Image or video
generation never produces a rigged GLB, and no local Blender or Python
helper ships with this Skill. The shipped inspector reports meshes, skins,
unique bones, clip names/durations and triangles; it does not check
root-scale channels or merge rigs.

What is available and should be used well:

- the bundled CC0 KayKit characters in `templates/game-kits/characters/`
  (Mage, Knight; 12 clips each), copied into 3D drafts as `characters/`;
- vendored Three.js with `GLTFLoader`, `SkeletonUtils` and
  `BufferGeometryUtils` in `vendor/`;
- carefully modelled procedural Three.js geometry for props, vehicles,
  environments and non-humanoid creatures (`game-procedural-animation.md`);
- generated **2D** assets for the 3D scene: PBR textures
  (`game-textures.md`), skyboxes/backdrops and billboard sprites from the
  discovered image models, plus music and voice from `game-audio.md`.

## Decision table

| Need | Path |
|---|---|
| Humanoid hero or player characters | Bundled Mage/Knight GLB (exact path below); retint materials and add procedural accessories (hats, capes, weapons as child meshes on bones) to fit the brief |
| Vehicles, ships, turrets, buildings, props | Procedural Three.js modelling: merged primitives, `LatheGeometry`, `ExtrudeGeometry`, bevelled shapes, PBR materials with generated textures |
| Non-humanoid creatures (dragon, quadruped, snake, slime) | Procedural hierarchy of meshes animated in code (`game-procedural-animation.md`) |
| A user-supplied GLB/FBX, or one from a CC0 pack | Copy with authorized local file access, inspect with `game-glb-inspect.mjs`, keep its license file |
| Custom-look rigged humanoid from a user-run tool (e.g. Mixamo, which has no API) | One manual step the user performs; they hand over the file, then treat it as user-supplied |
| Photoreal characters or a large open world | Not achievable honestly now; offer the stylized version at the style gate |

## 3D quality without mesh generation

Primitive-looking scenes come from flat lighting and default materials, not
only from geometry. Within the performance budget in `game-flow.md`:

- **Materials:** `MeshStandardMaterial`/`MeshPhysicalMaterial` with roughness
  and metalness set per surface; generated base-color + derived normal and
  roughness maps on ground, walls and track surfaces; vertex colors or
  gradient maps for low-poly props.
- **Environment:** a generated equirectangular sky image (16:9 or 2:1 from an
  image model) as `scene.background` and, through `PMREMGenerator`, as
  `scene.environment`; otherwise a `RoomEnvironment` or gradient sky.
- **Light and grade:** one key directional light whose color comes from
  formula block 4, a hemisphere fill, `ACESFilmicToneMapping`, sRGB output,
  fog matched to the sky. Add bloom or vignette only when the frame budget
  allows on the weakest target.
- **Silhouettes & combat readability:** bevelled edges, extruded profiles instead of raw
  boxes, a rim or outline pass for readability, contact shadows (a blurred
  decal under characters) instead of realtime shadow maps. In top-down or
  isometric 3D action/defense games, keep camera distance tight enough that
  players, enemies and projectiles are immediately unmistakable in playtest
  screenshots: size every enemy silhouette generously relative to the player
  (never tiny sub-pixel specks; fast/runner enemies should stay ≥ 0.85× standard
  enemy scale and ≥ ~60% of hero height) and give enemies high-contrast
  emissive accents, bright eyes/cores or ground target rings so they never
  vanish into dark arenas or nebula skyboxes.

## Discovery contract for future 3D models

Current MCP media tools accept only `image`, `video` and `audio` modalities; a future 3D pipeline requires both live model discovery AND tool/delivery support for 3D output in the connected host. Before any 3D generation claim, run `openmotion_media_use action=models
refresh=true` without a modality filter and verify both the model entry and the host's `openmotion_assets_use` schema support 3D submission. Only when both are present:

1. read `action:"reference"` for its provider and the entry's
   `generationOptions`;
2. prepare inputs by `game-meshy-input-rules.md` (one figure, flat white
   background, pose and polycount budgets);
3. state model, count and cost, obtain approval, submit through
   `openmotion_assets_use action=generate`, and poll the original job;
4. inspect the returned GLB with `game-glb-inspect.mjs` (skins ≥ 1 for
   rigged output, expected clips) before wiring it in, and keep the bundled
   characters as the fallback.

Until then, `game-meshy-api.md` is historical reference for an external
provider, not an executable OpenMotion route. Never ask for or store a raw
provider key in chat or game files.
## Material pitfall — alphaMode: BLEND masquerading as inverted normals

Converted or third-party GLBs often carry glTF `alphaMode: BLEND`. In Three.js BLEND renders without
depth-write and sorts by object centers, so back faces (face, helmet
interior) draw ON TOP of front faces — visually identical to inverted
normals, but geometry is fine. Telltale difference: with BLEND you see
correctly-lit "innards"; with truly inverted normals the model is dark/black.

Material fixes for any supplied GLB:

1. In code, force opaque where the asset is not meant to be transparent:
   `material.transparent = false; material.depthWrite = true;` and
   `material.side = THREE.DoubleSide` for thin cloth or capes.
2. Check the inspector output and the in-browser look together; with BLEND
   you see correctly lit "innards", with truly inverted normals the model is
   dark.
3. **Cache trap**: after replacing a GLB, rename it (`knight_v2.glb`) rather
   than relying on a hard refresh.

## Headless-browser checks

Server playtests and cover capture run headless Chrome with SwiftShader, so
WebGL works but is slow; fps there is not GPU performance. A blank canvas in
a capture is a real failure to diagnose (console errors, failed GLB or
texture requests in the playtest report), not a renderer quirk to ignore.
Verify loading through `window.__omGame.getStats()` and the failed-request
list, and still report real-device visuals as unverified.
## CC0 asset sources (no attribution, commercial OK)

- **KayKit Adventurers** — `git clone --depth 1 https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0.git`
  → `addons/kaykit_character_pack_adventures/Characters/gltf/*.glb` already
  contain all 76 clips (Knight, Mage, Rogue, Barbarian + Rogue_Hooded); the
  `Characters/fbx/` versions are the conversion test bed. Clips include Idle,
  Walking_A/B/C, Running_A/B, Jump_*, 1H/2H_Melee_Attack_*, Spellcast_*,
  Block*, Death_A/B, Dodge_*, Hit_*, Sit_*, Cheer, Interact, PickUp, Throw.
- **Quaternius** (quaternius.com) — low-poly animated characters, CC0.
- **Kenney** (kenney.nl/assets) — game kits, CC0.

## Delivery pitfalls

- `openmotion_game_write_files` accepts text only and rejects binary
  extensions such as `.glb`. Copy GLBs with authorized local file access;
  never encode them as text or base64. Bundled drafts already contain
  `characters/` and `vendor/`.
- Consume via `GLTFLoader` + `AnimationMixer`;
  `mixer.clipAction(THREE.AnimationClip.findByName(gltf.animations, 'Idle'))`.
- Cross-fade clips: `next.reset().fadeIn(0.25).play(); prev.fadeOut(0.25)`.
- Generated textures and sky images load straight from their
  `/motion-api/assets/<assetId>/versions/<versionId>/media` URLs with
  `THREE.TextureLoader`; set `colorSpace = THREE.SRGBColorSpace` on color
  maps only.
## Exact offline character-kit path

1. Pick `templates/game-kits/characters/Mage.glb` (caster) or `Knight.glb` (melee); keep `LICENSE-KayKit.txt`. Both keep 12 common clips (Idle, Walking_A, Running_A, Jump_Full_Short, Dodge_Forward, Spellcast_Shoot, 1H_Melee_Attack_Chop, 1H_Ranged_Shoot, Block, Hit_A, Death_A, Cheer) and 41 bones, trimmed from the 76-clip originals to stay under 1 MiB. See the character README for measured durations; fetch the full KayKit pack for other clips.
2. Run `node scripts/game-glb-inspect.mjs templates/game-kits/characters/Mage.glb` (or Knight) before choosing clip names. Check skins ≥1, bone count, triangle count, and nonzero moving clips. Poses have duration zero. The inspector does not merge clips or validate root scale.
3. Copy the selected GLB and local `vendor/` into the game. Import `./vendor/three.module.min.js`, `./vendor/GLTFLoader.js`, `./vendor/SkeletonUtils.js`. Load `./characters/Mage.glb`; use `SkeletonUtils.clone(gltf.scene)` per player, never Object3D.clone for independent skinned rigs.
4. Explicit clip map: idle → `Idle`, run → `Running_A`, attack → `Spellcast_Shoot` (Mage) or `1H_Melee_Attack_Chop` (Knight), hit → `Hit_A`, death → `Death_A`. Resolve with `THREE.AnimationClip.findByName`; report missing clips instead of silently assuming them. The starter switches idle/run/attack, plays Hit_A for authoritative hurt events and Death_A while downed, then returns to idle/run after a server revive.
5. Create one `THREE.AnimationMixer` per clone. On a state transition call `next.reset().fadeIn(0.25).play(); previous?.fadeOut(0.25)`; update each visible mixer's delta every render. For one-shot death/hit set `LoopOnce`, `clampWhenFinished=true`, and transition deliberately; do not reset the same clip every frame.
6. Measure a Box3 before scaling: set the current starter character height to 2.4 world units (the previous 1.8-unit skeleton was smaller), offset by `-box.min.y * scale` so feet sit on the ground. In the supplied kit +Y is up and +Z is forward; face `Math.atan2(aimX, aimZ)` and confirm the facing visually. Keep root scale stable across clips; test feet and material opacity in the browser.
7. Merge static geometry with the local `BufferGeometryUtils.mergeGeometries` once after applying transforms. Share materials. Never merge skinned bodies into a static mesh. Instance enemy swarms/projectile beams; do not create one draw-call mesh per enemy.
8. Enforce the fixed starter performance budget in `game-flow.md`: 20 Hz simulation/10 Hz inputs, 4 animated players, ≤64 enemies, ≤32 beams, ≤100 draws, ≤100k rendered triangles, DPR≤1.5, 60 fps desktop/30 fps weakest target. Mage is 5,683 mesh-definition triangles; Knight is 6,952. Verify renderer.info and measured frame times; counts alone do not establish fps.
9. Stop hidden/background rendering and audio; free obsolete mixers, geometry/materials/textures on scene teardown (shared resources only once). Test actual keyboard/mouse and touch play, load/error recovery, clip crossfades and two local clients. Human visual acceptance remains separate.
