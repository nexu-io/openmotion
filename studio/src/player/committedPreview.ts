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
  /** Remote receipts carry an exact version even if its source is not open in this tab. */
  version?: string;
  read?: () => Promise<ConfirmedSource | undefined>;
  readPrevious?: () => Promise<ConfirmedSource | undefined>;
}

type Refresh = (paths: readonly string[]) => void;
type Options = { gestureId?: string };
type Change = CommittedPreviewChange & { options?: Options; observedVersion?: string };
type Session = {
  src: string;
  project: string;
  pending: Map<string, Change>;
  running: boolean;
  refresh: Refresh;
};
const sessions = new WeakMap<HTMLIFrameElement, Session>();

async function applyChange(frame: HTMLIFrameElement, change: Change, isCurrent: () => boolean) {
  const { path, options } = change;
  const target = change.current?.version ?? change.version;
  if (!target || !isCurrent()) return false;
  if (mountedPeerFileVersion(frame, path) === target) return true;
  const refreshParked = () => path !== "index.html" && isCurrent() && tryRefreshParkedPeerScene(frame, path, target, isCurrent);
  // A parked scene can adopt the new version without downloading its source into Studio.
  if (!change.previous && await refreshParked()) return true;
  if ((change.previous || change.readPrevious) &&
      (hasPeerTimingDocument(frame) || hasPeerLiveEdit(frame, "mediaTiming") || hasPeerLiveEdit(frame, "position"))) {
    const [previous, current] = await Promise.all([
      change.previous ?? change.readPrevious?.(), change.current ?? change.read?.(),
    ]);
    if (previous && current?.version === target && isCurrent()) {
      const edit = { path, previous, current };
      const applied = options ? await tryApplyPeerChanges(frame, edit, isCurrent, options)
        : await tryApplyPeerChanges(frame, edit, isCurrent);
      if (applied) return true;
    }
  }
  return !!change.previous && refreshParked();
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
    const current = () => {
      if (!owns() || busy(frame) || isPreviewChanging()) return false;
      const version = confirmedSource(session.project, change.path)?.version;
      if (change.version) return !version || version === change.version || version === change.observedVersion;
      return version === change.current?.version;
    };
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
    let previous = change.previous;
    if (prior) {
      const priorTarget = prior.current?.version ?? prior.version;
      const joins = previous && (previous.version === priorTarget || previous.version === prior.previous?.version);
      previous = joins ? prior.previous : undefined;
    }
    const observedVersion = change.version ? confirmedSource(project, change.path)?.version : undefined;
    session.pending.set(change.path, { ...change, previous, observedVersion, options });
  }
  schedule(frame, session);
}
