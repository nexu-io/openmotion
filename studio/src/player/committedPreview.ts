import { afterStudioManualEditGestures } from "../components/editor/manualEditsDom";
import { STUDIO_MANUAL_EDIT_GESTURE_ATTR } from "../components/editor/manualEditsTypes";
import { confirmedSource, type ConfirmedSource } from "../utils/confirmedTextSources";
import { afterStudioPendingEdits, isStudioEditSaving } from "../utils/studioPendingEdits";
import { hasPeerLiveEdit, hasPeerTimingDocument, mountedPeerFileVersion, refreshPeerScenes, tryApplyPeerChanges, tryRefreshParkedPeerScene } from "./peerTimingPreview";
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
  sent: Map<string, ConfirmedSource>;
  running: boolean;
  refresh: Refresh;
};
const sessions = new WeakMap<HTMLIFrameElement, Session>();

async function applyChange(frame: HTMLIFrameElement, change: Change, sent: Session["sent"], isCurrent: () => boolean, deferSceneRefresh: boolean) {
  const { path, options } = change;
  const target = change.current?.version ?? change.version;
  if (!target || !isCurrent()) return false;
  const mounted = mountedPeerFileVersion(frame, path);
  if (mounted === target) return true;
  // An older receipt can arrive after its successor was queued. Reuse that intermediate
  // source only when the iframe confirms it is what the user is actually seeing.
  const last = sent.get(path);
  const base = last && last.version === mounted ? last : change.previous;
  const refreshParked = (parkedOnly = false) => !deferSceneRefresh && path !== "index.html" && isCurrent() && tryRefreshParkedPeerScene(frame, path, target, isCurrent, parkedOnly);
  // A parked scene can adopt the new version without downloading its source into Studio.
  if (!base) {
    if (!change.readPrevious) return refreshParked();
    if (await refreshParked(true)) return true;
  }
  // A mounted child can accept a verified CSS box edit without a template capability.
  // The two sources are already here, so checking the delta needs no network read.
  const knownMountedChange = change.current && mounted && base?.version === mounted;
  if ((base || change.readPrevious) &&
      (hasPeerTimingDocument(frame) || knownMountedChange || hasPeerLiveEdit(frame, "presentation") || hasPeerLiveEdit(frame, "mediaTiming") || hasPeerLiveEdit(frame, "position"))) {
    const [previous, current] = await Promise.all([
      base ?? change.readPrevious?.(), change.current ?? change.read?.(),
    ]);
    if (previous && current?.version === target && isCurrent()) {
      const edit = { path, previous, current };
      sent.set(path, current);
      const applied = options ? await tryApplyPeerChanges(frame, edit, isCurrent, options)
        : await tryApplyPeerChanges(frame, edit, isCurrent);
      if (applied) return true;
    }
  }
  return refreshParked();
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
  const pending = [...session.pending.values()];
  const batchScenes = pending.length > 1 && pending.every(change => change.path !== "index.html" && (change.current?.version || change.version));
  for (const change of pending) {
    const owns = () => mounted() && session.pending.get(change.path) === change;
    if (!mounted() || busy(frame)) break;
    const current = () => {
      if (!owns() || busy(frame) || isPreviewChanging()) return false;
      const version = confirmedSource(session.project, change.path)?.version;
      if (change.version) return !version || version === change.version || version === change.observedVersion;
      return !version || version === change.current?.version;
    };
    const done = await applyChange(frame, change, session.sent, current, batchScenes).catch(() => false);
    // A later input/receipt owns the same pixels, even if this bridge response was successful.
    if (!owns() || busy(frame)) continue;
    if (done && current()) applied.push(change);
    else retry.push(change);
  }
  if (batchScenes && retry.length) {
    const current = () => mounted() && !busy(frame) && !isPreviewChanging() &&
      retry.every(change => session.pending.get(change.path) === change);
    const files = retry.map((change): [string, string] => [change.path, (change.current?.version ?? change.version)!]);
    if (current() && await refreshPeerScenes(frame, files, current).catch(() => false)) applied.push(...retry.splice(0));
  }
  if (!mounted()) {
    if (sessions.get(frame) === session) sessions.delete(frame);
    return;
  }
  if (!busy(frame)) {
    const settled = applied.filter(change => session.pending.get(change.path) === change);
    for (const change of settled) {
      session.pending.delete(change.path);
      session.sent.delete(change.path);
    }
    if (settled.length) announcePreviewScenesSwapped(frame);
    const paths = retry.filter(change => session.pending.get(change.path) === change).map(change => change.path);
    for (const path of paths) {
      session.pending.delete(path);
      session.sent.delete(path);
    }
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
    session = { project, src: frame.src, pending: new Map(), sent: new Map(), running: false, refresh };
    sessions.set(frame, session);
  }
  session.refresh = refresh;
  for (const change of changes) {
    const prior = session.pending.get(change.path);
    const target = change.current?.version ?? change.version;
    const priorTarget = prior?.current?.version ?? prior?.version;
    if (prior && target && priorTarget === target) {
      // A save receipt and a project event can describe the same immutable file.
      // Keep an in-flight paint unless the new notice provides something it actually lacks.
      const previous = (prior.previous?.version === target ? undefined : prior.previous) ?? change.previous;
      const addsSource = (!prior.current && change.current) || (previous && previous !== prior.previous);
      const addsReader = (!prior.current && !prior.read && change.read) ||
        (!prior.previous && !prior.readPrevious && change.readPrevious);
      if (addsSource || addsReader || (!prior.options && options)) {
        session.pending.set(change.path, { ...prior,
          previous, current: prior.current ?? change.current,
          read: prior.read ?? change.read, readPrevious: prior.readPrevious ?? change.readPrevious,
          options: prior.options ?? options,
        });
      }
      continue;
    }
    // Preserve a verified chain all the way from the mounted document. A missing link needs scene recovery.
    let previous = change.previous;
    if (prior) {
      const joins = previous && (previous.version === priorTarget || previous.version === prior.previous?.version);
      previous = joins ? prior.previous : undefined;
    }
    const observedVersion = change.version ? confirmedSource(project, change.path)?.version : undefined;
    session.pending.set(change.path, { ...change, previous, observedVersion, options });
  }
  schedule(frame, session);
}
