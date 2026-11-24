# Scene timing

**Kind:** source-only motion helper. **Status:** proposal; not registered in Studio or used by an existing template.

Use [`scheduleScenes`](schedule-scenes.mjs) when the same storyboard needs to fit
different runtimes without rewriting its renderer. Keep absolute beats (an end
card or spoken line) fixed and let the surrounding scenes flex.

## Timing contract

- Pass an ordered list of scenes with unique IDs and the total composition length
  in frames. Set `frames` to lock a scene's length, or `weight` to set its relative
  share (default: 1). Don't set both. All explicit lengths and weights must be
  positive safe integers; for example, the ratio 1.5:1 can be written as 3:2.
- Fixed scenes keep their exact lengths, regardless of order. From the remaining
  frames, reserve one per flexible scene so no scene disappears. Divide the
  rest by weight and award leftover frames to the largest fractional shares.
  Equal remainders go to the earlier scene.
- The result has one `{ id, startFrame, endFrame }` per scene, in input order.
  Ranges include their start and exclude their end. They are contiguous and
  finish at exactly `totalFrames`. Use the composition's frame rate to convert
  the boundaries to seconds; the helper does not own a playback clock.
- Invalid input throws. A fixed budget that overruns the composition, doesn't
  leave enough frames for the flexible scenes, or leaves unused frames with no
  flexible scenes is rejected rather than silently resizing a locked beat.

## Example

In a 12-second composition at 30 fps, the end card stays on for two seconds.
The payoff gets twice the flexible weight of the hook.

```js
import { scheduleScenes } from './schedule-scenes.mjs';

const fps = 30;
const timing = scheduleScenes([
  { id: 'hook', weight: 1 },
  { id: 'payoff', weight: 2 },
  { id: 'end-card', frames: 2 * fps },
], 12 * fps);

// hook: [0, 100), payoff: [100, 300), end-card: [300, 360)
```

To adapt the pace, change the weights or the total length while leaving the
rendering code and locked beat alone. This is a timing example, not an editable
video project or rendered preview.

## Source and verification

Adapted by [@jiangxingfan1-coder](https://github.com/jiangxingfan1-coder) from the
[`schedule` helper in the independent Open Motion studio](https://github.com/jiangxingfan1-coder/openmotion/blob/42508a8684047a57446e35baa8495afde78fd68f/styles/_kit/om.js#L139-L158).
This version uses integer frames and rejects impossible budgets instead of
stretching the final scene. The source is [Apache-2.0](../../../LICENSE); no
third-party source, assets, fonts, or runtime dependencies are included.

From the repository root, run `node --test tests/scene-timing.test.ts`.
The tests exercise the timing contract only; no playback or export is claimed.
