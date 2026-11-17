// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { useTimelineDisplayLayout } from "./useTimelineTrackLayout";
import { createTimelineRowGeometry } from "./timelineLayout";
import type { DraggedClipState } from "./timelineClipDragTypes";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("keeps interior pointer seams stable, previews top and bottom lanes, and expands keyboard pickup", () => {
  const order = [7, 3, 9];
  const geometry = createTimelineRowGeometry(order, [48, 104, 48], { top: 0 });
  const host = document.createElement("div");
  const root = createRoot(host);
  const drag: DraggedClipState = {
    pointerId: 1,
    element: { id: "clip", tag: "div", start: 1, duration: 2, track: 9 },
    originClientX: 0,
    originClientY: 0,
    originScrollLeft: 0,
    originScrollTop: 0,
    pointerClientX: 0,
    pointerClientY: 0,
    pointerOffsetX: 0,
    pointerOffsetY: 0,
    previewStart: 1,
    previewTrack: 3,
    insertRow: 1,
    snapTime: null,
    snapType: null,
    started: true,
  };
  function Probe({ active }: { active: DraggedClipState | null }) {
    const layout = useTimelineDisplayLayout(active, order, geometry);
    return (
      <output>
        {JSON.stringify({
          order: layout.displayTrackOrder,
          pinned: layout.draggedRowKey,
          heights: layout.displayRowHeights,
          below: layout.rowGeometry.getRowTop(2),
        })}
      </output>
    );
  }
  act(() => root.render(<Probe active={drag} />));
  const pointer = JSON.parse(host.textContent!);
  expect(pointer.order).toEqual(order);
  expect(pointer.heights).toEqual([48, 104, 48]);
  expect(pointer.below).toBe(176);
  act(() => root.render(<Probe active={{ ...drag, insertRow: 0 }} />));
  const top = JSON.parse(host.textContent!);
  expect(top.order).toEqual([-1, ...order]);
  expect(top.pinned).toBe(-1);
  expect(top.heights).toEqual([48, 48, 104, 48]);
  expect(top.below).toBe(120);
  act(() => root.render(<Probe active={{ ...drag, insertRow: order.length }} />));
  const bottom = JSON.parse(host.textContent!);
  expect(bottom.order.slice(0, order.length)).toEqual(order);
  expect(bottom.order).toHaveLength(4);
  expect(bottom.pinned).toBe(-1);
  expect(bottom.heights).toEqual([48, 104, 48, 48]);
  expect(bottom.below).toBe(pointer.below);
  act(() => root.render(<Probe active={drag} />));
  expect(JSON.parse(host.textContent!).order).toEqual(order);
  // Moving through the seam must not move either existing lane underneath the pointer.
  act(() => root.render(<Probe active={{ ...drag, insertRow: null }} />));
  expect(JSON.parse(host.textContent!).heights).toEqual(pointer.heights);
  act(() => root.render(<Probe active={{ ...drag, pointerId: null }} />));
  const seen = JSON.parse(host.textContent!);
  expect(seen.order).toHaveLength(4);
  expect(seen.pinned).toBe(-1);
  expect(seen.order.filter((key: number) => order.includes(key))).toEqual(order);
  expect(order.includes(seen.order[1])).toBe(false);
  expect(seen.heights).toEqual([48, 48, 104, 48]);
  expect(seen.below).toBe(120);
  expect(order).toEqual([7, 3, 9]);
  act(() => root.render(<Probe active={null} />));
  expect(JSON.parse(host.textContent!).order).toEqual(order);
  act(() => root.unmount());
});
