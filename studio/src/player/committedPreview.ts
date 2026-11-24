import { afterStudioManualEditGestures } from "../components/editor/manualEditsDom";
import { STUDIO_MANUAL_EDIT_GESTURE_ATTR } from "../components/editor/manualEditsTypes";
import { confirmedSource, type ConfirmedSource } from "../utils/confirmedTextSources";
import { afterStudioPendingEdits, isStudioEditSaving } from "../utils/studioPendingEdits";
import { hasPeerLiveEdit, hasPeerTimingDocument, mountedPeerFileVersion, tryApplyPeerChanges, tryRefreshParkedPeerScene } from "./peerTimingPreview";
import { isPreviewChanging } from "./previewReloading";
import { announcePreviewScenesSwapped } from "./sceneSwap";
import { usePlayerStore } from "./store/playerStore";

export interface CommittedPreviewChange {
  path: string;
  previous?: ConfirmedSource;
  current?: ConfirmedSource;
}

type Refresh = (paths: readonly string[]) => void;
type Options = { gestureId?: string };
type Change = CommittedPreviewChange & { options?: Options };
type Session = {
  src: string;
  project: string;
  pending: Map<string, Change>;
  running: boolean;
  refresh: Refresh;
};
const sessions = new WeakMap<HTMLIFrameElement, Session>();

async function applyChange(frame: HTMLIFrameElement, change: Change, isCurrent: () => boolean) {
  const {path, previous, current, options} = change;
  if (!current || !isCurrent()) return false;
  if (mountedPeerFileVersion(frame, path) === current.version) return true;
  if (previous && (hasPeerTimingDocument(frame) || hasPeerLiveEdit(frame, "mediaTiming") || hasPeerLiveEdit(frame, "position"))) {
    const edit = {path, previous, current};
    if (options ? await tryApplyPeerChanges(frame, edit, isCurrent, options) : await tryApplyPeerChanges(frame, edit, isCurrent)) return true;
  }
  return path !== "index.html" && isCurrent() && tryRefreshParkedPeerScene(frame, path, current.version, isCurrent);
}

// Isolated canvas drags and inline text hold the iframe from pointer-down through commit handoff.
function busy(frame: HTMLIFrameElement) {
  return frame.hasAttribute(STUDIO_MANUAL_EDIT_GESTURE_ATTR) || isStudioEditSaving();
}

async function present(frame: HTMLIFrameElement, session: Session) {
  const mounted = () => sessions.get(frame) === session && frame.isConnected && frame.src === session.src &&
    usePlayerStore.getState().timelineProjectId === session.project;
  const retry: Change[] = [];
  const applied: Change[] = [];
  for (const change of [...session.pending.values()]) {
    const owns = () => mounted() && session.pending.get(change.path) === change;
    if (!mounted() || busy(frame)) break;
    const latest = () => confirmedSource(session.project, change.path);
    const current = () => owns() && !busy(frame) && !isPreviewChanging() && latest()?.version === change.current?.version;
    const done = await applyChange(frame, change, current).catch(() => false);
    // A later input/receipt owns the same pixels, even if this bridge response was successful.
    if (!owns() || busy(frame)) continue;
    if (done && current()) applied.push(change);
    else retry.push(change);
  }
  if (!mounted()) {
    if (sessions.get(frame) === session) sessions.delete(frame);
    return;
  }
  if (!busy(frame)) {
    const settled = applied.filter(change => session.pending.get(change.path) === change);
    for (const change of settled) session.pending.delete(change.path);
    if (settled.length) announcePreviewScenesSwapped(frame);
    const paths = retry.filter(change => session.pending.get(change.path) === change).map(change => change.path);
    for (const path of paths) session.pending.delete(path);
    if (paths.length) session.refresh(paths);
  }
  session.running = false;
  if (session.pending.size) schedule(frame, session);
  else if (sessions.get(frame) === session) sessions.delete(frame);
}

function schedule(frame: HTMLIFrameElement, session: Session) {
  if (session.running) return;
  session.running = true;
  const ready = () => afterStudioPendingEdits(() => {
    if (frame.isConnected && frame.hasAttribute(STUDIO_MANUAL_EDIT_GESTURE_ATTR)) {
      afterStudioManualEditGestures(frame.ownerDocument, ready);
    } else {
      void present(frame, session);
    }
  });
  queueMicrotask(ready);
}

/** Reconcile durable sources with this window's mounted player. Saving never waits for a paint reply. */
export function scheduleCommittedPreview(
  frame: HTMLIFrameElement, project: string, changes: readonly CommittedPreviewChange[], refresh: Refresh, options?: Options,
) {
  if (!changes.length) return;
  let session = sessions.get(frame);
  if (!session || session.project !== project || session.src !== frame.src) {
    session = { project, src: frame.src, pending: new Map(), running: false, refresh };
    sessions.set(frame, session);
  }
  session.refresh = refresh;
  for (const change of changes) {
    const prior = session.pending.get(change.path);
    // Preserve a verified chain all the way from the mounted document. A missing link needs scene recovery.
    const joins = prior?.current?.version === change.previous?.version || prior?.previous?.version === change.previous?.version;
    session.pending.set(change.path, { ...change, previous: prior ? joins ? prior.previous : undefined : change.previous, options });
  }
  schedule(frame, session);
}
