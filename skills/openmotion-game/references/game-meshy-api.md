> See [source and execution notes](../PROVENANCE.md).

# Meshy API — verified animated-character pipeline (FALLBACK ONLY)

> **OpenMotion replacement:** no built-in image-to-3D, rigging or animation-preset provider is promised. Prefer `templates/game-kits/characters/`. The complete external-provider recipe below preserves input decisions, costs, numeric budgets and failure recovery as historical technical reference, not a current executable integration. An explicitly configured and authorized adapter must be discovered before any submission, with current cost and spending approval. Never request secrets in chat or game files. OpenMotion media discovery listed no 3D or rigging model at review; use this file only if a later catalogue returns one (see the discovery contract in `game-3d-animation.md`) or the user runs the external service themselves. The upstream Blender/Python merge helpers mentioned below are not shipped. OpenMotion has no equivalent shared credit balance or automatic raw-API fallback.

Verified end-to-end 2026-06-10 (image → 3D → rig → 4 clips → merged GLB).
Endpoint shapes re-checked against docs.meshy.ai 2026-06-11.

**Before building ANY request, read `game-meshy-input-rules.md`** (single-figure
rule, cropping, low-poly params). Skipping it wastes credits.

## Historical external-provider basics (not OpenMotion endpoints)

- Base URL: `https://api.meshy.ai`
- Auth (historical external-API note, not an OpenMotion setup step): external requests used `Authorization: Bearer <token>` from a user-managed environment variable outside chat; never ask for, print, or commit raw API keys.
- All generation endpoints are async: POST returns `{"result": "<task_id>"}`,
  then poll `GET <same path>/<task_id>` until `status` is `SUCCEEDED` /
  `FAILED` / `CANCELED`. Poll every 10–15 s. SSE `.../stream` exists but
  plain polling is simpler in a sandbox.
- Result URLs expire (`expires_at`, ~3 days) — **download assets immediately**
  after SUCCEEDED.
- Credits: `GET /openapi/v1/balance`. Failed tasks are refunded
  (`consumed_credits: 0` on FAILED).

## Pipeline overview (humanoid)

```
input image ──> [1] image-to-3d ──> [2] rigging ──> [3] animations (xN) ──> [4] merge clips
 (validated)      static GLB         rigged GLB        1 GLB per clip          1 multi-clip GLB
                                     + walk/run free                           (runtime, Three.js)
```

Cost observed: **~85 credits for a full character** (image-to-3d + rig +
2 library animations). Each extra library animation ≈ 5 credits.

## [1] Image → 3D

`POST /openapi/v1/image-to-3d`

```json
{
  "image_url": "<public URL or data URI>",
  "pose_mode": "t-pose",
  "should_remesh": true,
  "topology": "triangle",
  "target_polycount": 20000,
  "should_texture": true,
  "enable_pbr": false,
  "target_formats": ["glb"],
  "multi_view_thumbnails": true
}
```

- `pose_mode: "t-pose"` straightens the character regardless of the
  reference pose — fixes "awkward" references before auto-rig.
- `target_formats: ["glb"]` — don't generate fbx/obj/usdz you won't use;
  task finishes faster.
- `multi_view_thumbnails: true` — 4 cardinal-view PNGs for vision QC without
  downloading the GLB (~3 s extra latency).
- Low-poly rules and polycount budgets: see `game-meshy-input-rules.md`.
- Multi-image variant: `POST /openapi/v1/multi-image-to-3d` (1–4 views,
  same pose on every view — see input rules).

## text-to-3d note (two-phase) + stuck-refine recovery

`text-to-3d` is two tasks: **preview** (geometry, gray) then **refine**
(texture, created with `preview_task_id`). Verified failure mode: a refine
stuck at `IN_PROGRESS` `progress: 0` for 1.5 h — a queue jam on Meshy's side.

Recovery recipe:
- refine with `progress: 0` for longer than ~15 min ⇒ stuck forever.
- `DELETE /openapi/v1/text-to-3d/<id>` the stuck task, re-create with the
  **same** `preview_task_id` — re-ran in ~70 s. Credits for stuck/FAILED
  tasks are refunded.
- **Never block the pipeline on texture**: run rigging + animations on the
  preview (gray) mesh in parallel; swap in the textured mesh at the end with
  the same scripts.

## [2] Rigging

`POST /openapi/v1/rigging`

```json
{
  "input_task_id": "<image-to-3d task id>",   // OR "model_url": "<public GLB url>"
  "height_meters": 1.8
}
```

- Returns task id; on SUCCEEDED the result has `rigged_character_glb_url`,
  `rigged_character_fbx_url`, and **`basic_animations`** — walking + running
  GLB/FBX **for free**, no separate animation tasks needed for those two.
- **Humanoid only.** Docs: "not suitable for non-humanoid assets". A
  quadruped/creature returns `422 — Pose estimation failed`. Branch to
  Tripo3D or the procedural pipeline (`game-procedural-animation.md`).
  Nuance: Meshy's **web app** offers a 4-legs (quadruped) rig option, but the
  public **API** endpoint is humanoid-only — don't promise API quadruped
  support; suggest the web UI as a manual fallback for quadrupeds.
- Also rejected: untextured meshes, unclear limb structure, models
  **> 300,000 faces** (use `POST /openapi/v1/remesh` first).
- `height_meters` aids rig scaling — pass a sensible value (1.7–1.9 humans).

## [3] Animations (library retarget)

`POST /openapi/v1/animations`

```json
{
  "rig_task_id": "<rigging task id>",
  "action_id": 0
}
```

- Library: **~680 mocap presets** (locomotion, combat, deaths, dances,
  emotes). Catalog: `https://api.meshy.ai/web/public/animations/resources`
  (web endpoint, not under /openapi) and the Animation Library page in the
  docs. Used in the verified run: `idle = action_id 0`, `attack = action_id 4`.
  Don't trust ids from memory — fetch the catalog and match by name.
- All presets are **biped mocap** — they only fit humanoid rigs.
- Result: `animation_glb_url` — one GLB per clip, skinned, same skeleton as
  the rig task.
- Optional `post_process`: `change_fps` (24/25/30/60), `fbx2usdz`,
  `extract_armature`.

## [4] Combine clips at runtime

Meshy gives N single-clip GLBs (walk/run from the rig + one per animation
task) sharing one skeleton. No merge script ships with OpenMotion, and none
is needed: load the rigged GLB once, load each clip GLB, and collect their
`gltf.animations` into one list for the rigged scene's `AnimationMixer`
(tracks bind by bone name). Rename clips on load (`clip.name = 'Walk'`).

Note: `rigged.glb` may carry a service clip named like
`Armature|clip0|baselayer` (bind pose) — skip it.

**Root-scale pitfall (upstream observation):** library animations can bake a
scale factor into the root bone's scale track, so the character "grows" when
that clip plays. On load, find `*.scale` tracks on the root bone; if their
values differ from 1, replace them with 1 and divide that clip's root
position track by the same factor so feet stay grounded.

Check every file with `node scripts/game-glb-inspect.mjs` (skins ≥ 1,
expected clip names) and force opaque materials in code. Copy GLBs with
authorized local file access; `openmotion_game_write_files` rejects binary
extensions.
## Polling skeleton (bash)

```text
Historical external-provider protocol only; NOT an OpenMotion endpoint or executable integration.
No current 3D provider adapter is promised. Use characters/ in templates/game-kits instead.
TASK=$(curl -s -X POST https://api.meshy.ai/openapi/v1/image-to-3d \
  -H "Authorization: Bearer $MESHY_API_KEY" -H 'Content-Type: application/json' \
  -d @payload.json | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"])')
while :; do
  S=$(curl -s https://api.meshy.ai/openapi/v1/image-to-3d/$TASK \
    -H "Authorization: Bearer $MESHY_API_KEY")
  ST=$(echo "$S" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["status"],d["progress"])')
  echo "$ST"; case "$ST" in SUCCEEDED*|FAILED*|CANCELED*) break;; esac
  sleep 12
done

```

## Error cheat-sheet

| Code | Meaning | Action |
|---|---|---|
| 400 | bad params / unreachable image URL / >300k faces on rig | fix payload; remesh first |
| 402 | out of credits | tell user, show balance |
| 422 (rigging) | pose estimation failed — non-humanoid or unclear limbs | procedural branch / Tripo |
| 429 | rate limit | back off, retry |
| refine stuck progress 0 >15 min | Meshy queue jam | DELETE + recreate with same preview_task_id |
