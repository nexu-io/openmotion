import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { buildProjectApiPath } from "../../utils/projectRouting";
import {
  peekCachedCompositionCapture, retainCachedCompositionCapture, subscribeCompositionCacheRevision,
} from "../lib/clientCompositionCapture";
import { usePlayerStore } from "../store/playerStore";
import { thumbnailRevisionOf } from "../store/thumbnailSlice";
import { encodePreviewPath } from "./thumbnailUtils";

/** Borrow the sidebar's current in-memory cover. A miss must not schedule a capture or a fetch. */
export function CachedCompositionPoster({ projectId, compositionPath }: { projectId: string; compositionPath: string }) {
  const previewUrl = buildProjectApiPath(projectId, `/preview/comp/${encodePreviewPath(compositionPath)}`);
  const contentRevision = usePlayerStore((state) => thumbnailRevisionOf(state.thumbnailRevisions, compositionPath));
  const subscribe = useCallback((listener: () => void) => subscribeCompositionCacheRevision(projectId, listener), [projectId]);
  const capture = useSyncExternalStore(subscribe, () => peekCachedCompositionCapture({
    projectId, previewUrl, contentRevision, frameCount: 1,
  }), () => null);
  const src = capture?.kind === "image" ? capture.url : capture?.kind === "filmstrip" ? capture.urls[0] : undefined;
  const [failed, setFailed] = useState<string>();
  const shown = src && src !== failed ? capture : null;
  useLayoutEffect(() => retainCachedCompositionCapture(shown), [shown]);

  return shown && src
    ? <img key={src} src={src} alt="" draggable={false} className="size-full object-contain" onError={() => setFailed(src)} />
    : null;
}
