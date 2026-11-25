import { studioManualEditGestureFiles, subscribeStudioGestureRelease } from "../components/editor/manualEditsDom";
import { STUDIO_MANUAL_EDIT_GESTURE_ATTR } from "../components/editor/manualEditsTypes";
import { confirmedSource, type ConfirmedSource } from "../utils/confirmedTextSources";
import { isStudioEditSaving, studioPendingEditBlocks, subscribeStudioEditSaving } from "../utils/studioPendingEdits";
import { applyCommittedPeerChanges, hasPeerLiveEdit, hasPeerTimingDocument, mountedPeerFileVersion, refreshPeerScenes, tryRefreshParkedPeerScene, type PeerApplyOutcome } from "./peerTimingPreview";
import { areIndependentPreviewFiles } from "./lib/previewHtmlSources";
import { previewDocumentIdentity } from "./lib/previewAdapter";
import { isPreviewChanging } from "./previewReloading";
import { announcePreviewScenesSwapped } from "./sceneSwap";
import { usePlayerStore } from "./store/playerStore";

export interface CommittedPreviewChange {
  path: string;
  previous?: ConfirmedSource;
  current?: ConfirmedSource;
  /** Remote receipts carry an exact version even if its source is not open in this tab. */
  version?: string;
  treeChanged?: boolean;
  read?: () => Promise<ConfirmedSource | undefined>;
  readPrevious?: () => Promise<ConfirmedSource | undefined>;
}

type Refresh = (paths: readonly string[]) => void;
type Options = { gestureId?: string };
type Change = CommittedPreviewChange & { options?: Options; observedVersion?: string; recovery?: "scene" | "document" };
type Session = {
  src: string;
  documentId?: string;
  project: string;
  pending: Map<string, Change>;
  sent: Map<string, ConfirmedSource>;
  running: boolean;
  stopWaiting?: () => void;
  refresh: Refresh;
};
const sessions = new WeakMap<HTMLIFrameElement, Session>();

async function applyChange(frame: HTMLIFrameElement, change: Change, sent: Session["sent"], isCurrent: () => boolean, tryParked: boolean): Promise<PeerApplyOutcome> {
  const { path, options } = change;
  const target = change.current?.version ?? change.version;
  if (!target) return "requires-scene-rebuild";
  if (!isCurrent()) return "superseded";
  const mounted = mountedPeerFileVersion(frame, path);
  if (mounted === target) return "applied";
  // An older receipt can arrive after its successor was queued. Reuse that intermediate
  // source only when the iframe confirms it is what the user is actually seeing.
  const last = sent.get(path);
  const base = last && last.version === mounted ? last : change.previous;
  // A parked scene can adopt the new version without downloading its source into Studio.
  if (!base && change.readPrevious && tryParked && path !== "index.html") {
    const sceneCurrent = () => isCurrent() && !busy(frame);
    if (sceneCurrent() && await tryRefreshParkedPeerScene(frame, path, target, sceneCurrent, true)) return "applied";
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
      return options ? applyCommittedPeerChanges(frame, edit, isCurrent, options)
        : applyCommittedPeerChanges(frame, edit, isCurrent);
    }
  }
  return "requires-scene-rebuild";
}

// Isolated canvas drags and inline text hold the iframe from pointer-down through commit handoff.
function busy(frame: HTMLIFrameElement) {
  return frame.hasAttribute(STUDIO_MANUAL_EDIT_GESTURE_ATTR) || isStudioEditSaving();
}

/** Only a pinned, disjoint scene revision may attempt an in-place paint during local input. */
export function canPresentDuringStudioEdit(frame: HTMLIFrameElement, project: string, path: string) {
  const independent = (paths?: readonly string[]) => areIndependentPreviewFiles(frame, project, path, paths);
  return busy(frame) && !!mountedPeerFileVersion(frame, path) &&
    (!frame.hasAttribute(STUDIO_MANUAL_EDIT_GESTURE_ATTR) || independent(studioManualEditGestureFiles(frame))) &&
    !studioPendingEditBlocks(scope => scope.frame === frame && independent(scope.paths));
}

function canAttempt(frame: HTMLIFrameElement, session: Session, change: Change) {
  if (!busy(frame)) return true;
  if (change.recovery || !change.version || !canPresentDuringStudioEdit(frame, session.project, change.path)) return false;
  // The certificate describes the mounted tree. A pending root, deletion or tree change
  // invalidates that proof for its siblings even if their own filenames did not change.
  return ![...session.pending.values()].some(file => file.treeChanged || file.path === "index.html" ||
    !/\.html?$/i.test(file.path) || !(file.current?.version || file.version));
}

function matchesConfirmedVersion(project: string, change: Change) {
  const version = confirmedSource(project, change.path)?.version;
  if (change.version) return !version || version === change.version || version === change.observedVersion;
  return !version || version === change.current?.version;
}

async function present(frame: HTMLIFrameElement, session: Session) {
  const mounted = () => sessions.get(frame) === session && frame.isConnected && frame.src === session.src &&
    (!session.documentId || previewDocumentIdentity(frame) === session.documentId) &&
    usePlayerStore.getState().timelineProjectId === session.project;
  const applied: Change[] = [];
  const ownsPath = (change: Change) => session.pending.get(change.path) === change;
  const remove = (change: Change) => { session.pending.delete(change.path); session.sent.delete(change.path); };
  const pending = [...session.pending.values()];
  for (const change of pending) {
    const owns = () => mounted() && ownsPath(change);
    if (!owns() || change.recovery || !canAttempt(frame, session, change)) continue;
    const current = () => owns() && canAttempt(frame, session, change) && !isPreviewChanging() && matchesConfirmedVersion(session.project, change);
    const outcome = current() ? await applyChange(frame, change, session.sent, current, pending.length === 1).catch(() => "unconfirmed" as const) : "superseded";
    if (!owns() || !canAttempt(frame, session, change)) continue;
    if (!current()) change.recovery = "document"; // Recover latest project state, not this stale revision.
    else if (outcome === "applied") applied.push(change);
    else if (outcome === "superseded") remove(change); // A successor owns this mount; don't recover the old paint.
    else change.recovery = outcome === "requires-scene-rebuild" ? "scene" : "document";
  }
  // A scene rebuild may incorporate other files. Never start it over a local draft.
  const recover = pending.filter(change => ownsPath(change) && change.recovery === "scene");
  const scenes = recover.filter(change => change.path !== "index.html" && (change.current?.version || change.version) && matchesConfirmedVersion(session.project, change));
  const sceneCurrent = () => mounted() && !busy(frame) && !isPreviewChanging() &&
    scenes.every(change => ownsPath(change) && matchesConfirmedVersion(session.project, change));
  if (scenes.length && sceneCurrent()) {
    const files = scenes.map((change): [string, string] => [change.path, (change.current?.version ?? change.version)!]);
    const rebuilt = files.length === 1 && pending.length === 1
      ? tryRefreshParkedPeerScene(frame, files[0]![0], files[0]![1], sceneCurrent)
      : refreshPeerScenes(frame, files, sceneCurrent);
    if (await Promise.resolve(rebuilt).catch(() => false) && sceneCurrent()) applied.push(...scenes);
  }
  if (!mounted()) {
    if (sessions.get(frame) === session) sessions.delete(frame);
    return;
  }
  const shown = applied.filter(change => ownsPath(change) && canAttempt(frame, session, change));
  shown.forEach(remove);
  if (shown.length) announcePreviewScenesSwapped(frame);
  if (!busy(frame)) {
    const failed = pending.filter(change => ownsPath(change) && change.recovery);
    failed.forEach(remove);
    if (failed.length) session.refresh(failed.map(change => change.path));
  }
  session.running = false;
  if (session.pending.size) {
    if ([...session.pending.values()].some(change => canAttempt(frame, session, change))) schedule(frame, session);
    else {
      const wake = () => schedule(frame, session);
      const stopSaving = subscribeStudioEditSaving(wake);
      const stopGestures = subscribeStudioGestureRelease(frame.ownerDocument, wake);
      session.stopWaiting = () => { stopSaving(); stopGestures(); };
    }
  }
  else if (sessions.get(frame) === session) sessions.delete(frame);
}

function schedule(frame: HTMLIFrameElement, session: Session) {
  session.stopWaiting?.();
  session.stopWaiting = undefined;
  if (session.running) return;
  session.running = true;
  queueMicrotask(() => { void present(frame, session); });
}

/** Reconcile durable sources with this window's mounted player. Saving never waits for a paint reply. */
export function scheduleCommittedPreview(
  frame: HTMLIFrameElement, project: string, changes: readonly CommittedPreviewChange[], refresh: Refresh, options?: Options,
) {
  if (!changes.length) return;
  let session = sessions.get(frame);
  const documentId = previewDocumentIdentity(frame);
  if (!session || session.project !== project || session.src !== frame.src || session.documentId !== documentId) {
    session?.stopWaiting?.();
    session = { project, src: frame.src, documentId, pending: new Map(), sent: new Map(), running: false, refresh };
    sessions.set(frame, session);
  }
  session.refresh = refresh;
  for (const change of changes) {
    const prior = session.pending.get(change.path);
    const target = change.current?.version ?? change.version;
    const priorTarget = prior?.current?.version ?? prior?.version;
    // The queued revision already includes this local receipt. Keep its peer update and reader.
    if (priorTarget && change.current && !change.version && target !== priorTarget &&
        prior?.previous?.version === target && confirmedSource(project, change.path)?.version === priorTarget) continue;
    if (prior && target && priorTarget === target) {
      // A save receipt and a project event can describe the same immutable file.
      // Keep an in-flight paint unless the new notice provides something it actually lacks.
      const previous = (prior.previous?.version === target ? undefined : prior.previous) ?? change.previous;
      const addsSource = (!prior.current && change.current) || (previous && previous !== prior.previous);
      const addsReader = (!prior.current && !prior.read && change.read) ||
        (!prior.previous && !prior.readPrevious && change.readPrevious);
      if (addsSource || addsReader || (!prior.options && options) || (change.treeChanged && !prior.treeChanged)) {
        session.pending.set(change.path, { ...prior,
          previous, current: prior.current ?? change.current,
          read: prior.read ?? change.read, readPrevious: prior.readPrevious ?? change.readPrevious,
          options: prior.options ?? options, recovery: undefined, treeChanged: prior.treeChanged || change.treeChanged,
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
