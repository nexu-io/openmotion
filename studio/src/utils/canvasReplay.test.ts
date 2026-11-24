// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { CompositionEdit } from "../../../packages/edit-core/commands";
import { canReplayCanvasCommands } from "./canvasReplay";

const move: CompositionEdit = { kind: "setCanvasBox", compositionPath: "intro.html", target: { id: "picture" },
  box: { left: 120, top: 50, makeRelative: false } };
const source = '<div id="picture" style="position:absolute;left:10px;opacity:1">Hello</div>';

it("only replays a measured move across a change proven to preserve the measured box", async () => {
  expect(await canReplayCanvasCommands([move], source, source.replace("opacity:1", "opacity:0.5"))).toBe(true);
  for (const newer of [source.replace("10px", "50px"), source.replace("picture", "another"), "",
    source.replace("Hello", "New text"), '<section>' + source + '</section>']) {
    expect(await canReplayCanvasCommands([move], source, newer)).toBe(false);
  }
});

it("replays a canvas drag when the peer's first edit persists the same compiler-assigned ids", async () => {
  const { ensureHfIds } = await import("@hyperframes/parsers/hf-ids");
  const initial = '<template><canvas id="picture"></canvas></template>';
  const stamped = ensureHfIds(initial);
  expect(await canReplayCanvasCommands([move], initial, stamped.replace('<canvas ', '<canvas style="opacity: 0.52" '))).toBe(true);
});
