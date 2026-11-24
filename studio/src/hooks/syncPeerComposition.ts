import type { RefObject } from "react";
import { shareCompositionPosterRead, type KnownCompositionSource, MAX_POSTER_SOURCE_LENGTH } from "../player/lib/compositionPosterSource";
import { beginPeerTimelineUpdate } from "../player/lib/peerTimeline";
import { hasPeerLiveEdit, hasPeerTimingDocument, hasScriptedStylePreview, mountedPeerFileVersion, tryApplyPeerChanges, tryRefreshParkedPeerScene } from "../player/peerTimingPreview";
import { isPreviewChanging } from "../player/previewReloading";
import { announcePreviewScenesSwapped, notePeerPreviewChange, previewSourceRevision } from "../player/sceneSwap";
import { usePlayerStore } from "../player/store/playerStore";
import { isStudioEditSaving } from "../utils/studioPendingEdits";
import type { RemoteFileRead } from "./remoteFileReads";
import { MAX_PEER_PREVIEW_SOURCE_LENGTH } from "../../../shared/preview-timing";
import { studioApiFetch } from "../utils/studioApiFetch";
import { buildProjectApiPath } from "../utils/projectRouting";
import { confirmedSource } from "../utils/confirmedTextSources";

/** A cold observer can compare a mounted child without prefetching every scene on open. */
async function readMountedSource(projectId: string, version: string) {
  const digest = /^"(?:sha256|patch):([a-f0-9]{64})"$/.exec(version)?.[1];
  if (!digest) return null;
  const response = await studioApiFetch(buildProjectApiPath(projectId, "/history/blob/" + digest));
  if (!response.ok || response.headers.get("etag") !== version) return null;
  const content = await response.text();
  return content.length <= MAX_PEER_PREVIEW_SOURCE_LENGTH ? { content, version } : null;
}

/** Project the latest source immediately. Only a verified in-place preview can waive a refresh. */
export function syncPeerComposition(
  projectId: string, path: string | null, paths: readonly string[] | null,
  read: RemoteFileRead, frameRef: RefObject<HTMLIFrameElement | null>,
  previous: KnownCompositionSource | null, changedVersion?: string,
): Promise<boolean> | undefined {
  const frame = frameRef.current;
  const changed = paths?.length === 1 ? paths[0] : undefined;
  const mounted = syncMountedComposition(projectId, path, paths, read, frameRef, previous);
  if (!frame || path !== "index.html" || !changed || changed === path || !changedVersion || !/\.html?$/i.test(changed)) return mounted;
  const revision = previewSourceRevision();
  const current = () => frameRef.current === frame && revision === previewSourceRevision() &&
    !isPreviewChanging() && !isStudioEditSaving() && usePlayerStore.getState().timelineProjectId === projectId;
  return Promise.resolve(mounted).then(async handled => {
    if (handled) return true;
    if (!await tryRefreshParkedPeerScene(frame, changed, changedVersion, current)) return false;
    announcePreviewScenesSwapped(frame);
    return true;
  });
}

function syncMountedComposition(
  projectId: string, path: string | null, paths: readonly string[] | null,
  read: RemoteFileRead, frameRef: RefObject<HTMLIFrameElement | null>, previous: KnownCompositionSource | null,
): Promise<boolean> | undefined {
  const frame = frameRef.current;
  const apply = path && (!paths || paths.includes(path)) && beginPeerTimelineUpdate(projectId, path, frame);
  if (!apply) notePeerPreviewChange();
  const changedPath = paths?.length === 1 ? paths[0] : undefined;
  const liveRoot = frame && (hasPeerTimingDocument(frame) || hasPeerLiveEdit(frame, "position") || hasPeerLiveEdit(frame, "mediaTiming"));
  if (frame && hasScriptedStylePreview(frame) && changedPath?.endsWith(".html")) {
    const base = confirmedSource(projectId, changedPath) ?? (changedPath === path ? previous : null);
    const liveChild = changedPath !== path && hasPeerLiveEdit(frame, "position") && !isPreviewChanging();
    const pinned = !base && liveChild ? mountedPeerFileVersion(frame, changedPath) : undefined;
    if ((base && base.content.length <= MAX_PEER_PREVIEW_SOURCE_LENGTH) || pinned) {
      const revision = previewSourceRevision();
      const isCurrent = () => frame === frameRef.current && revision === previewSourceRevision() &&
        usePlayerStore.getState().timelineProjectId === projectId && !isStudioEditSaving();
      // Nested files can use the same verified placement update as the writer.
      const changedFile = read(projectId, changedPath);
      if (changedFile && changedPath !== path) {
        shareCompositionPosterRead(usePlayerStore.getState(), projectId, changedPath, changedFile);
      }
      if (changedFile && liveChild) {
        return changedFile.then(async ({ content, version }) => {
          if (typeof content !== "string" || content.length > MAX_PEER_PREVIEW_SOURCE_LENGTH || !version || !isCurrent() || isPreviewChanging()) return false;
          if (mountedPeerFileVersion(frame, changedPath) === version) return true;
          const previous = base ?? (pinned && pinned !== version ? await readMountedSource(projectId, pinned) : null);
          if (!previous || !isCurrent() || isPreviewChanging()) return false;
          const applied = await tryApplyPeerChanges(frame, { path: changedPath, previous, current: { content, version } }, isCurrent, "keep-visible");
          if (applied && isCurrent()) announcePreviewScenesSwapped(frame);
          return applied;
        });
      }
      // Unverified scripts can display a provisional style while their document rebuilds.
      if (base && !(changedPath === path && liveRoot)) {
        void changedFile?.then(({ content, version }) => {
          if (typeof content === "string" && version && isCurrent())
            return tryApplyPeerChanges(frame, { path: changedPath, previous: base, current: { content, version } }, isCurrent, "temporary");
        }).catch(() => {});
      }
    }
  }
  if (!path || !apply) return;
  const file = read(projectId, path);
  if (!file) return;
  shareCompositionPosterRead(usePlayerStore.getState(), projectId, path, file);
  const timeline = file.then(result => {
    if (!result.missing && typeof result.content === "string") apply(result.content, frameRef.current);
    return result;
  });
  if (!frame || !liveRoot || paths?.length !== 1 || !previous || isPreviewChanging()) {
    void timeline.catch(() => {});
    return;
  }
  const revision = previewSourceRevision();
  const isCurrent = () => frame === frameRef.current && revision === previewSourceRevision() &&
    usePlayerStore.getState().timelineProjectId === projectId && !isPreviewChanging() && !isStudioEditSaving();
  return timeline.then(async ({ content, version, missing }) => {
    if (missing || !version || typeof content !== "string" || content.length > MAX_POSTER_SOURCE_LENGTH || !isCurrent()) return false;
    const applied = await tryApplyPeerChanges(frame, { path, previous, current: { content, version } }, isCurrent, "keep-visible");
    if (applied && isCurrent()) {
      announcePreviewScenesSwapped(frame);
      return true;
    }
    return false;
  });
}
