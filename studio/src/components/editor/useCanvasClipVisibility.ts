import { useMemo, useSyncExternalStore } from "react";
import { liveTime, usePlayerStore } from "../../player/store/playerStore";
import { findMatchingTimelineElementId } from "../../utils/studioHelpers";
import type { DomEditSelection } from "./domEditing";

/** Subscribe to a boolean so playback only renders the overlay when the selected clip enters or leaves the frame. */
export function useCanvasClipVisibility(selection: DomEditSelection | null) {
  const elements = usePlayerStore(state => state.elements);
  const clip = useMemo(() => {
    if (!selection?.isolatedTarget) return;
    const target = selection.isolatedClipOwner
      ? { ...selection.isolatedClipOwner, selector: "", isCompositionHost: false }
      : selection;
    const key = findMatchingTimelineElementId(target, elements);
    return elements.find(element => (element.key ?? element.id) === key);
  }, [elements, selection]);
  return useSyncExternalStore(liveTime.subscribe, () => {
    if (!clip) return true;
    const time = liveTime.latest();
    return !clip.hidden && time >= clip.start && time < clip.start + clip.duration;
  });
}
