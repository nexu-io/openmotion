# Photo Frame Iris

A seven-scene photo-framing walkthrough for creators introducing a gallery, color treatment or print collection. The silent film starts with an unframed image, follows a selection and color change, presents three finished works, then compares two treatments of the opening image.

**Project:** editable HyperFrames HTML/CSS/JavaScript, 1280 × 720, 30 fps, 33.8 seconds.

## Play and edit

Create an independent copy of **Photo Frame Iris** from the OpenMotion template catalog and open its `main` composition. The root file in a project copy is `index.html`. In a repository checkout, open `source/preview.html` for the rendered walkthrough and read `source/motion.md` for the timing. The portable ZIP includes the MP4 at `assets/lfs/preview.mp4` and the same guide as `motion.md`.

For an ordinary Git checkout, hydrate the preview for just this entry:

```sh
git lfs pull --include="library/templates/catalog/motion-photo-frame-iris/source/assets/lfs/**" --exclude=""
```

The sub-compositions in `compositions/`, in playback order, are `lake`, `library`, `color`, `petal`, `canopy`, `eaves` and `edition`.

The gallery and color tools are schematic interface examples authored for the template. Replace their graphics and words with your own product material when adapting them to a real application.

## Replace the artwork

| Slot | File | What to keep aligned |
| --- | --- | --- |
| Opening view | `assets/inlet-before.svg` | An unframed 1200 × 900 image |
| Opening print | `assets/inlet-framed.svg` | A 1296 × 1272 print with the original view at (48, 140) and size 1200 × 900 |
| Closing print | `assets/inlet-blue.svg` | The same outer dimensions and exactly the same inner image rectangle as the opening print |
| Three collection works | `assets/blossom-study.svg`, `assets/canopy-study.svg`, `assets/rooftop-study.svg` | Each work is a 900 × 1200 portrait print, including its artwork and imprint |

The SVGs are editable source. To use photographs, replace the corresponding image paths in the scene files under `compositions/` with local JPEG, PNG or WebP files. Matching the example dimensions is the simplest way to retain the crop. Compare two landmarks near opposite corners of the image during the pullback, then scrub through the frame change near the end. The picture should occupy the same part of both prints.

## Adapt the walkthrough

- **Lake and Edition:** edit the opening copy and registered before/after pair in `compositions/lake.html`. The closing comparison and title live in `compositions/edition.html`. The white and blue versions occupy exactly the same bounds.
- **Library:** replace the gallery thumbnails and selected work together. Check the state after the horizontal scroll and the enlarged view for continuity.
- **Color:** edit the swatches in `.swatches` and the corresponding `.picker-print` treatment together. Preserve the selected state long enough to show which swatch produced the result.
- **Petal, Canopy and Eaves:** update each print independently. The bundled artwork includes its own title or palette. Keep a complete frame visible during each hold.
- **Timing and hierarchy:** `index.html` defines the seven scene boundaries; each scene file contains its copy, image references and local animation. `assets/style.css` defines the canvas, typography and layout. `assets/motion.js` registers the seekable GSAP timeline. If retiming a scene, update its clip timing, the timeline cues and the overall duration together. Inspect all six cuts after making a change.

## Source and rights

The opening and closing iris reference the editable OpenMotion catalog entry [Voice mode / Voice Circle Reveal](https://github.com/nexu-io/openmotion/tree/main/library/templates/catalog/motion-dac924da-010f-4445-baf3-a39cb033e48f). Its guide credits [Anthropic's Claude reference film](https://x.com/claudeai/status/2080376094939603366). The centered circular reveal, measured title hold and seekable timeline informed the adaptation. Its closing comparison reveals the lake-blue print through the circle and holds the complete work. The gallery, palette demonstration and collection sequence were authored for this seven-scene walkthrough.

The new implementation, neutral interface examples, six original geometric SVG illustrations, documentation and their rendered previews were prepared by nextdiy with Codex for this contribution under [Apache-2.0](https://github.com/nexu-io/openmotion/blob/main/LICENSE). Each SVG includes its license. The supplied demonstration uses no customer photographs, real application screenshots, third-party reference film, soundtrack or third-party brand artwork. The GSAP runtime retained from the reference project is governed by the bundled `assets/GSAP-LICENSE.txt`. System fonts are selected locally and no font files are distributed.
