import { useCallback, useEffect, useMemo, useState } from "react";
import { usePlayerStore } from "../player/store/playerStore";
import { useCloudFeatureEnabled } from "../utils/cloudFeatures";
import { scheduleIdlePreloads } from "../utils/idlePreload";
import { loadTranscript, loadRenderQueue } from "../components/studioPanelImports";
import { loadWorkspaceSearchResults, loadCreativeMediaMenu } from "../motion/workspaceFeatureImports";

/** A slow or failed preview can unlock timeline editing before it has painted.
 * Start optional downloads from the live frame's paint, never from that soft unlock. */
export function useWarmStudioFeatures(projectId: string, workspace: boolean) {
  const visit = useMemo(() => ({ projectId }), [projectId]);
  const [paintedVisit, setPaintedVisit] = useState<typeof visit | null>(null);
  const timelineReady = usePlayerStore(state => state.timelineProjectId === projectId && (state.timelineReady || !!state.authoredTimelinePath));
  const asrEnabled = useCloudFeatureEnabled("asr");
  useEffect(() => {
    if (paintedVisit !== visit || !timelineReady) return;
    return scheduleIdlePreloads([
      loadRenderQueue,
      ...(asrEnabled ? [loadTranscript] : []),
      ...(workspace ? [loadWorkspaceSearchResults, loadCreativeMediaMenu] : []),
    ]);
  }, [paintedVisit, visit, timelineReady, asrEnabled, workspace]);
  return useCallback(() => setPaintedVisit(visit), [visit]);
}
