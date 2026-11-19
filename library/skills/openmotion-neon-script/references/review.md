# Review checklist

Check on a 1-frame-per-second contact sheet plus three full-size frames: mid-write, the first fully lit frame and the last frame.

## Placement

- [ ] No tube crosses a face, a product's label or the user's logo.
- [ ] Every piece sits on a calm area (wall, sky, glass, floor, tabletop) for the whole film; nobody walks through it.
- [ ] Nothing touches the frame edge; the sign-off does not overlap a piece.

## Light

- [ ] Each tube is clearly brighter than what is behind it; if not, raise `darken` or move the piece.
- [ ] The relight colours the area around the tube and fades with distance; the whole frame is not washed out or milky.
- [ ] Each piece uses one colour; at most three colours in the film.
- [ ] The switch-on stutter is short (under 0.4 s) and flashes stay within photosensitivity limits (no more than three flashes per second).

## Writing

- [ ] Strokes appear in reading order; no letter appears before the one to its left.
- [ ] The finished words are spelled exactly as the user wrote them and stay readable for at least 1.5 s.
- [ ] Shapes finish after the words they decorate.

## Brand and output

- [ ] "Made with OpenMotion" appears in the last 2 s, unless the user removed it.
- [ ] `npx hyperframes check` passes; the MP4 length equals `duration`.
- [ ] The user's footage is unchanged apart from the grade and the light (no crop beyond `cover`, no speed change).
