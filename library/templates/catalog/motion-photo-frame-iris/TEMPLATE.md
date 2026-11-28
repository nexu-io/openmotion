# Photo Frame Iris

Make a before-and-after film from one image and a finished print of that same image. The camera pulls back to reveal the border while the picture stays aligned. A circular mask closes the image and leaves a title beneath the frame icon.

**Format:** editable OpenMotion / HyperFrames composition, 1280 × 720, 30 fps, 11.6 seconds, silent.

## Start here

Create an independent copy of **Photo Frame Iris** in the OpenMotion template catalog. The project entry is `index.html`. In the repository, the project files are under `source/`. The catalog's `source/preview.html` plays the rendered example and `source/motion.md` describes the motion.

From a Git checkout, download this entry's preview first. The project artwork and runtime are available directly from the checkout.

```sh
git lfs pull --include="library/templates/catalog/motion-photo-frame-iris/source/assets/lfs/**" --exclude=""
```

## Replace the artwork

1. Supply an unframed picture and a framed version containing the same picture at the same aspect ratio. Use a horizontally centered inner picture. Align the images using two recognizable details near opposite corners. A different crop or rotation will create a visible jump.
2. Replace the image sources on `#original` and `#framed`. Both shipped illustrations are editable SVGs. Local JPEG, PNG or WebP images also work.
3. Measure the inner picture's rectangle within the entire finished print. On `#film`, set `data-print-ratio` to the print width divided by its height. Set `data-photo-left` and `data-photo-width` to the inner picture's left coordinate and width divided by the print width. Divide its top coordinate and height by the print height for `data-photo-top` and `data-photo-height`. Enter fractions between 0 and 1.
4. Choose `data-print-width` in composition pixels to fit the finished print above the caption. The example uses 554. Its print is 1296 × 1272, with a 1200 × 900 inner picture starting at (48, 140).

## Replace the message

Edit the two spans in `#subtitle`, the final title in `#brand` and the supporting line in `#tagline`. Keep each phrase short enough to read during the two-part reveal. In `assets/style.css`, `--paper` colors the surrounding canvas and `--ink` colors the mark and title. The typography uses locally available system fonts.

Review the first frame, the opening reveal, the caption hold at 3 seconds, and the centered closing title at 8 seconds. Scrub both directions to verify that the picture remains aligned and the captions return to the right state. Edit the phase timings in `assets/motion.js` together with the composition and clip durations if changing the length.

## Source and rights

- **Motion adaptation.** The starting project was OpenMotion's [Voice Circle Reveal / Voice mode](https://github.com/nexu-io/openmotion/tree/main/library/templates/catalog/motion-dac924da-010f-4445-baf3-a39cb033e48f). Its guide credits [Anthropic's Claude reference film](https://x.com/claudeai/status/2080376094939603366). This adaptation retains the centered circular transition, incremental phrase reveal, closing hold and seekable timeline. The reference film, original soundtrack and brand imagery remain with their respective owners and are excluded from this contribution.
- **Editable project and example media.** The new source, documentation and original geometric inlet illustrations were prepared with Codex for this contribution by nextdiy under the repository's [Apache License 2.0](https://github.com/nexu-io/openmotion/blob/main/LICENSE). The example poster and silent video are renders of this artwork and composition. The SVGs include their license identifiers.
- **Animation dependency.** The bundled GSAP runtime comes from the selected OpenMotion project. Webflow retains its rights under the accompanying `assets/GSAP-LICENSE.txt`. The repository's Apache license does not replace those terms.
