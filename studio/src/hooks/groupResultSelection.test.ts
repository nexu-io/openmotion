// @vitest-environment jsdom

import { expect, it, vi } from "vitest";
import { announcePreviewPromoted, announcePreviewScenesSwapped } from "../player/sceneSwap";
import { followGroupSelection, type GroupSelectionResult } from "./groupResultSelection";

const group: GroupSelectionResult = {wrap:true,wrapper:{id:"things"},members:[{id:"a"},{id:"b"}]};

it("selects the edit result after a preview promotion, once", async () => {
  const original = document.body.appendChild(document.createElement("iframe"));
  const next = document.body.appendChild(document.createElement("iframe"));
  const select = vi.fn(async (frame: HTMLIFrameElement) => frame === next);
  const pending = followGroupSelection(original, group, select);
  pending.saved();
  announcePreviewScenesSwapped(original);
  await Promise.resolve();
  announcePreviewPromoted({retired:original, live:next});
  await Promise.resolve();
  announcePreviewScenesSwapped(next);
  expect(select.mock.calls.map(([frame]) => frame)).toEqual([original, next]);
  original.remove(); next.remove();
});

it("restores an optimistic selection on rollback and yields to a subsequent user input", async () => {
  const frame = document.body.appendChild(document.createElement("iframe"));
  const select = vi.fn(async (_frame: HTMLIFrameElement, op: GroupSelectionResult) => !!op);
  const pending = followGroupSelection(frame, group, select);
  pending.ready();
  await Promise.resolve();
  pending.rollback();
  await Promise.resolve();
  expect(select.mock.calls.map(([,op]) => op.wrap)).toEqual([true,false]);
  const other = followGroupSelection(frame, group, select);
  document.dispatchEvent(new Event("pointerdown"));
  other.saved();
  announcePreviewScenesSwapped(frame);
  expect(select).toHaveBeenCalledTimes(2);
  frame.remove();
});
