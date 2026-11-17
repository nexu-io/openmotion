import type { TimelineElement } from "./timelineElement";
import type { TimelineDropPlacement } from "../components/timelineCallbacks";
import { usePlayerStore } from "./playerStore";
import { generateId } from "../../utils/generateId";
import { getTimelineAssetKind } from "../../utils/timelineAssetDrop";
import { resolveNearestFreeStart } from "../components/timelineCollision";

export interface PendingAssetDrop {
  id: string;
  assetPath: string;
  placement: TimelineDropPlacement;
  duration?: number;
  element?: TimelineElement;
  failed?: "add" | "preview";
  rowOwnerId?: string;
}

export function beginPendingAssetDrop(
  assetPath: string,
  placement: TimelineDropPlacement,
  duration?: number,
): string {
  const id = generateId();
  duration ??= getTimelineAssetKind(assetPath) === "image" ? 3 : undefined;
  usePlayerStore.setState((state) => {
    const kind = getTimelineAssetKind(assetPath);
    // Resolve known collisions before the first paint, in the displayed row.
    const busy = state.pendingAssetDrops.filter((drop) =>
      (!drop.failed || drop.element) && drop.placement.insertRow === placement.insertRow,
    ).map((drop) => drop.element ?? {
      id: drop.id, tag: getTimelineAssetKind(drop.assetPath) ?? "div",
      ...drop.placement, duration: drop.duration ?? 5,
    }).filter((element) => (element.tag === "audio") === (kind === "audio"));
    const peers = kind ? state.elements.filter(element => (element.tag === "audio") === (kind === "audio")) : [];
    const start = placement.newTrack || placement.insertRow != null ? placement.start : resolveNearestFreeStart([...peers, ...busy], placement.track, placement.start, duration ?? 5, null);
    return { pendingAssetDrops: [...state.pendingAssetDrops, {
      id, assetPath, placement: { ...placement, start }, duration,
    }] };
  });
  return id;
}

export function updatePendingAssetDrop(id: string, patch: Partial<PendingAssetDrop>): void {
  usePlayerStore.setState((state) => ({
    pendingAssetDrops: state.pendingAssetDrops.map((drop) => drop.id === id ? { ...drop, ...patch } : drop),
  }));
}

export function isPendingAssetDropActive(id: string): boolean {
  return usePlayerStore.getState().pendingAssetDrops.some((drop) => drop.id === id);
}

export function finishPendingAssetDrop(id: string, element?: TimelineElement): void {
  const placement = usePlayerStore.getState().pendingAssetDrops.find(drop => drop.id === id)?.placement;
  updatePendingAssetDrop(id, element ? {
    element, duration: element.duration,
    placement: { ...placement, start: element.start, track: placement?.track ?? element.track },
  } : { failed: "add" });
}

export function dismissPendingAssetDrop(id: string): void {
  usePlayerStore.setState((state) => ({
    pendingAssetDrops: state.pendingAssetDrops.filter((drop) => drop.id !== id),
  }));
}

export function failPendingAssetPreviews(): void {
  usePlayerStore.setState((state) => ({
    pendingAssetDrops: state.pendingAssetDrops.map((drop) =>
      drop.element && !drop.failed ? { ...drop, failed: "preview" } : drop),
  }));
}
