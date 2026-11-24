import type { RefObject } from "react";
import { shareCompositionPosterRead, type KnownCompositionSource } from "../player/lib/compositionPosterSource";
import { beginPeerTimelineUpdate } from "../player/lib/peerTimeline";
import { hasPeerLiveEdit, hasPeerTimingDocument, hasScriptedStylePreview, mountedPeerFileVersion, tryApplyPeerChanges, tryRefreshParkedPeerScene } from "../player/peerTimingPreview";
import { isPreviewChanging } from "../player/previewReloading";
import { announcePreviewScenesSwapped, notePeerPreviewChange, previewSourceRevision } from "../player/sceneSwap";
import { usePlayerStore } from "../player/store/playerStore";
import { isStudioEditSaving } from "../utils/studioPendingEdits";
import type { RemoteFileRead } from "./remoteFileReads";
import { studioApiFetch } from "../utils/studioApiFetch";
import { buildProjectApiPath } from "../utils/projectRouting";
import { scheduleCommittedPreview } from "../player/committedPreview";
import { isUnrelatedPreviewHtmlChange } from "../player/lib/previewHtmlSources";
import { confirmedSource } from "../utils/confirmedTextSources";

/** A cold observer can compare a mounted child without prefetching every scene on open. */
export async function readMountedSource(projectId: string, version: string) {
  const digest = /^"(?:sha256|patch):([a-f0-9]{64})"$/.exec(version)?.[1];
  if (!digest) return null;
  const response = await studioApiFetch(buildProjectApiPath(projectId, "/history/blob/" + digest));
  if (!response.ok || response.headers.get("etag") !== version) return null;
  const content = await response.text();
  return { content, version };
}

type VersionedFiles = {
  versions: Readonly<Record<string, string | null>> | null;
  treeChanged: boolean;
  refresh: (paths: readonly string[]) => void;
};

/** Project timeline rows immediately while the mounted preview reconciles the changed files. */
export function syncPeerComposition(
  projectId: string, path: string | null, paths: readonly string[] | null,
  read: RemoteFileRead, frameRef: RefObject<HTMLIFrameElement | null>,
  previous: KnownCompositionSource | null, changedVersion?: string, batch?: VersionedFiles,
): Promise<boolean> | undefined {
  const frame = frameRef.current;
  const changed = paths?.length === 1 ? paths[0] : undefined;
  const versions = batch?.versions;
  if (frame && !frame.contentDocument && batch && versions && paths?.length &&
      paths.every(file => /\.html?$/i.test(file) && Object.hasOwn(versions, file))) {
    const affected = paths.filter(file => !isUnrelatedPreviewHtmlChange(frame, projectId, path, [file], batch.treeChanged));
    const changes = affected.map(file => {
      const known = confirmedSource(projectId, file) ?? (file === path ? previous ?? undefined : undefined);
      const version = versions[file] ?? undefined;
      const pinned = mountedPeerFileVersion(frame, file);
      const before = !pinned || known?.version === pinned ? known : undefined;
      return {
        path: file, previous: before, version,
        readPrevious: !before && pinned ? async () => await readMountedSource(projectId, pinned) ?? undefined : undefined,
        read: async () => {
          const result = await read(projectId, file);
          return version && result?.version === version && typeof result.content === "string"
            ? { content: result.content, version } : undefined;
        },
      };
    });
    scheduleCommittedPreview(frame, projectId, changes, batch.refresh);
    syncMountedComposition(projectId, path, paths, read, frameRef, previous, true);
    return Promise.resolve(true);
  }
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
  read: RemoteFileRead, frameRef: RefObject<HTMLIFrameElement | null>, previous: KnownCompositionSource | null, timelineOnly = false,
): Promise<boolean> | undefined {
  const frame = frameRef.current;
  const apply = path && (!paths || paths.includes(path)) && beginPeerTimelineUpdate(projectId, path, frame);
  if (!apply) notePeerPreviewChange();
  const changedPath = paths?.length === 1 ? paths[0] : undefined;
  const liveRoot = frame && (hasPeerTimingDocument(frame) || hasPeerLiveEdit(frame, "position") || hasPeerLiveEdit(frame, "mediaTiming"));
  if (!timelineOnly && frame && hasScriptedStylePreview(frame) && changedPath?.endsWith(".html")) {
    const base = confirmedSource(projectId, changedPath) ?? (changedPath === path ? previous : null);
    const liveChild = changedPath !== path && hasPeerLiveEdit(frame, "position") && !isPreviewChanging();
    const pinned = !base && liveChild ? mountedPeerFileVersion(frame, changedPath) : undefined;
    if (base || pinned) {
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
          if (typeof content !== "string" || !version || !isCurrent() || isPreviewChanging()) return false;
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
  if (timelineOnly || !frame || !liveRoot || paths?.length !== 1 || !previous || isPreviewChanging()) {
    void timeline.catch(() => {});
    return;
  }
  const revision = previewSourceRevision();
  const isCurrent = () => frame === frameRef.current && revision === previewSourceRevision() &&
    usePlayerStore.getState().timelineProjectId === projectId && !isPreviewChanging() && !isStudioEditSaving();
  return timeline.then(async ({ content, version, missing }) => {
    if (missing || !version || typeof content !== "string" || !isCurrent()) return false;
    const applied = await tryApplyPeerChanges(frame, { path, previous, current: { content, version } }, isCurrent, "keep-visible");
    if (applied && isCurrent()) {
      announcePreviewScenesSwapped(frame);
      return true;
    }
    return false;
  });
}
