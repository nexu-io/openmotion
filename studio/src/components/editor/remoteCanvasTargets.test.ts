// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { cancelRemovedCanvasTargets, watchedCanvasTargets, watchCanvasTarget } from "./remoteCanvasTargets";

it("only retires the gesture whose stable target disappeared from the confirmed source", async () => {
  const frame = document.createElement("iframe");
  const target = { sourceFile: "scene.html", elementId: "picture", sha256: "a".repeat(64) };
  const removed = vi.fn();
  const stopped = vi.fn();
  const old = '<template><canvas id="picture"></canvas><p id="text">Hi</p></template>';
  watchCanvasTarget(frame, target, removed);
  watchCanvasTarget(frame, { ...target, elementId: "text" }, stopped);
  const gestures = watchedCanvasTargets(frame, "scene.html");
  await cancelRemovedCanvasTargets(frame, gestures, old.replace('id="picture"', 'style="opacity:.5" id="picture"'), async () => old);
  expect(removed).not.toHaveBeenCalled();
  await cancelRemovedCanvasTargets(frame, gestures, old.replace('<canvas id="picture"></canvas>', ''), async () => old);
  expect(removed).toHaveBeenCalledOnce();
  expect(stopped).not.toHaveBeenCalled();
});
