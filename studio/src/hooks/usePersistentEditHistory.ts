import { computePreviewImpact } from "../../../shared/preview-impact";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HistoryListItem, HistoryResult } from "@hyperframes/studio-server";
import { studioFileContentVersion, studioWriteHeaders } from "../utils/studioFileVersion";
import type { RestoreFiles } from "../utils/gsapUndoRestore";
import { getCachedCloudDisklessMode } from "../utils/cloudRuntime";
import { studioApiFetch } from "../utils/studioApiFetch";
import { setStudioPendingEditClaimClock } from "../utils/studioPendingEdits";
import type { RecordEditInput } from "../utils/studioFileHistory";
import { generateId } from "../utils/generateId";
import { reportManualEdit, setTrackedProject, watchEditSurface } from "../motion/editorTracking";
import { studioEditLifecycle } from "../webmcp/writeCoordinator";
import { observeStudioSavedAt } from "../utils/studioSaveState";
import { confirmedSource, forgetSource } from "../utils/confirmedTextSources";
import { forgetFileEditChain, retireFileEditChain } from "../utils/isolatedEditVersions";
import { CloudEditHistory, confirmCloudRestore, watchCloudEditHistory } from "../utils/cloudEditHistory";
import type { HistoryStepGuard } from "../../../shared/ordered-text-edits";
import { reconcileFileEdit } from "../utils/rebasedFileEdit";

interface ApplyCallbacks {
  readFile: (path: string) => Promise<string>;
  serialize?: <T>(paths: readonly string[], task: () => Promise<T>) => Promise<T>;
  claimedAfter?: number;
  predictedId?: string;
  pendingUndoId?: string;
  guard?: HistoryStepGuard;
  onSuperseded?: (paths?: readonly string[]) => void;
}

export interface UsePersistentEditHistoryOptions {
  projectId: string | null;
}

interface ApplyResult {
  ok: boolean;
  /** content-mismatch: `paths` changed after the step's entry. failed: `message` says why. */
  reason?: "empty" | "content-mismatch" | "failed";
  message?: string;
  label?: string;
  paths?: string[];
  undoes?: string;
  files?: RestoreFiles;
  reconcilePaths?: string[];
}

interface NextStep {
  id: string;
  versionId?: string;
  targetVersionId?: string;
  targetRevision?: string;
  label: string;
  endedAt: number;
  paths: string[];
}

interface HistoryView {
  supportsGuardedSteps?: boolean;
  currentVersionId?: string | null;
  revision?: string;
  lastSavedAt?: number;
  currentSeq?: number; // Present on the cloud snapshot-based timeline.
  entries: Array<Pick<HistoryListItem, "id" | "undoes"> & { endedAt: number | string }>;
  back: NextStep | null;
  forward: NextStep | null;
}

const EMPTY: HistoryView = { entries: [], back: null, forward: null };
type BlockedSteps = Partial<Record<"undo" | "redo", NextStep>>;
const sameStep = (a: NextStep | undefined, b: NextStep | null) =>
  Boolean(a && b && a.id === b.id && a.endedAt === b.endedAt);
/** ponytail: the newest entries' content is kept; older ones step through the server only. */
const OWN_ENTRIES_KEPT = 100;

type OwnFiles = Record<string, { before: string; after: string }>;

function createOwnHistory() {
  const own = new Map<string, OwnFiles>();
  let next: Record<"undo" | "redo", NextStep | null> | null = null;
  let changes = 0;
  let claimed = { count: 0, id: "" };
  const undoneIds = new Set<string>();
  const remember = (id: string, files: OwnFiles) => {
    const known = own.get(id) ?? {};
    for (const [path, { before, after }] of Object.entries(files)) {
      known[path] = { before: known[path]?.before ?? before, after };
    }
    own.delete(id);
    own.set(id, known);
    if (own.size > OWN_ENTRIES_KEPT) own.delete(own.keys().next().value!);
  };
  return {
    remember,
    overtake: () => {
      changes += 1;
      next = null;
      return changes;
    },
    offered: (seen: number, view: HistoryView) => {
      if (seen === changes) next = { undo: view.back, redo: view.forward };
    },
    changes: () => changes,
    claimCount: () => claimed.count,
    claimedAfter: (count: number) => (claimed.count > count && claimed.id ? claimed.id : null),
    targetFor: (id: string | null, pressedAt: number) =>
      !id || !undoneIds.has(id) ? id : claimed.count > pressedAt ? false : null,
    noteClaim: (id: string) => {
      claimed = { count: claimed.count + 1, id };
    },
    stepped: (entry: { id: string; undoes?: string }) => {
      if (entry.undoes) undoneIds.add(entry.undoes);
      if (undoneIds.size > OWN_ENTRIES_KEPT) undoneIds.delete(undoneIds.values().next().value!);
      const undone = entry.undoes ? own.get(entry.undoes) : undefined;
      if (!undone) return;
      const swapped = Object.entries(undone).map(([path, f]) => [
        path,
        { before: f.after, after: f.before },
      ]);
      remember(entry.id, Object.fromEntries(swapped));
    },
    afterOf: (id: string | undefined): Record<string, string> =>
      Object.fromEntries(Object.entries((id && own.get(id)) || {}).map(([p, f]) => [p, f.after])),
    predict: (direction: "undo" | "redo"): { id: string; files: RestoreFiles } | null => {
      const step = next?.[direction];
      const files = step ? own.get(step.id) : undefined;
      const paths = files ? Object.keys(files) : [];
      if (
        !files ||
        paths.length !== step!.paths.length ||
        !paths.every((p) => step!.paths.includes(p))
      )
        return null;
      const restore = paths.map((path) => [
        path,
        { previous: files[path]!.after, restored: files[path]!.before },
      ]);
      return { id: step!.id, files: Object.fromEntries(restore) };
    },
    clear: () => {
      own.clear();
      undoneIds.clear();
      next = null;
      changes += 1;
    },
  };
}
const DEFAULT_COALESCE_MS = 300;

function historyUrl(projectId: string, path = ""): string {
  return `/api/projects/${encodeURIComponent(projectId)}/history${path}`;
}

async function cantUndo(paths: string[] | undefined): Promise<ApplyResult> {
  return { ok: false, reason: "content-mismatch", paths: paths ?? [] };
}

function unionPaths(...lists: Array<readonly string[] | undefined>): string[] {
  return [...new Set(lists.flatMap((list) => list ?? []))];
}

async function post(
  url: string,
  body: object,
  headers: Record<string, string> = {},
): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
  const response = await studioApiFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!response) return { ok: false, status: 0, error: "Studio could not reach its server." };
  const reply = (await response.json().catch(() => null)) as { error?: string } | null;
  if (response.ok && reply) return { ok: true, body: reply };
  if (response.ok)
    return { ok: false, status: response.status, error: "The history's reply was unreadable." };
  return { ok: false, status: response.status, error: reply?.error ?? `HTTP ${response.status}` };
}

/** The entry id a claim took, or null; a failed one is logged (its write lands as an outside change; 404: none). */
function claimHeld(reply: Awaited<ReturnType<typeof post>>, label: string): string | null {
  if (reply.ok)
    return (reply.body as { claimed: { id: string } | null } | null)?.claimed?.id ?? null;
  if (reply.status !== 404)
    console.error(
      `[history] ${reply.status}: "${label}" was not recorded as your edit: ${reply.error}`,
    );
  return null;
}

async function overwroteVersions(files: RecordEditInput["files"]): Promise<Record<string, string>> {
  const pairs = await Promise.all(
    Object.entries(files).map(async ([path, { before }]) => [
      path,
      await studioFileContentVersion(before),
    ]),
  );
  return Object.fromEntries(pairs);
}

async function readAll(
  paths: readonly string[],
  readFile: (path: string) => Promise<string>,
): Promise<Record<string, string> | null> {
  const contents = await Promise.all(paths.map(async path => [path, await readFile(path).catch(() => null)] as const));
  return contents.some(([, content]) => content === null) ? null : Object.fromEntries(contents) as Record<string, string>;
}

async function restoredFiles(
  paths: readonly string[],
  previous: Record<string, string> | null,
  readFile: (path: string) => Promise<string>,
): Promise<RestoreFiles | undefined> {
  if (!previous || paths.some((path) => !(path in previous))) return undefined;
  const restored = await readAll(paths, readFile);
  if (!restored) return undefined;
  return Object.fromEntries(
    paths.map((path) => [path, { previous: previous[path]!, restored: restored[path]! }]),
  );
}

function timestamp(value: number | string): number {
  return typeof value === "number" ? value : Date.parse(value);
}

function redoneAt(view: HistoryView): number | null {
  if (view.currentSeq !== undefined) return view.forward?.endedAt ?? null;
  const undo = view.entries.find((entry) => entry.id === view.forward?.id);
  const original = view.entries.find((entry) => entry.id === undo?.undoes);
  return original ? timestamp(original.endedAt) : null;
}

/** Cloud history steps the project head. Legacy file histories can target a claimed local edit. */
export function usePersistentEditHistory({ projectId }: UsePersistentEditHistoryOptions) {
  const [view, setView] = useState<HistoryView>(EMPTY);
  const viewRef = useRef(view);
  const projectWide = view.currentSeq !== undefined || getCachedCloudDisklessMode();
  const [loaded, setLoaded] = useState(false);
  const [blocked, setBlocked] = useState<BlockedSteps>({});
  // Update synchronously too: a repeated shortcut may arrive before React renders.
  const blockedRef = useRef<BlockedSteps>({});
  // A coalescing claim the server just took, until `refresh()` brings its entry into `view`.
  const heldClaimRef = useRef<{ paths: string[]; at: number } | null>(null);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const [own] = useState(createOwnHistory);
  const cloudHistory = useMemo(() => new CloudEditHistory(projectId ?? ""), [projectId]);
  useEffect(() => projectId ? watchCloudEditHistory(projectId, cloudHistory) : undefined, [projectId, cloudHistory]);
  const [pageKeyScope] = useState(generateId);
  const claimKey = useCallback((key: string) => `${pageKeyScope}:${key}`, [pageKeyScope]);

  const historyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastStepToken = useRef<string | null>(null);
  const uncertainSteps = useMemo(() => new Map<string, string[]>(), [projectId]);
  const superseded = useRef<ApplyCallbacks['onSuperseded']>(undefined);
  const readSequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!projectId || projectIdRef.current !== projectId) return;
    // This read covers events already received. An event arriving during the read
    // still schedules its own refresh, so a concurrent remote edit cannot be lost.
    clearTimeout(historyTimer.current);
    const sequence = ++readSequence.current;
    const seen = own.changes();
    const clock = cloudHistory.clock;
    const cloud = getCachedCloudDisklessMode() || viewRef.current.currentSeq !== undefined;
    const response = await studioApiFetch(historyUrl(projectId, cloud ? "?view=navigation" : "")).catch(() => null);
    const next = response?.ok
      ? ((await response.json().catch(() => null)) as HistoryView | null)
      : EMPTY;
    if (sequence !== readSequence.current || projectIdRef.current !== projectId || clock !== cloudHistory.clock) return;
    if (!next) return console.error("The history's reply was unreadable.");
    observeStudioSavedAt(projectId, next.lastSavedAt ?? Math.max(0, ...next.entries.map(entry => timestamp(entry.endedAt))));
    viewRef.current = next;
    setView(next);
    own.offered(seen, next);
    cloudHistory.offered(next);
    return next;
  }, [projectId, own, cloudHistory]);

  useEffect(() => {
    viewRef.current = EMPTY;
    setView(EMPTY);
    setLoaded(false);
    blockedRef.current = {};
    setBlocked({});
    heldClaimRef.current = null;
    own.clear();
    void refresh().finally(() => setLoaded(true));
  }, [refresh, own]);

  useEffect(watchEditSurface, []);
  useEffect(() => {
    setTrackedProject(projectId);
    return () => setTrackedProject(null);
  }, [projectId]);

  useEffect(() => {
    setStudioPendingEditClaimClock(own.claimCount);
    return () => setStudioPendingEditClaimClock(null);
  }, [own]);

  // A single cloud commit can deliver both a file event and a history event.
  useEffect(() => () => clearTimeout(historyTimer.current), [projectId]);
  const scheduleRefresh = useCallback(() => {
    clearTimeout(historyTimer.current);
    historyTimer.current = setTimeout(() => void refresh(), 75);
  }, [refresh]);
  const refreshAfterEvent = useCallback((writeToken?: string, changedPaths?: readonly string[]) => {
    const uncertain = writeToken && uncertainSteps.get(writeToken);
    if (uncertain && projectId) {
      uncertainSteps.delete(writeToken!);
      for (const path of uncertain) reconcileFileEdit(projectId, path);
      scheduleRefresh();
      return;
    }
    if (writeToken && writeToken === lastStepToken.current) return;
    if (!cloudHistory.owns(writeToken)) {
      cloudHistory.clear();
      const release = superseded.current;
      superseded.current = undefined;
      release?.(changedPaths);
    }
    scheduleRefresh();
  }, [cloudHistory, scheduleRefresh, uncertainSteps, projectId]);

  const recordEdit = useCallback(
    async ({ label, coalesceKey, coalesceMs, files, targets, created = [] }: RecordEditInput) => {
      if (!projectId) return;
      const paths = [...Object.keys(files), ...created];
      // Read before the first await: an Agent tool's write is dispatching (or dispatched and still
      // saving) when its commit records here, and that is not a manual edit.
      const agentPhase = studioEditLifecycle.getSnapshot().phase;
      const agent = agentPhase === "dispatching" || agentPhase === "dispatched";
      own.overtake();
      if (projectWide) {
        reportManualEdit({ projectId, label, entryId: null, coalesceKey, coalesceMs, agent });
        scheduleRefresh();
        return;
      }
      const reply = await post(historyUrl(projectId, "/claim"), {
        label,
        paths,
        ...(targets?.length && { targets }),
        overwrote: await overwroteVersions(files),
        ...(coalesceKey && {
          coalesceKey: claimKey(coalesceKey),
          idleMs: coalesceMs ?? DEFAULT_COALESCE_MS,
        }),
      });
      const claimed = claimHeld(reply, label);
      // The files are already written; one event per history entry, not per coalesced claim.
      reportManualEdit({ projectId, label, entryId: claimed, coalesceKey, coalesceMs, agent });
      if (claimed) {
        own.remember(claimed, files);
        own.noteClaim(claimed);
      }
      heldClaimRef.current = claimed && coalesceKey ? { paths, at: Date.now() } : null;
      await refresh();
    },
    [projectId, projectWide, refresh, scheduleRefresh, own, claimKey],
  );

  const guard = useCallback((direction: "undo" | "redo"): HistoryStepGuard | undefined => {
    const current = viewRef.current;
    const next = direction === "undo" ? current.back : current.forward;
    if (current.currentVersionId && current.revision && next?.targetVersionId && next.targetRevision) {
      return { expectedVersionId: current.currentVersionId, expectedRevision: current.revision,
        expectedTargetVersionId: next.targetVersionId, expectedTargetRevision: next.targetRevision };
    }
  }, []);

  const watchSuperseded = useCallback((listener: NonNullable<ApplyCallbacks['onSuperseded']>) => {
    superseded.current = listener;
    return () => { if (superseded.current === listener) superseded.current = undefined; };
  }, []);

  const step = useCallback(
    async (direction: "undo" | "redo", callbacks: ApplyCallbacks): Promise<ApplyResult> => {
      if (!projectId) return { ok: false, reason: "empty" };
      const candidate =
        !projectWide && direction === "undo" && callbacks.claimedAfter !== undefined
          ? own.claimedAfter(callbacks.claimedAfter)
          : null;
      const next = direction === "undo" ? viewRef.current.back : viewRef.current.forward;
      if (sameStep(blockedRef.current[direction], next) && (!candidate || candidate === next?.id)) {
        return { ok: false, reason: "empty" };
      }
      const expectedId = projectWide ? callbacks.predictedId : undefined;
      const intentId = projectWide && direction === 'undo' ? callbacks.pendingUndoId : undefined;
      if (intentId) {
        await cloudHistory.waitingFor(intentId);
        if (cloudHistory.needsIntentCursor(intentId)) await refresh();
      }
      const prediction = expectedId || intentId ? cloudHistory.confirmed(direction) : null;
      if ((expectedId && prediction?.id !== expectedId) || (intentId && prediction?.intentId !== intentId)) return cantUndo(next?.paths);
      const stepGuard = prediction?.guard ?? (projectWide ? callbacks.guard ?? guard(direction) : undefined);
      const stepPaths = prediction ? Object.keys(prediction.files) : candidate ? Object.keys(own.afterOf(candidate)) : next?.paths;
      const paths = unionPaths(stepPaths, heldClaimRef.current?.paths);
      const pressedAt = own.claimCount();
      own.overtake();
      const attempt = async (target: string | null): Promise<ApplyResult> => {
        // Cloud restores nonvisual files in its snapshot transaction. Their bytes
        // are not needed to patch the preview or restore timeline lanes.
        const previewPaths = (files: string[]) => projectWide
          ? files.filter(path => computePreviewImpact([path]).affectsPreview)
          : files;
        if (projectIdRef.current !== projectId || (prediction && cloudHistory.confirmed(direction)?.id !== prediction.id)) return cantUndo(paths);
        const previous = prediction ? null : await readAll(previewPaths(paths), callbacks.readFile);
        const before = new Map(projectWide && !prediction ? paths.map(path => [path, confirmedSource(projectId, path)]) : []);
        const headers = studioWriteHeaders();
        const token = headers["X-Hyperframes-Write-Token"];
        lastStepToken.current = token;
        if (projectWide) cloudHistory.mark(token);
        const beforeStep = readSequence.current;
        const clock = ++cloudHistory.clock;
        const posted = await post(
          historyUrl(projectId, target ? "/undo" : stepGuard ? "/step-guarded" : "/step"),
          target ? { entryId: target } : { direction: direction === "undo" ? "back" : "forward", ...stepGuard },
          headers,
        );
        heldClaimRef.current = null;
        const navigation = posted.ok
          ? (posted.body as { navigation?: Pick<HistoryView, "currentSeq" | "back" | "forward" | "currentVersionId" | "revision"> }).navigation
          : undefined;
        const overtaken = cloudHistory.clock !== clock || projectIdRef.current !== projectId;
        const ambiguous = !posted.ok && (posted.status === 0 || posted.status >= 500 || (posted.status >= 200 && posted.status < 300));
        if (navigation && !overtaken) {
          // An already-started GET may describe the cursor before this step.
          if (readSequence.current !== beforeStep) scheduleRefresh();
          ++readSequence.current;
          const nextView = { ...navigation, entries: [] };
          viewRef.current = nextView;
          setView(nextView);
          cloudHistory.offered(nextView);
        } else if (projectWide) {
          // The request can still commit after a lost response. Its late echo must then
          // deliver authoritative file contents, even though we recognize the write token.
          if (ambiguous) {
            uncertainSteps.set(token, paths);
            if (uncertainSteps.size > 32) uncertainSteps.delete(uncertainSteps.keys().next().value!);
          } else if (!posted.ok) cloudHistory.clear();
          const current = await refresh();
          if (ambiguous && prediction && !overtaken && clock === cloudHistory.clock &&
              current?.currentVersionId === prediction.guard.expectedTargetVersionId && current.revision === prediction.guard.expectedTargetRevision) {
            const files = confirmCloudRestore(projectId, prediction.files, paths);
            if (files) {
              uncertainSteps.delete(token);
              return { ok: true, paths, files, label: next?.label ?? (direction === 'undo' ? current.forward?.label : current.back?.label), undoes: expectedId };
            }
          }
        } else {
          void refresh();
        }
        // 404: this app keeps no history, so there is nothing to step.
        if (!posted.ok && posted.status === 404) return { ok: false, reason: "empty" };
        if (!posted.ok && stepGuard && posted.status === 409) return cantUndo(paths);
        if (!posted.ok) return { ok: false, reason: "failed", message: posted.error, ...(ambiguous && projectWide && { reconcilePaths: paths }) };
        const reply = posted.body as HistoryResult | { ok: true; entry?: { label: string } | null; stepLabel?: string; appliedFiles: string[]; revision?: string; versionId?: string };
        if ("appliedFiles" in reply) {
          const label = reply.stepLabel ?? next?.label ?? reply.entry?.label;
          const changed = reply.appliedFiles;
          const raced = navigation?.revision && (navigation.revision !== reply.revision || navigation.currentVersionId !== reply.versionId);
          if (overtaken || raced) {
            // The step did replace its source. Retire that chain even though the peer
            // now owns the picture. A later read or local save owns its own version.
            for (const path of changed) {
              const replaced = prediction?.files[path]?.versions?.previousVersion ?? before.get(path)?.version;
              if (!replaced) continue;
              forgetFileEditChain(projectId, path, replaced);
              if (confirmedSource(projectId, path)?.version === replaced) forgetSource(projectId, path);
            }
            return { ok: true, label, paths: changed };
          }
          if (prediction) {
            const matches = navigation?.revision === reply.revision && navigation?.currentVersionId === reply.versionId &&
              prediction.guard.expectedTargetRevision === reply.revision && prediction.guard.expectedTargetVersionId === reply.versionId;
            const files = matches ? confirmCloudRestore(projectId, prediction.files, changed) : undefined;
            return { ok: true, label, paths: changed, files, undoes: files ? prediction.id : undefined };
          }
          // Snapshot history returns the destination entry. Its own diff can describe a different edit.
          // A step can revisit an immutable file version. Its old forward receipts must
          // not advance the restored frame back to the edit we just undid. The actual
          // paths can also differ from the predicted step, including files we won't read below.
          const pins = new Map(reply.appliedFiles.map(path => {
            const base = before.get(path);
            const pins = retireFileEditChain(projectId, path, base && base.content === previous?.[path] ? base.version : undefined);
            forgetSource(projectId, path);
            return [path, pins] as const;
          }));
          const files = await restoredFiles(previewPaths(reply.appliedFiles), previous, callbacks.readFile);
          if (clock !== cloudHistory.clock || projectIdRef.current !== projectId) return { ok: true, label, paths: changed };
          for (const [path, file] of Object.entries(files ?? {})) {
            const source = confirmedSource(projectId, path);
            const base = before.get(path);
            if (source?.content === file.restored) file.versions = {
              previous: pins.get(path)!, previousVersion: base?.content === file.previous ? base.version : undefined,
              restored: source.version,
            };
          }
          return { ok: true, label, paths: changed, files };
        }
        if (!reply.ok) {
          if (projectIdRef.current === projectId && next && (!target || target === next.id)) {
            blockedRef.current = { ...blockedRef.current, [direction]: next };
            setBlocked(blockedRef.current);
          }
          const { files } = reply.conflict;
          return { ok: false, reason: "content-mismatch", paths: files };
        }
        if (!reply.entry) return { ok: false, reason: "empty" };
        own.stepped(reply.entry);
        const changed = reply.entry.files.map((file) => file.path);
        return {
          ok: true,
          label: reply.entry.label,
          undoes: reply.entry.undoes,
          paths: changed,
          files: await restoredFiles(
            changed,
            { ...own.afterOf(reply.entry.undoes), ...previous },
            callbacks.readFile,
          ),
        };
      };
      const run = () => {
        if (sameStep(blockedRef.current[direction], next) && (!candidate || candidate === next?.id)) {
          return Promise.resolve<ApplyResult>({ ok: false, reason: "empty" });
        }
        const target = own.targetFor(candidate, pressedAt);
        return target === false ? cantUndo(stepPaths) : attempt(target);
      };
      const stop = projectWide && callbacks.onSuperseded ? watchSuperseded(callbacks.onSuperseded) : undefined;
      try {
        return await (callbacks.serialize ? callbacks.serialize(paths, run) : run());
      } finally {
        stop?.();
      }
    },
    [projectId, projectWide, refresh, scheduleRefresh, own, cloudHistory, guard, uncertainSteps, watchSuperseded],
  );

  const noteOutsideChange = useCallback((writeToken?: string, changedPaths?: readonly string[]) => {
    if (writeToken && uncertainSteps.has(writeToken)) return refreshAfterEvent(writeToken);
    if (writeToken && (writeToken === lastStepToken.current || cloudHistory.owns(writeToken))) return;
    own.overtake();
    refreshAfterEvent(writeToken, changedPaths);
  }, [own, cloudHistory, refreshAfterEvent, uncertainSteps]);

  const undo = useCallback((callbacks: ApplyCallbacks) => step("undo", callbacks), [step]);
  const redo = useCallback((callbacks: ApplyCallbacks) => step("redo", callbacks), [step]);

  const state = useMemo(() => {
    const backAt = Math.max(view.back?.endedAt ?? 0, heldClaimRef.current?.at ?? 0);
    const redoAt = redoneAt(view);
    return {
      undo: backAt ? [{ createdAt: backAt }] : [],
      redo: redoAt === null ? [] : [{ createdAt: redoAt }],
    };
  }, [view]);

  return {
    loaded,
    projectWide,
    availableNow: (direction: "undo" | "redo") => Boolean(direction === "undo" ? viewRef.current.back : viewRef.current.forward) || Boolean(projectWide && cloudHistory.predict(direction)),
    canUndo: Boolean(view.back) && !sameStep(blocked.undo, view.back),
    canRedo: Boolean(view.forward) && !sameStep(blocked.redo, view.forward),
    undoLabel: view.back?.label,
    redoLabel: view.forward?.label,
    undoPaths: view.back?.paths ?? [],
    redoPaths: view.forward?.paths ?? [],
    state,
    recordEdit,
    claimKey,
    undo,
    redo,
    guard,
    pendingUndoId: () => cloudHistory.pendingUndoId(),
    watchSuperseded,
    refresh,
    predict: (direction: "undo" | "redo") =>
      projectWide ? cloudHistory.predict(direction) : sameStep(blockedRef.current[direction], direction === "undo" ? view.back : view.forward)
        ? null : own.predict(direction),
    claims: own.claimCount,
    noteOutsideChange,
    refreshAfterEvent,
  };
}
