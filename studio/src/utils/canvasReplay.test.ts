// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { CompositionEdit } from "../../../packages/edit-core/commands";
import { canReplayCanvasCommands } from "./canvasReplay";

const move: CompositionEdit = { kind: "setCanvasBox", compositionPath: "intro.html", target: { id: "picture" },
  box: { left: 120, top: 50, makeRelative: false } };
const source = '<div id="picture" style="position:absolute;left:10px;opacity:1">Hello</div>';

it("only replays a measured move across a change proven to preserve the measured box", () => {
  expect(canReplayCanvasCommands([move], source, source.replace("opacity:1", "opacity:0.5"))).toBe(true);
  for (const newer of [source.replace("10px", "50px"), source.replace("picture", "another"), "",
    source.replace("Hello", "New text"), '<section>' + source + '</section>']) {
    expect(canReplayCanvasCommands([move], source, newer)).toBe(false);
  }
});
