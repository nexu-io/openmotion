import { describe, expect, it } from "vitest";
import { snapOpenReelMove } from "./timelineDragSnap";

describe("OpenReel drag snapping", () => {
  it("snaps either clip edge within the upstream pixel radius and releases immediately outside it", () => {
    const targets = [{ time: 10, type: "clip-edge" as const }];
    for (const pps of [20, 100, 400]) {
      expect(snapOpenReelMove(10 - 39 / pps, 100, targets, pps)).toMatchObject({ start: 10, snapEdge: "start" });
      expect(snapOpenReelMove(10 - 41 / pps, 100, targets, pps).snapTime).toBeNull();
      expect(snapOpenReelMove(8 - 10 / pps, 2, targets, pps)).toMatchObject({ start: 8, snapEdge: "end" });
    }
  });
  it("ignores the playhead and prioritizes clip edges over a closer grid line", () => {
    expect(snapOpenReelMove(5.12, 2, [{time: 5, type: "playhead"}], 100)).toMatchObject({ start: 5.12, snapTime: null });
    expect(snapOpenReelMove(5.12, 2, [{time: 5.4, type: "clip-edge"}], 100, 1))
      .toMatchObject({ start: 5.4, snapType: "clip-edge" });
  });
  it("preserves Motion's smaller beat radius", () => {
    expect(snapOpenReelMove(5.04, 2, [{time: 5, type: "beat"}], 100)).toMatchObject({start: 5, snapType: "beat"});
    expect(snapOpenReelMove(5.06, 2, [{time: 5, type: "beat"}], 100)).toMatchObject({start: 5.06, snapTime: null});
  });

  it("prefers a same-lane join only while the two cuts are indistinguishable", () => {
    const seam = { time: 10.733, type: "clip-edge" as const, endTracks: [1] };
    const cut = { time: 10.7333333333, type: "clip-edge" as const, startTracks: [0] };
    const targets = [seam, cut];
    const snap = (pps: number, track: number) => snapOpenReelMove(cut.time, 2, targets, pps, 0, track);
    expect(snap(100, 1).snapTime).toBe(seam.time);
    expect(snap(100, 2).snapTime).toBe(cut.time);
    expect(snap(4000, 1).snapTime).toBe(cut.time);
    const distinct = { ...cut, time: 10.736 };
    expect(snapOpenReelMove(distinct.time, 2, [seam, distinct], 100, 0, 1).snapTime).toBe(distinct.time);
  });
});
