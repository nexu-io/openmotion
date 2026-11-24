> See [source and execution notes](../PROVENANCE.md).

## OpenMotion execution contract

This reference governs authored game assets, not Studio application styling. Use `openmotion_game_create`, `openmotion_game_get`, `openmotion_game_read_file`, `openmotion_game_write_files`, `openmotion_game_update_meta`, `openmotion_game_capture_cover`, `openmotion_game_playtest`, `openmotion_game_simulate`, `openmotion_game_validate`, `openmotion_game_set_status` and authorized **local** `openmotion_game_publish`. Paths below are game-relative. New games use the single-player workflow. The room protocol and co-op kit sections document existing projects.

**Media tools:** prefer Unified Capability Center meta-tools when exposed — `openmotion_capability_discover` (`list`, `describe`, `providers`, `models`), `openmotion_capability_run` (especially for dedicated capabilities reported with `status:"live"` and `available:true` such as `remove-background`, `relight`, `image-blend`, `camera-control`, `multi-shot`, `music`, and `speech`), `openmotion_job_manage` (`status`, `cancel`, `retry_save`, `resume`), and `openmotion_asset_manage` (`read`, `get`, `import`) — with `openmotion_media_use` (`inspect`, `models`, `reference`) and `openmotion_assets_use` (`generate`, `status`, `read`; plus `web_publish` for public sharing) remaining fully compatible. Defer provider ranking and spend approval to `openmotion-media` (`openmotion://workflow/media/start`) before any paid submission. Poll the original job; a queued job is not an asset; never auto-retry a paid request. When the host does not list these tools, use bundled or code-made assets and report the gap. Do not invent tool names or forward old CLI flags.

**Using generated media in a game:** embed each completed version's complete literal `/motion-api/assets/<assetId>/versions/<versionId>/media` URL directly in HTML, JS, CSS, Three.js loaders or a runtime manifest stored outside `design/` (never build the URL by runtime string concatenation, or `web_publish` cannot rewrite it). The game play page, playtest, cover capture and trailer recording load these URLs from the same local service, and `web_publish` bundles them and rewrites literal URLs to relative paths (verify media loading after publish). Do not try to place binaries through `openmotion_game_write_files`; it accepts text only. Record asset id, version id, model, license and approved cost in `design/assets.csv`.

**Capability boundary:** Always treat live discovery (`openmotion_capability_discover` / `openmotion_media_use`) as authoritative for available modalities, `tier`, `bestFor`, `description`, and `generationOptions` — never hardcode or assume specific model versions. When live discovery lists no dedicated SFX model, synthesize SFX with Web Audio; when no live `3d` / `3d-asset` mesh or rigging model is listed, use the bundled CC0 GLBs or procedural Three.js models (never pretend that image/video generation produces a rigged GLB). The shipped GLB inspector is `node scripts/game-glb-inspect.mjs <file.glb>` (meshes, skins, unique bones, clip names/durations, triangles); no Python or Blender helpers ship with this Skill, and none is required.
# Game flow — local projects and authoritative rooms

A game is a local HTML project. HTTP and MCP use the same game service and file tree. Creation scaffolds editable source; validation checks it; authorized local publication lists it in this workspace. Local publication is not internet hosting. A public share link is a separate, explicitly requested step: `openmotion_assets_use` `action:"web_publish"` (see [Online sharing](#online-sharing)).

## Create

```json
{"tool":"openmotion_game_create","arguments":{"prompt":"<brief summary>","genre":"shooter","style":"3d"}}
```

- Use the supported genres `shooter`, `platformer`, `story`, `casual`, `racing`, `horror` from `shared/game-contract.ts`. Genre is optional, defaults to casual. The original categories arcade, puzzle, RPG, strategy, simulation, adventure, action, fighting, survival, sports, card-board, education, endless-runner, MOBA, music-rhythm and sandbox-building are brief descriptions, not accepted enum values: choose the closest supported genre and preserve the specific idea in `prompt`.
- Leave `style` omitted or `null` whenever the user did not explicitly request one of the fixed `gameStyles` (`pixel`, `minimal`, `ascii`, `voxel`, `anime`, `3d`) — never default open visual briefs to `"pixel"` or `"minimal"`.
- Use the returned project id and playUrl. The single-player scaffold uses `templates/game-kits/arcade-2d/` as a **theme-neutral engineering chassis** — always replace its graybox palette, placeholder copy, and rules with the world and mechanics from `design/plan.md` and `design/style.md`. The standalone game runs its own game loop in the browser.

## Read the shipped contract

Read `AGENTS.md`, `shared/game-contract.ts`, this reference and the scaffold's actual inventory before writing. Project files live under workspace `games/<id>/`.

| File | Responsibility | Edit? |
|---|---|---|
| `logic.js` | Six deterministic named exports | Yes |
| `index.html`, `client.js`, `style.css` | Presentation and inputs | Yes |
| `vendor/`, `characters/`, `assets/` | Relative local assets and licenses | Preserve notices |
| repository `game-projects.ts` | HTTP routes, room sockets, simulation and fan-out | Product engineering only |
| `game.json` | Service-owned metadata | Never through source writes |

Required exports for `logic.js` when present are `meta`, `setup`, `validateAction`, `applyAction`, `isGameOver` and `viewFor`. Optional test exports are `referenceRoute(playerIndex)` and `summarize(state)`; they run inside the same bounded deterministic VM. `openmotion_game_validate` checks deterministic, synchronous JSON-compatible logic. Use `ctx.random()`, `ctx.now` and `ctx.tick` for seeded randomness and time, and keep the logic module self-contained. The validator dry-runs 50 ticks. Existing multiplayer projects receive a two-player smoke test.

- **validateAction is the defence:** clients are untrusted; turn, range, target and payload bounds belong there. Do not accept a client-computed position, hit or damage.
- **viewFor controls information:** send only the player's allowed information. A card game returns that player's hand and other players' card counts, never every hand.

## Tick and membership in existing multiplayer projects

The co-op kit sets `meta.serverTick:true`. The runtime then invokes `applyAction(state, null, {type:"tick"}, ctx)` once per server tick, before queued user inputs. It invokes `applyAction(state, null, {type:"membership",player,connected}, ctx)` when a running room admits/reclaims/disconnects a player. These are server events: `validateAction` must reject them from real player ids, and `applyAction` must independently guard them. Existing logic without the opt-in keeps its original semantics.

The kit advances at 20 Hz; clients send movement at 10 Hz, with an 8-tick expiry, normalized diagonals, ±13 arena and 5 units/s movement. All balance values live in the single `config` block at the top of `coop-3d/logic.js`. Enemy counts are `4 + wave*2`, health `2 + floor(wave/3)`, speed `1.1 + wave*0.12` units/s. Hunters chase the nearest living player within 9 units; siege enemies pressure the objective. Contact attacks every 18 ticks deal 12 player HP or 5 objective HP. Player/objective HP starts at 100. Nearby living teammates within 2.5 units revive a downed ally after 40 consecutive ticks to 60 HP; a solo downed player respawns after 100 ticks (5 seconds). Disconnected players neither fight nor revive. Join order assigns deterministic spawn slots.

Dash (`Space` or touch button) moves 4.5 units, grants 8 ticks of invulnerability and has an 80-tick cooldown. Nova (`E` or touch button) deals 3 damage within radius 4, with a 160-tick cooldown. Both use validated `{type:"skill",skill:"dash"|"nova"}` inputs; clients cannot bypass cooldowns or act while downed. Basic fire repeats every 6 ticks and requires fresh movement or explicit fire intent; continuously sending zero-motion/no-fire inputs must not defeat idle-loss acceptance. The first wave waits 40 ticks; cleared waves give a 12 HP heal and 3 objective repair, then an 80-tick breather/countdown. Five cleared waves win; zero objective HP loses. Restart still requires every connected player's vote. Transient event ids drive real Hit_A/Death_A transitions, flashes, particles, wave banners, objective shake and sound; presentation never supplies damage. The always-visible HUD includes invite, own HP and skill cooldowns. No Skeletons assets are bundled: enemies are original procedural low-poly meshes, not downloaded models.

## Design and verification artifacts

Write these game-relative files using `openmotion_game_write_files`. Revise starter drafts for the actual brief and current source. Validation lists missing files as advisory warnings. Inspect each artifact's contents before accepting it.

| File | Required content |
|---|---|
| `design/plan.md` | One-sentence experience formula; scope/input methods; metrics with numeric thresholds; **reference route must win, idle must lose**; wave/difficulty and comeback plan; remaining human/device acceptance |
| `design/assets.csv` | At least `asset,source,license,cost`; include actual local/bundled/generated status, asset purpose, confirmed license and approved spend or unknown cost |
| `design/verification.md` | Tested game revision/date; tool inputs/commands; threshold vs measured result; reference and idle outcomes/ticks; browser assertions/resources/screenshots; known gaps and unavailable checks |

Keep observed evidence separate from targets. A pending template verification row is not a passed test, and software-rendered FPS is not physical GPU performance. Optional `## Follow-up opportunities` bullets in the plan seed the three short `nextSteps` prompts returned by publish. Without that section, defaults use the plan title (or a generic game reference). Present these as user-sendable suggestions, not authorization to perform follow-up work.

## Deterministic rule simulation

Before publication, run both routes below, then inspect the terminal outcome and timeline rather than merely checking that the tool returned.

```json
{"tool":"openmotion_game_simulate","arguments":{"id":"<game-id>","players":1,"scripts":"reference","maxTicks":2500}}
```

```json
{"tool":"openmotion_game_simulate","arguments":{"id":"<game-id>","players":1,"scripts":"idle","maxTicks":2000}}
```

`players` is 1–4 within logic meta limits. `maxTicks` is 1–10000. `scripts` is `idle`, `reference`, or one route per player; each route may also select those built-ins. Idle sends no actions. Reference requires a game-provided exported `referenceRoute(playerIndex)` returning up to 1000 entries `{fromTick,toTick,action}`. Indices start at zero. Ticks start at one, are inclusive and bounded to 10000; active entries repeat their action each tick in list order. Match the room limit of at most 16 actions per player per tick; a run is bounded to 100,000 scripted input applications. Explicit routes use the same shape, for example `scripts:[[{"fromTick":1,"toTick":20,"action":{"type":"move","dx":1,"dz":0,"ax":0,"az":1,"fire":false,"aimed":false}}],"idle"]` for two players. Native game rules validate every action; no route gets server-only tick/membership privileges.

Simulation uses fixed player ids and a fixed seed, advances the same server tick first and then applies that tick's scripted inputs. It returns `result:{over,winners,tick}` and at most 100 ordered timeline snapshots `{tick,state}` including initial and final state. Optional exported `summarize(state)` supplies compact JSON key state; otherwise the first player's `viewFor` is used (32 KiB summary limit). `over:false` means the budget expired, not a passed idle-loss contrast. A valid idle loss must be terminal with no winners and the game's intended loss summary; reference must be terminal with the expected winners and preserved objective. Record both in verification.md. The shipped reference route uses ordinary movement, explicit auto-aim fire and timed nova inputs; it is an idealized regression route, not evidence of human difficulty or rendering.

## Room protocol and recovery

Use this section to inspect and troubleshoot existing multiplayer rooms.

Connect to `ws(s)://<same-host>/api/games/<id>/rooms/<room>` derived from the current play URL. Preserve either `/api/games/` or `/motion-api/games/` from `location.pathname`, using `location.href` to construct ws/wss URLs (an iframe may have an opaque origin). The server accepts loopback Host values, absent Origin, sandbox Origin `null`, and HTTP(S) loopback origins including a different Studio dev port. Foreign origins remain rejected. Game static responses allow `Access-Control-Allow-Origin: *` for read-only module/model loading in sandboxed previews; metadata/API responses do not gain this permission.

```json
{"type":"join","name":"Player","reconnectToken":"optional token from this tab"}
```

`joined` returns `playerId`, `room`, `players`, `maxPlayers` and an additional opaque **reconnectToken**. Store the token in `sessionStorage`, keyed by game path and room; do not put it into invite URLs. Send `{type:"start"}` when the room reaches minPlayers, then `{type:"input",action:...}`. Receive `state` (view and tick), `over` (winners), or `error` (message).

A disconnected player's identity/seat is reserved for **30 seconds**. A valid token reclaims the same id and its existing simulation state; an already connected token is rejected. Invalid/expired tokens produce an error: clear the stored token and join without it to receive a new identity. A running room permits late joins up to maxPlayers, counting reserved seats. Late membership does not reset the round. Token possession is the only recovery credential, not an account or authenticated identity; do not share it. Pending connections have a 10-second join deadline.

Rooms, tokens, votes and simulation state exist only in one local process. The room is discarded 30 seconds after the last joined client disconnects, even if idle connections remain. Simulation continues during this grace period, so the objective may take damage while everyone is disconnected. Process restart loses every room; there is no disk persistence, distributed room routing, public hosting, remote-device guarantee or account recovery. A copied localhost invite works in other tabs/browsers on this machine, not another person's machine.

## Validate, preview, publish locally

```text
openmotion_game_validate {id}
openmotion_game_set_status {id,status:"ready"}
openmotion_game_publish {id}  # only with local publication authorization
```

Use the returned playUrl. For local invitations to an existing multiplayer game, use its roomInviteUrlPattern. Before publication, call `openmotion_game_update_meta` to set a concise title, description, controls, `zh-CN` translations of all three fields, and a project-relative cover image. Use `openmotion_game_capture_cover` for the required gameplay cover; it writes `assets/cover.png` and updates cover automatically. Never capture or operate the user's desktop, visible Chrome, tabs or profile. Imported images must be at least 960×540 and 16:9 ±5%; the tool checks that the relative image exists, rejects traversal/symlinks and merges i18n locale fields. Publication returns non-blocking `warnings` if the title is still the original prompt (including the initial 80-character truncation) or no cover is set. Changing description does not erase the original-prompt warning. Read and report these warnings; metadata edits preserve lifecycle status. There is no requirement for upstream `app-meta.json`, OG URLs or a hosted community feed. Game source can be edited through `openmotion_game_write_files`; generated media stays in the asset library and is referenced by URL; other binaries (for example a supplied GLB) require authorized local file access. Keep all HTML/module/model paths relative so remix copies remain independent. Source edits demote a ready/published game to building; revalidate before republishing.

### Metadata example

After `openmotion_game_capture_cover` has saved the game-only cover, call:

```json
{
  "tool": "openmotion_game_update_meta",
  "arguments": {
    "id": "<game-id>",
    "title": "<Original Game Title>",
    "description": "<One-sentence gameplay summary.>",
    "controls": "WASD/arrows or touch joystick; mouse aim/fire; touch auto-fire.",
    "cover": "assets/cover.png",
    "i18n": {
      "zh-CN": {
        "title": "<原创游戏标题>",
        "description": "<一句话玩法简介。>",
        "controls": "WASD/方向键或触控摇杆移动；鼠标瞄准射击；触控自动射击。"
      }
    }
  }
}
```

Only owned project metadata is writable. The equivalent local HTTP operation is `POST /api/games/<id>/update-meta` (also `/motion-api/games/`), with the metadata patch as its body. Ordinary local API write-origin checks still apply; the sandbox CORS allowance is for static reads only.

## Server-owned cover capture and playtest

**Never operate or attach to the user's visible browser, desktop, tabs or existing profile, including for troubleshooting or screenshots. These two MCP tools are the required paths for gameplay covers and multi-client tests.** They use a fresh temporary Chrome profile on the server, headless mode, SwiftShader, 1280×720 viewport, isolated browser contexts and an ephemeral loopback server. No downloads or external game requests are allowed. Missing local Chrome/loopback permission is a blocker to report, not authorization to use the user's browser.

```json
{"tool":"openmotion_game_capture_cover","arguments":{"id":"<game-id>","delayMs":1500,"actions":[{"type":"key","key":"w","event":"down"},{"type":"wait","ms":300},{"type":"key","key":"w","event":"up"}]}}
```

Capture optionally accepts `room`. It crops only the canvas (or #game root), never browser chrome or a full desktop. It saves a 1280×720 PNG at `assets/cover.png` and sets game metadata. Check the returned diagnostics and image: a loading error/blank canvas is not an accepted cover. `update_meta` rejects images below 960×540 or outside 16:9 ±5%. Supported dimension inspection: PNG, JPEG, WebP, GIF and SVG; unsupported formats must be converted with available local tooling or replaced by the capture PNG.

```json
{"tool":"openmotion_game_playtest","arguments":{"id":"<game-id>","clients":1,"durationMs":3000,"scripts":[[{"type":"key","key":"w","event":"down"},{"type":"wait","ms":300},{"type":"key","key":"w","event":"up"},{"type":"key","key":"Space"}]]}}
```

Each run has its own temporary room server and simulation; the optional room name does not attach to a live user room or preserve a previous run. Clients share a generated room (or optional supplied room), auto-join when the game supports a room URL and click conventional enabled #start after all pages load. The script API supports only key `down/up/press`, mouse `move/down/up/click` (1280×720 coordinates or a simple #id click target), and bounded waits. There is no arbitrary JavaScript or desktop operation. Multiplayer joining must never require explicit click actions; custom click actions may start play only after the no-input autoJoin check. Each client has at most 100 actions, each wait ≤10s and total waits ≤60s. `durationMs` (0–60s) is a minimum observation interval; scripts run concurrently and may extend it. Cover delay is 0–10s. Scripts never synthesize server hits, HP or room identity.

The client convention is `window.__omGame = {getState,getStats,sendAction}`. `getState()` returns a cloned latest server view plus `selfId`; `players` maps ids to authoritative x/z/connected fields, and `phase`/`result` identifies lifecycle. `getStats()` exposes render FPS, drawCalls, entities and tick; `sendAction(action)` sends a normal validated room input and never edits state. `?debug` shows those metrics without changing gameplay. Custom games should adopt this convention.

Playtest reads before/after snapshots and returns four gameplay assertions plus a multiplayer autoJoin assertion per client: playerCount, phase, scriptedMovement and mobileHorizontalOverflow. Defaults require the requested connected player count, an active/terminal game phase, net movement >0.5 world units from a directional key script (note: the built-in `scriptedMovement` assertion recognizes WASD and arrow keys; mouse clicks or custom bindings still exercise gameplay but will not satisfy that directional assertion on their own), and no horizontal overflow at a measured 390×844 viewport. Options `movementThreshold` (0–100) and `expectedPhase` select planned thresholds. Missing hooks/selfId/coordinates or an absent directional script fail the relevant assertions, not silently pass. For a game with no moving player (tap puzzles, pull-the-pin, most playable ads) pass `movementThreshold: 0`: `scriptedMovement` is then reported as `skipped` with `expected: "movement not asserted (threshold 0)"`, and it still fails when the authoritative state or `selfId` is missing. **Always pass explicit `scripts`** built from this game's real bindings. Omitted scripts fall back to `D` down / 350 ms wait / `D` up on every client (a move-right smoke check that fails movement for games not bound to `D`); explicitly provided empty scripts remain empty. Do not send a return-to-origin route when asserting net displacement. The runner restores capture sizing before the mobile layout measurement.

Returns per-client authoritative state/stats, assertion results, console/page/script errors, failed/HTTP-error requests, canvas/root screenshot paths under `assets/playtests/`, and metrics: roomJoined, playerCount, frames and fpsEstimate. FPS estimates requestAnimationFrame pacing, not GPU rendering speed. The harness keeps client documents logically visible for concurrent rendering; background suspension requires separate verification. Review all clients: joined=true, expected player counts, meaningful movement/skills, and no unexplained resource/console errors. Screenshots are local files; publication remains separate. Capture/update-meta/playtest use the same game service; their local HTTP forms are POST `/api/games/<id>/capture-cover`, `/update-meta`, `/playtest`, `/simulate` (also under `/motion-api/games/`). Ordinary local API write-origin checks remain in force.

Run `node --experimental-strip-types --test tests/game-projects.test.ts` for deterministic rules and protocol tests. For existing multiplayer projects, test damage, down/revive, solo respawn, dash/nova cooldowns, late join/reconnect and restart as separate rule cases. Validator warnings identify a missing cover or fewer than 20 approximate changed starter logic lines (whitespace and line reordering ignored); they do not fail validation, prove originality or justify filler edits. Touch joystick/tap, release/cancel, focus loss and narrow-layout acceptance remain required; the key/mouse headless script does not establish physical touch-device or audio acceptance. Report unavailable Chrome, actual GPU/phone performance, audible playback and human fun separately.

## Art and audio

Read `game-design-system.md` first (profile, core loop and manifest), then `game-stylization.md` (byte-identical STYLE FORMULA). Preserve `design/assets.csv` with the game.

| Asset | Reference |
|---|---|
| Sprites, backgrounds, UI | `game-stylization.md` |
| Spritesheets / 2D animation | `game-2d-animation.md` |
| Tiles, walls, ground, PBR maps | `game-textures.md` |
| Any 3D model / animation | `game-3d-animation.md` |
| Non-humanoid procedural rigs | `game-procedural-animation.md` |
| Music, SFX, voice | `game-audio.md` |
| Historical external 3D provider recipe (not a built-in adapter; not exposed as an MCP section) | `game-meshy-api.md` |
| Image-to-3D input, pose and polygon budgets (only if a 3D model is discovered) | `game-meshy-input-rules.md` |

MCP-only hosts read these as `openmotion://workflow/game/<section>`: `style`, `sprites`, `textures`, `animation`, `procedural`, `audio`, `design`, `genres`, `review`. Upstream rig/texture helper scripts are not included and not needed: textures post-process in game code, 3D uses the bundled kit or procedural Three.js, and the shipped GLB inspector covers file checks.

## Single-player

Run single-player games in the browser without a room. Set the logic player limits to `{minPlayers:1,maxPlayers:1}` where the game defines its own `logic.js`.

## Fixed performance budget for the co-op starter

Target 60 fps desktop (16.7 ms) and at least 30 fps on the weakest declared mobile target (33.3 ms); measure in an actual WebGL browser before claiming these targets. Bound visible enemies to 64 and beam instances to 32, use one instanced draw per swarm, at most four animated characters, pixel ratio capped at 1.5, no realtime shadows or postprocessing. Keep the scene under 100 draw calls and 100,000 rendered triangles; verify renderer.info rather than inferring frame time from those counts. Merge static compatible geometry once, skip background rendering, reuse meshes/materials, dispose detached resources. These are kit acceptance targets, not inherited upstream measurements. The upstream numeric-default `build-game.md` was not present in the supplied offline references; do not claim its unpublished defaults were recovered.

## Online sharing

`openmotion_game_publish` lists a game in this workspace's local market only. When the user explicitly asks for a public link and the OpenDesign account is signed in, publish the current game source to an Open Design Cloud share link:

```json
{"tool":"openmotion_assets_use","arguments":{"action":"web_publish","webPublish":{"command":"publish","targetKind":"game","targetId":"<game-id>"}}}
```

Use `command:"status"` to check the link and content freshness, `"unpublish"` to stop sharing and `"list"` to see all publications. `web_publish` uploads a **static file snapshot** (excluding `game.json`, `trailer/`, `design/` and `assets/playtests/`), bundles referenced library media and rewrites complete literal `/motion-api/assets/...` URLs found in supported text files to relative paths (keep any runtime asset manifest outside `design/` and verify media loading after publish). PNG/JPEG library assets at or above 256 KiB are re-encoded to WebP as `_shared-assets/<assetId>-<versionId>.webp` when a local encoder is available (lossless WebP for PNGs to preserve exact RGBA pixels/alpha, quality 82 for JPEGs), and original bytes are kept otherwise. Standard co-op clients connect to `/rooms/` WebSockets on the local process: for multiplayer games, explain before publishing that the public link is a static share snapshot without hosted rooms, deliver the local room link for local multiplayer, and never promise remote room play unless an actual hosted room service is verified. Validate and set ready before publishing, and republish after source edits.
## Gameplay trailer jobs

After local publication, offer the optional `openmotion_game_trailer` operation (`id`, `action:"start"|"status"`). HTTP adapters are POST/GET `/api/games/<id>/trailer`, also through `/motion-api/games/`. Only ready/published local games qualify, including read-only bundled templates. POST returns the background job; GET and catalog cards expose its latest `GameTrailer`. Repeated starts while active return the same job; starting after ready/failed makes a fresh recording.

States are `recording → composing → rendering → ready`, or `failed` with a readable stage error. State lives in `trailer/job.json` inside an owned game. Template output lives in the workspace's `game-trailers/<id>/trailer/` overlay, never the installed template. On service restart, an interrupted job becomes failed; it is not silently resumed. Clips remain under `trailer/clips/`; successful MP4 is served at `/api/games/<id>/play/trailer/trailer.mp4`. Private job metadata is not served. This is a local background process, not a durable hosted queue.

Recording uses isolated headless Chrome, 1280×720, three five-second moments separated by short play intervals, with start-button/hook conventions and generic WASD/Space/`e`/mouse inputs. Canvas/page screencast uses local ffmpeg, with real frame capture as fallback. No desktop attachment or synthetic gameplay footage. Existing Chrome, ffmpeg and pinned native export components are prerequisites; missing components fail without installation/download.

Composition creates a standard native project through `openmotion_create_project`, imports local clips and the game's cover (or a gameplay poster when absent), and writes editable HyperFrames HTML plus deterministic `trailer.json`. Prefer zh-CN title/description/controls. Three highlights make 19 seconds (two supported highlights make 15.5 seconds); include title, brief captions and Play now with controls. Export uses the existing frozen-project/export verification pipeline. Report projectId, status and videoUrl; silent captures do not establish audible quality, human fun, physical-device performance or successful export until ready. Failures retain partial media and project identity.

## Multiplayer entry checks

Apply the [automatic-join acceptance checklist](../SKILL.md#mandatory-multiplayer-entry-acceptance).
