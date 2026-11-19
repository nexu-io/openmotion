# neon.json

```json
{
  "aspect": "16:9",
  "duration": 8,
  "footage": { "src": "window.mp4", "start": 0, "subject": "subject.webm" },
  "darken": 0.45,
  "relight": 1,
  "tube": { "width": 22, "glow": 1 },
  "brand": true,
  "pieces": [
    { "shape": "smile", "x": 0.42, "y": 0.45, "size": 0.2, "color": "#ffd9a0", "start": 0.5, "draw": 2.4, "layer": "behind" },
    { "text": "neon", "x": 0.5, "y": 0.7, "size": 0.18, "color": "#2ee6ff", "start": 3.4, "draw": 1.8 },
    { "shape": "sparkle", "x": 0.82, "y": 0.6, "size": 0.05, "color": "#9be7ff", "start": 5.3, "draw": 0.5, "caps": false }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `aspect` | no | `16:9` (1920×1080, default), `9:16` (1080×1920) or `1:1` (1080×1080). The footage fills the frame (`object-fit: cover`). |
| `duration` | yes | Film length, 3-30 s. |
| `footage.src` | yes | Video file, relative to `neon.json`. |
| `footage.start` | no | Seconds into the clip where the film begins (default 0). |
| `footage.sound` | no | `true` keeps the clip's own sound; default muted. |
| `footage.subject` | no | Transparent `.webm`/`.mov` cut-out of the person or object for the same window, from `npx hyperframes remove-background`. Needed for `layer: "behind"`. |
| `footage.subjectStart` | no | Seconds into the cut-out where the film begins (default `footage.start`). Use 0 when the cut-out was made from the trimmed window. |
| `darken` | no | Night grade, 0-0.8 (default 0.45). Raise it for bright footage. |
| `relight` | no | How strongly the tubes light the scene and subject, 0-1.5 (default 1). |
| `tube.width` | no | Glass tube thickness in px at the frame size, 4-40 (default 22). |
| `tube.glow` | no | Halo spread, 0-2 (default 1). |
| `brand` | no | `false` removes the "Made with OpenMotion" sign-off. Only when the user asks. |
| `pieces` | yes | 1-6 items, written in the order of their `start`. |

## Piece

Exactly one of `text`, `shape` or `path`.

| Field | Meaning |
| --- | --- |
| `text` | Up to 18 Latin characters, written as single-line script strokes (EMS Allure). |
| `shape` | `heart`, `smile`, `sparkle`, `underline`, `circle` or `arrow`. |
| `path` | Absolute SVG path data (`M L H V Q C Z` only). It is scaled to fit `size` and centred on `x`, `y`; contours are drawn in the order written. |
| `x`, `y` | Centre of the piece as fractions of the frame (default 0.5, 0.5). |
| `size` | For `text`: letter height as a fraction of frame height (default 0.16). For `shape`/`path`: half the piece's height as a fraction of frame height (default 0.15). |
| `color` | `#rrggbb` tube colour (default `#ff3d8b`). The hot core is derived from it. |
| `start` | Seconds when writing begins. |
| `draw` | Seconds to write the whole piece (default scales with tube length, 0.9-3.2 s). |
| `layer` | `front` (default) or `behind` the subject cut-out. |
| `caps` | Dark electrode ends on open strokes. Default `true` for shapes and paths, `false` for text. |
| `flicker` | `false` skips the switch-on stutter. |

Colour starting points that read as neon: pink `#ff3d8b`, cyan `#2ee6ff`, warm white `#ffb36b`, red `#ff4f6d`, ice `#9be7ff`, yellow `#ffd23d`, violet `#a66bff`.
