> See [source and execution notes](../PROVENANCE.md).

# 2D Sprite Animation (video-to-spritesheet pipeline)

> **Asset reference for game-generation.** Use for animated 2D assets —
> characters, objects, effects — delivered as a spritesheet. The pipeline:
> key-pose image (discovered image model) → first-frame video (discovered
> video model) → frame extraction → frame selection → per-frame keying →
> spritesheet assembly. Every generation goes through `openmotion_assets_use`
> `action=generate` after `openmotion_media_use` discovery, a stated plan and
> spending approval, following the `openmotion-media` provider order. Style:
> the key-pose prompt embeds the STYLE FORMULA per `game-stylization.md`.

Why video instead of generating frames directly: an image model drawing N
frames independently cannot hold the character identical across frames —
limbs, proportions and details drift, and the animation "boils". A video
model animates ONE image, so every frame is the same character by
construction. We then sample the video back into frames. This trades prompt
control for temporal coherence — the right trade for game sprites.

## Choosing a route

| Situation | Route |
|---|---|
| Image and video models listed, approval given | Full pipeline below |
| Only an image model listed | Generate a few key poses (idle, action peak, hit) as separate edits of the same approved sprite with `references`, and animate between them in code (squash/stretch, bob, tween, flip). Fewer frames, no boiling. |
| No media model, or the user declines | Code-drawn sprites (Canvas/SVG paths with outlines and two-tone shading) plus procedural motion (`game-procedural-animation.md`) |

A dedicated sprite-sheet model is not listed at review. If a later catalogue
returns one, inspect its schema and use it through the same consent flow;
otherwise do not search for unlisted names.

---

## Pipeline at a glance

| # | Stage | Tool | Output |
|---|---|---|---|
| 1 | Source image | approved sprite from `game-stylization.md`, or a user asset | character or object image (library asset) |
| 2 | Key-pose image | discovered image model with `supportsImageReference:true` (prefer OpenDesign `tier:"fast"` / `multi-ref-edit` or `flagship` from live `tier`/`bestFor`) | full-body pose at the action's mid/peak phase |
| 3 | Animation video | discovered video model with `maxInputImages ≥ 1` (prefer OpenDesign `bestFor` matching `sprite-animation` / `short-i2v` from live discovery) | short clip from the key pose as first frame |
| 4 | Raw frames | browser extraction (or local ffmpeg when available) | frames as canvases/PNGs |
| 5 | Frame selection | game code | `frame_count` frames (2–64, default 25), evenly spaced, first + last kept |
| 6 | Alpha | chroma key in code, per frame | transparent frames |
| 7 | Spritesheet | game code (or local assembly) | grid canvas/PNG, metadata in the name |

Hard rules (each one is a known failure when violated):

- **The subject is NEVER cropped.** Full body in frame at every stage, with
  visible empty margin above the head and below the feet. A key pose, a video
  frame, or a sheet cell that clips the subject is a rejected asset —
  regenerate, do not "fix in post".
- **Use only discovered models**, and do not silently substitute another
  model after a failure; the approval names the model.
- **Loops close in selection, not in the prompt.** The listed video models
  accept one first frame only (last-frame input is rejected), so the clip
  cannot be forced back to its start pose. Close loops in Stage 5 by picking
  the cycle segment whose end frame best matches its start frame.
- **First and last frames of the chosen segment are always kept** in the
  selection. For loops the last frame is then dropped at sheet assembly.
- **Keying runs on FRAMES, one by one** — never on the video as a whole.

---

## Stage 1 — Source image

What goes in: the character/asset image from the manifest (generated per
`game-stylization.md`, FORMULA embedded) or supplied by the user and imported
as a library asset. If the source crops the subject (feet cut, head at the
edge), regenerate it full-body first. A cropped input guarantees a cropped
animation.

## Stage 2 — Key-pose generation

**What:** produce the subject in the *mid/peak phase* of the requested action.
The video model animates *around* the image it is given; starting from the
action's characteristic phase is what makes a short clip read as that
action.

- `idle` → slight lean / relaxed breathing stance
- `walk` / `run` → mid-stride, one leg forward
- `attack` → wind-up (weapon raised / fist drawn back)
- `jump` → crouched anticipation
- `cast` / `effect` → energy gathered at the hands / pre-release
- flames, water, props → the shape at its most typical, not its extreme

**How:** an image edit with the source as reference, the STYLE FORMULA
verbatim in the prompt, plus the pose instruction. The prompt MUST demand:

- *full body / full object in frame* — head to feet visible;
- *empty margin above and below the subject* — the motion needs headroom and
  footroom;
- a *clean, uniform, uncluttered key-color background* — it is keyed out
  per-frame later. **The key color must NOT appear anywhere on the subject**
  (green character → magenta, red/pink character → green, neutral subject →
  any saturated key per `game-stylization.md`). Video frames cannot carry
  alpha, so do not request a transparent background here even if the image
  model supports it.

```json
{"action":"generate","requestId":"hero-run-keypose-01","model":"<provider>:<discovered-image-edit-model>","modality":"image","prompt":"<STYLE FORMULA>. <single key-pose instruction>. Square centered composition, full body in frame with empty margin above the head and below the feet. Clean uniform bright magenta background.","references":[{"assetId":"<source asset>","versionId":"<source version>"}],"parameters":{}}
```

Pass only parameters declared in the chosen model's live `generationOptions` / provider reference (do not pass bare `aspect_ratio` or `output` unless the live entry accepts them, and pad/crop to a square cell in code if needed).

Gate: subject fully inside the frame with visible margin top and bottom,
nothing clipped, style matches the FORMULA. Cropped or off-style → reroll
within the approved budget (2 attempts, then best-of).

## Stage 3 — Video generation

| Param | Value |
|---|---|
| model | discovered first-frame video model (`maxInputImages ≥ 1`), selecting short/fast vs longer duration from live `tier`, `bestFor`, `description`, and the chosen provider reference |
| duration | shortest listed value that holds one full action (usually 4–5 s) |
| resolution | 720p |
| ratio | omit or `"adaptive"`: a first-frame video follows the key pose's ratio; a fixed ratio is incompatible with a first frame |
| first frame | the stage-2 key pose, as `references:[{assetId,versionId}]` |
| audio | `generate_audio:false` where listed |

```json
{"action":"generate","requestId":"hero-run-video-01","model":"<provider>:<discovered-i2v-model>","modality":"video","prompt":"<one action>. Camera locked, no camera movement, no zoom, subject stays fully in frame, plain static background. The character performs ONLY this action; nothing else happens. The subject keeps facing the same direction for the entire video.","references":[{"assetId":"<key pose asset>","versionId":"<key pose version>"}],"parameters":{"duration":5,"resolution":"720p","ratio":"adaptive"}}
```

**Prompt = ONE action + a mandatory negative block.** The positive part
describes the MOTION and nothing else — not the subject (the image already
is the subject), not the mood, not the scene: "smooth idle breathing cycle,
subtle weight shift", "full walk cycle in place, repeating", "single sword
slash, fast wind-up, sharp strike, follow-through". Exactly one action per
video; any second verb in the prompt is a defect. For loops ask for a
repeating cycle in place so Stage 5 has at least one full period to cut.

**The negative block is NOT optional and is appended to EVERY animation
prompt**, because the model fills the clip with improvisation wherever the
prompt leaves freedom:

1. *Camera lock (always):* `camera locked, no camera movement, no zoom,
   subject stays fully in frame, plain static background` — camera drift and
   zoom are the top causes of unusable frames.
2. *Prop & action inertia (always; expand when the subject holds anything):*
   `the character performs ONLY this action, nothing else happens`. If the
   subject carries a prop with an obvious action of its own (weapon, tool,
   instrument), name the prop and freeze it: `the <prop> stays inert and is
   never used — no firing, no muzzle flash, no swinging`. Shipped failure: a
   "run cycle in place" where the model fired the held pistol twice.
3. *Facing lock (always):* `the subject keeps facing the SAME direction for
   the entire video — never turns around, never rotates toward or away from
   the camera`. Game sprites face ONE direction (the engine mirrors them); a
   mid-video turn poisons every frame after it. The ONLY exception: the
   requested action IS a turn — then it is a one-shot.

Gate before moving on: inspect the video with `action:"read"` passing explicit `timestamps` (default `read` returns only the first frame; each call inspects up to 4 timestamps, e.g. start, mid, and end) — subject never
leaves the frame or gets clipped, no camera motion, facing never flips, and
(for loops) at least one full cycle is present. Fail → regenerate within
the approved budget, adjusting the motion prompt.

## Stage 4 — Frame extraction

Preferred, no external tools: extract in the browser from the library URL, **never blocking game startup indefinitely** and **never holding 5 s of full-res 720p frames in memory** (which consumes ~422 MiB of raw RGBA pixels). Always attach error and timeout exits, keep the approved static sprite ready as an immediate fallback, scan at low resolution first (e.g. `96×96`) to pick the loop segment if needed, and decode only the final selected `timestamps` at sprite size:

```js
async function extractSelectedFrames(url, timestamps, outW, outH, timeoutMs = 8000) {
  const v = Object.assign(document.createElement('video'), { src: url, muted: true, playsInline: true, crossOrigin: 'anonymous', preload: 'auto' });
  const wait = (ev) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`video ${ev} timeout`)); }, timeoutMs);
    const ok = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('video load failed')); };
    const cleanup = () => { clearTimeout(timer); v.removeEventListener(ev, ok); v.removeEventListener('error', fail); };
    v.addEventListener(ev, ok, { once: true }); v.addEventListener('error', fail, { once: true });
  });
  if (v.readyState < 1) await wait('loadedmetadata');
  const frames = [];
  for (const t of timestamps) {
    const target = Math.min(Math.max(0, t), Math.max(0, v.duration - 0.01));
    v.currentTime = target; await wait('seeked');
    const c = new OffscreenCanvas(outW, outH); c.getContext('2d').drawImage(v, 0, 0, outW, outH); frames.push(c);
  }
  return frames;
}
```

When a local `ffmpeg` is already available and binary writes are authorized,
`ffmpeg -i anim.mp4 -vsync 0 raw/%04d.png` extracts every frame offline instead.
If video loading or seeking fails in-browser, fall back immediately to the approved static sprite so the game never hangs at launch.

## Stage 5 — Frame selection (`frame_count`)

**What:** pick `frame_count` frames, evenly spaced across the chosen
segment, **always including its first and last** frame.

```js
const idx = [...new Set(Array.from({ length: frameCount }, (_, i) => Math.round(start + i * (end - start) / (frameCount - 1))))];
```

(Endpoints guarantee first + last; the `Set` guards tiny counts.)

**Range:** 2–64. **Default: 25** when nothing in the context says otherwise.

**Choosing by context** — the question is "how much does the silhouette
change per beat of this action":

| Action / context | frame_count |
|---|---|
| idle, breathing, hover, flame flicker | 8–16 |
| walk / run cycle — pixel art | 8–12 |
| walk / run cycle — HD sprites | 16–24 |
| attack, hit, jump, one-shot actions | 10–20 |
| fluid motion: cape, water, fire burst, magic FX (HD) | 24–48 |
| unclear / no signal | 25 |

**Why fewer is often better:** every frame is a sheet cell — memory, texture
size, and keying work all scale linearly with it. A walk cycle
reads perfectly at 8 frames (the entire 8/16-bit era proves it); 60 frames of
walk is waste. Spend frames only where the silhouette genuinely changes fast.

**Loop segment (loops only):** before even spacing, find a true cycle on
downscaled grayscale copies (e.g. `96×96`). First confirm the candidate window
contains a full motion cycle (meaningful mid-segment silhouette change above
a static-motion threshold, so you never select a nearly frozen slice); then
among valid end frames after at least half a second, pick the lowest-difference
start/end seam and sample `frameCount` timestamps evenly within that window.

## Stage 6 — Keying (per frame)

No background-removal model is listed at review, so key in code. For each
selected frame: read `getImageData`, set alpha to 0 where the pixel is
within a tolerance of the key color (distance in RGB or, better, in
chroma), soften a 1–2 px edge, and despill (pull the key hue out of edge
pixels). Clear enclosed key-colored regions too, not only those connected
to the corners.

Gate: spot-check 3–4 frames at 2× zoom — no leftover background patches, no
eaten thin parts (blades, hair, flame tips). A bad matte in the same spot
across frames means the stage-2 background was too busy or **shared a color
with the subject** → fix there (change the key color), not by hand-editing
mattes.

## Stage 7 — Spritesheet assembly

All transparent frames are composed into ONE grid (a canvas at runtime, or a PNG when assembled locally):

1. **Union bounding box.** Compute the bounding box of non-transparent pixels
   across ALL frames, take the union, crop every frame to that SAME box. This
   anchors the subject identically in every cell — per-frame cropping makes
   the sprite jitter in-game.
2. **Uniform cell.** Pad the union box to a uniform cell size; anchor
   bottom-center (feet stay planted on the ground line across frames).
3. **Loop de-duplication.** For looping animations drop the LAST frame from
   the sheet — it matches frame 1 (the loop segment closes on it), and playing both
   makes the loop stall for one beat at the wrap. One-shot animations keep
   every frame.
4. **Grid, not strip.** Lay frames into a near-square grid (24 frames →
   5×5 with the tail row partial). A horizontal strip of 64 cells exceeds
   GPU texture limits. **Total sheet dimension ≤ 4096 px on either side** —
   if it does not fit, downscale the cells, never drop frames.
5. **PNG with alpha**, no compression artifacts.

**Metadata lives in the filename** — no sidecar JSON. The consumer (stage-3
game code) parses everything it needs from the name (when the sheet is assembled at runtime, keep the same fields in a JS object):

```
{asset}_{action}_f{count}_{cellW}x{cellH}_g{cols}x{rows}_fps{n}_{loop|once}.png

knight_idle_f15_192x256_g4x4_fps12_loop.png
slime_attack_f12_160x160_g4x3_fps14_once.png
torch_flame_f10_96x192_g4x3_fps10_loop.png
```

`f` = frames actually in the sheet (after loop de-dup); `g` = grid; cells
fill left-to-right, top-to-bottom; trailing cells of the last row are empty
and transparent.

**Playback fps** is a recommendation baked into the name: pixel art 8–12,
HD sprites 12–24, **default 12**. Note fps is decoupled from `frame_count` —
15 frames at 12 fps is a 1.25 s loop; pick fps for the feel of the motion,
not to "use up" the frames.

---

## Pixel-art sprites — the quality envelope

Small pixel sprites pass through the same pipeline but only look good
**inside these limits** — choose parameters from them, not from the HD
defaults:

- The video is still generated at 720p from a full-size key pose; the
  pixel-art look is applied at the END — downscale the assembled cells with
  **nearest-neighbor** (no smoothing, no anti-aliasing) to the target size
  from the manifest (e.g. 32/48/64 px).
- **frame_count 8–16, no more.** At small sizes extra frames add shimmer,
  not smoothness — sub-pixel drift between video frames turns into visible
  pixel crawl.
- **Subtle, readable motions** survive the downscale (sway, bob, stride,
  blink). Fine detail motion (fingers, facial expression, thin particles)
  dies below ~64 px — do not request it.
- fps 8–12. Higher framerates at small sizes read as noise.

If the manifest asks for a pixel sprite whose action violates this envelope
(e.g. a 32 px character with a 48-frame cloth simulation), simplify the
action to fit the envelope — that is a planning fix, not a generation fix.

---

## Failure recovery

| Symptom | Cause | Fix |
|---|---|---|
| Subject clipped in the video | key pose lacked top/bottom margin, or camera drifted | back to stage 2: more margin; strengthen the camera lock |
| Loop visibly jumps at wrap | segment end does not match its start | re-run the loop-segment search; widen the candidate range or regenerate asking for a repeating cycle in place |
| Request rejected for ratio | fixed ratio sent with a first frame | omit `ratio` or use `"adaptive"` |
| Sprite jitters in-game | per-frame cropping instead of union bbox | reassemble the sheet with the union box |
| Flickering halo around edges | busy key-pose background, no despill | back to stage 2: flat uniform background; add despill |
| Holes in the subject / background patches stuck to it | key color also present on the subject | back to stage 2: pick a key color absent from the subject's palette |
| Subject turns around mid-video | facing lock missing, or the action invites turning | regenerate with the facing lock; rephrase the action to be direction-neutral |
| Pixel sprite shimmers | too many frames / smoothing on downscale | cut frame_count to 8–12; nearest-neighbor only |
| Loop stalls one beat at wrap | duplicated last frame left in the sheet | drop the final frame (loops only) |

Regeneration budget: 2 attempts per stage within the approved spend, then
take the best and compensate downstream.
