import { isCurrentIsolatedManifest } from "../../player/lib/isolatedTimelineManifest";
import { usePlayerStore } from "../../player/store/playerStore";
import type { NLEContextValue } from "./NLEContext";

export function useTimelineContentReady({ projectId, compositionStack, iframeRef, timelineDisabled }: NLEContextValue) {
  const currentLevel = compositionStack.at(-1);
  const activeSource = compositionStack.length > 1 ? currentLevel!.id : "index.html";
  const ready = usePlayerStore(state => {
    if (state.timelineProjectId !== projectId) return false;
    if (state.authoredTimelinePath === activeSource) return true;
    if (!state.timelineReady) return false;
    if (!timelineDisabled) return true;
    // A verified timeline can be edited before its first frame. During navigation,
    // the outgoing document may still own the store's manifest.
    const frame = iframeRef?.current;
    return !!frame?.src && !!currentLevel?.previewUrl && isCurrentIsolatedManifest(frame, state.clipManifest) &&
      new URL(frame.src).pathname === new URL(currentLevel.previewUrl, window.location.href).pathname;
  });
  return { activeSource, ready };
}
