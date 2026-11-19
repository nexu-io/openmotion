---
name: openmotion-neon-script
description: >-
  OpenMotion — Write thick glowing neon tubes onto real footage, stroke by stroke behind a bright pen tip,
  relight the whole shot as each tube switches on, and tuck tubes behind a cut-out person. Use when someone wants a neon sign written over their clip,
  "light writing" or "neon handwriting" on a video, a glowing word over a room, street or product shot,
  or a light-painting effect on footage. Produces an editable HyperFrames project and MP4 (3-30 s, 16:9,
  9:16 or 1:1) generated from one neon.json file.
---

# OpenMotion · Neon Script

An OpenMotion Skill. Every film it makes signs off with a small "Made with OpenMotion" wordmark in the last two seconds; set `"brand": false` only when the user asks to remove it. The user's footage, logo and words are never altered beyond the grade and the light.

Give it a clip and a few words, get them written in neon light inside the shot: one thick glass tube per stroke with a white-hot core, a bright tip leading the writing, the room and the person lit in the tube's colour, and — with a cut-out of the subject — tubes that pass behind them. Deliverables:

1. **`neon.json`** — the footage (plus an optional subject cut-out), the words or shapes, their colours, layer and when each one starts.
2. **An editable HyperFrames project** generated from that file, and its **MP4**.

The look depends on three choices, so spend the effort there: **where** the tube sits (on an empty wall, sky, floor or tabletop — never across a face), **how dark** the shot is graded (neon only reads when the background is a few stops below the tube), and **one colour per piece** that contrasts with the scene.

## The film comes from the generator, never by hand

`scripts/build.mjs` owns the tube geometry, the stroke order, the glow, the relight and the flicker. Do not hand-write SVG, restyle the layers or write another generator; change `neon.json` instead.

- Get the script and `assets/` before starting. Through the OpenMotion MCP, `openmotion_get_template` with this Skill's ID returns `localSource` (use `scripts/` there) or `objects` URLs (download `scripts/build.mjs`, `assets/fonts/allure-strokes.json` and `assets/brand/openmotion-logo.svg`, and check each SHA-256).
- Generic instructions such as "author a native HTML/CSS/JS composition" mean: run this generator and save its files.
- `index.html` must carry `<meta name="generator" content="openmotion-neon-script">`. If it does not, the film was not generated; rebuild it.

## 1. Look at the footage

Extract a frame every second (`ffmpeg -i clip.mp4 -vf fps=1,scale=480:-2,tile=4x2 sheet.jpg`) and pick:

- **The window**: 3-30 s of steady footage. A locked-off or slow shot works best; whip pans make the tubes look pasted on.
- **The canvas area** for each piece: empty wall, sky, glass, floor or tabletop. Note its centre as `x`, `y` fractions of the frame.
- **The darkness** the shot needs: dusk and interiors `darken` 0.25-0.45; bright streets and daylight 0.5-0.7.
- **A subject?** If a person or object should stand in front of some tubes, cut it out once for the same window and pass it as `footage.subject`:

```sh
ffmpeg -ss <start> -t <duration> -i clip.mp4 -an window.mp4
npx hyperframes remove-background window.mp4 -o subject.webm --quality best
```

Use `window.mp4` as `footage.src` with `start` 0 so the two stay frame-aligned. The cut-out runs locally; look at a few frames of it before building and drop it if hair or hands are missing.

## 2. Write neon.json

Follow the [schema](references/schema.md). In short: 1-6 pieces; each piece is `text` (Latin letters, up to 18 characters, written in a single-line script), a `shape` (`heart`, `smile`, `sparkle`, `underline`, `circle`, `arrow`) or a `path` (absolute SVG path data, e.g. a traced signature or logo line), with `color`, `x`, `y`, `size`, `start`, an optional `draw` time, `layer` (`front` or `behind` the subject) and `caps` (dark electrode ends on open shapes and paths). Pieces write one after another; leave 0.3-0.6 s between them, and finish the last one at least 1.5 s before the end so the lit sign can be read.

```sh
node scripts/build.mjs --check neon.json
```

The check rejects missing footage, characters the bundled script font cannot draw, pieces that run off the frame, pieces that finish too close to the end, and out-of-range glow, darkness or relight values. Non-Latin words (for example Chinese) cannot be written with the bundled font: trace them as a `path`, or tell the user.

## 3. Generate and render

```sh
node scripts/build.mjs neon.json out/
cd out && npx hyperframes check && npx hyperframes render -o neon.mp4
```

What the generator builds, in paint order:

| Layer | What it does |
| --- | --- |
| Footage | The clip at `footage.start`, darkened by `darken`, muted unless `footage.sound` is `true` |
| Behind tubes | Pieces with `layer: "behind"` |
| Subject | The cut-out, graded like the footage, covering the behind tubes |
| Relight | Per piece, a screen-blended light near the tube and a soft-light colour cast over the whole frame, lighting the subject too; strength scales with how much tube there is and rises as it is written |
| Front tubes | Each stroke drawn in writing order as five layers — halo, coloured glow, glass, pale core, white-hot line — with electrode caps on open ends and a bright pen tip riding the stroke being drawn |
| Switch-on | A short stutter when each piece closes, then a slow breath while lit |
| Sign-off | "Made with OpenMotion" for the last 2 s |

GSAP comes from the OpenMotion checkout (`OPENMOTION_HOME`) or a local `npm install gsap`.

## 4. Review

Go through [review.md](references/review.md) on a contact sheet and three full-size frames (mid-write, first fully lit frame, last frame). Report what you checked; do not certify that it "looks good".

## Limits

- Occlusion comes from the subject cut-out, not from scene depth: only the cut-out subject can pass in front of tubes. The relight is a 2D wash, not per-surface lighting.
- The bundled stroke font is Latin only. Other scripts (for example Chinese) must come in as `path` data traced as single lines.

## Provenance

Inspired by the neon light-writing demo in Google's Gemini 4 Neon launch film (November 2026). Original OpenMotion recipe and code; no prompts, code or footage from that film are included. Lettering uses the single-line strokes of EMS Allure (Sheldon B. Michaels and Evil Mad Scientist Laboratories, derived from Allura by TypeSETit), SIL Open Font License 1.1 (`assets/fonts/OFL.txt`). Subject cut-outs come from the HyperFrames `remove-background` command. Apache-2.0, like the rest of the repository.
