import { getCachedCloudDisklessMode } from "../../utils/cloudRuntime";
import type { TimelineAtomicMoveEdit } from "../../hooks/timelineMoveAdapter";
import type { DomEditPatchBatchesResult } from "../../hooks/domEditCommitTypes";

/** Native mode writes z order and the mirrored track through separate APIs. Keep both
 * phases together even when a second gesture starts before the first write returns. */
let gestureTail: Promise<void> | null = null;

/** The single ordering owner for every gesture that crosses z/lane persistence. */
export function serializeZLaneGesture<Result>(run: () => Promise<Result>): Promise<Result> {
  const previous = gestureTail;
  // Preserve synchronous optimistic updates for the first gesture. A queued
  // gesture starts only after the preceding gesture fully settled.
  let gesture: Promise<Result>;
  if (previous) {
    gesture = previous.then(run, run);
  } else {
    try {
      gesture = Promise.resolve(run());
    } catch (error) {
      gesture = Promise.reject(error);
    }
  }
  const tail = gesture.then(
    () => undefined,
    () => undefined,
  );
  gestureTail = tail;
  void tail.then(() => {
    if (gestureTail === tail) gestureTail = null;
  });
  return gesture;
}

export type CommitLayerOrder = (lanes?: TimelineAtomicMoveEdit[]) => Promise<void>;

export function runZLaneGesture(input: {
  commitZ: (lanes?: TimelineAtomicMoveEdit[]) => Promise<DomEditPatchBatchesResult | undefined | void>;
  mirror: (commitTogether?: CommitLayerOrder) => Promise<boolean>;
}): Promise<boolean> {
  if (getCachedCloudDisklessMode()) {
    return input.mirror(async (...lanes) => {
      const result = await input.commitZ(...lanes);
      if (result && !result.durable) throw new Error("Could not reorder layers.");
    });
  }
  return serializeZLaneGesture(async () => {
    const result = await input.commitZ();
    if (result && !result.durable) return false;
    return input.mirror();
  });
}

/** Run one lane→z gesture under the same owner as canvas z→lane gestures. */
export function runLaneZGesture(input: {
  commitLane: () => Promise<boolean>;
  commitZ: () => Promise<void>;
}): Promise<boolean> {
  return serializeZLaneGesture(async () => {
    if (!(await input.commitLane())) return false;
    await input.commitZ();
    return true;
  });
}
