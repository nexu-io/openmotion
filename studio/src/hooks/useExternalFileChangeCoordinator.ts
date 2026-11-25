import { trackSourceReadStream } from "../utils/confirmedTextSources";
import { hasEditorOpeningPreload, leaveEditorOpening, noteOpeningConnection, noteOpeningFileChange } from "../utils/editorOpeningValidation";
import { extractIndexHeadMarkup } from '../../../shared/preview-impact';
import { orderedFileChange, projectOrderedFile } from './orderedFileChanges';
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  changedFilePaths,
  changedFileVersion,
  changedFileVersions,
  mergeFileChangePayloads,
  readFileChangeAffectedCompositions,
  readFileChangeAffectsPreview,
  readFileChangeIndexHeadHash,
  readFileTreeChanged,
  readFileChangeField,
  readStudioFileChangePath,
} from "../components/editor/manualEditsParsing";
import { updateCachedCompositionRevisions } from "../player/lib/clientCompositionCapture";
import { StudioFileConflictError } from "../utils/studioSaveDiagnostics";
import type { ExternalConflictSnapshot } from "../utils/externalConflictStorage";
import { isSelfWriteEcho } from "./sdkSelfWriteRegistry";
import { onRebasedFileEdit } from "../utils/rebasedFileEdit";
import { studioContentHash, consumeStudioWriteToken, invalidateLatestSourceWrite, isLatestSourceWrite } from "../utils/studioFileVersion";
import { useCloudDisklessMode } from "../utils/cloudRuntime";
import { logReload } from "../utils/reloadDebug";
import { invalidatePendingSourceReads } from "../utils/readCurrentProjectSource";
import { ExternalPreviewUpdates } from "./externalPreviewUpdates";
import { notifyProjectActivity } from "../motion/workspaceRefresh";
import {
  emitMediaDerived,
  emitMediaIngestStatus,
  isMediaDerivedReadyEvent,
  isMediaIngestStatusEvent,
} from "../utils/mediaDerivedBus";

type ExternalChangeDrainResult =
  | { status: "clean" }
  | { status: "conflict"; error: StudioFileConflictError }
  | { status: "failed"; error: unknown };

export type ExternalFileChangeBlockedState =
  | {
      status: "conflict";
      generation: number;
      error: StudioFileConflictError;
      payload: unknown;
    }
  | {
      status: "failed";
      generation: number;
      path: string;
      error: unknown;
      payload: unknown;
      studioContent: string | null;
      recovered: boolean;
    };

interface ExternalFileChangeCoordinatorOptions {
  projectId: string | null;
  activeCompPath: string | null;
  recoveryFilePath?: string | null;
  pendingTimelineEditPathRef: MutableRefObject<Set<string>>;
  drainPendingChanges: () => Promise<ExternalChangeDrainResult>;
  getPendingCandidate?: () => { path: string; content: string } | null;
  discardPendingChanges: () => void;
  reloadPreview: (path?: string | readonly string[]) => void;
  /** Accept synchronously after capturing the displayed source and before opening the next revision. */
  refreshFileViews: (payload: unknown, acceptChange: (unaffectedPreview?: string) => void) => Promise<boolean> | "unaffected" | void;
  persistConflictSnapshot: (projectId: string, conflict: StudioFileConflictError) => Promise<void>;
  persistFailureSnapshot?: (
    projectId: string,
    filePath: string,
    studioContent: string,
    externalVersion: string | null,
    externalContent: string | null,
    error: unknown,
  ) => Promise<void>;
  loadConflictSnapshot?: (
    projectId: string,
    filePath: string,
  ) => Promise<ExternalConflictSnapshot | null>;
  deleteConflictSnapshot?: (projectId: string, filePath: string) => Promise<void>;
  overwriteConflict: (conflict: StudioFileConflictError) => Promise<void>;
  readProjectFile: (path: string) => Promise<string>;
  onUseExternalFile?: (path: string, content: string) => void;
  resetSaveQueues?: () => void;
  onAcceptedPersistedFileChange: (
    path: string,
    affectedCompositions: readonly string[] | null,
    ownWrite?: { token: string; version: string },
  ) => void;
  /**
   * Called alongside `reloadPreview`/`refreshFileViews` on every accepted
   * external change. The file tree (`useFileTree`) is only ever refreshed
   * from Studio's OWN file operations (create/delete/rename/upload) — an
   * external change (an agent writing outside Studio) reloads the preview
   * and the SDK session but, without this, never the listing. A composition
   * an agent removed or replaced then stays in the tree until the user does
   * a Studio-side file op or reloads the tab; clicking it opens a session
   * that can never resolve (`reason: "absent"`, proven stale-tree 2026-09-23).
   */
  refreshFileTree?: () => void | Promise<void>;
  /** Refresh the server-backed history view when another actor changes history without a file event. */
  onHistoryChanged?: (writeToken?: string) => void | Promise<void>;
  presentPendingPeerChange?: (payload: unknown) => void;
}

export interface ExternalFileChangeCoordinatorHandle {
  blocked: ExternalFileChangeBlockedState | null;
  retry: () => Promise<void>;
  useExternalFile: () => Promise<void>;
  keepStudioFile: () => Promise<void>;
}

interface HotTestAdapter {
  on(event: string, handler: (payload?: unknown) => void): void;
  off(event: string, handler: (payload?: unknown) => void): void;
}

function testHotAdapter(): HotTestAdapter | null {
  const value = (globalThis as { __HF_STUDIO_HOT_TEST_ADAPTER__?: unknown })
    .__HF_STUDIO_HOT_TEST_ADAPTER__;
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<HotTestAdapter>;
  return typeof candidate.on === "function" && typeof candidate.off === "function"
    ? (candidate as HotTestAdapter)
    : null;
}

const readFileChangeContent = (payload: unknown) => readFileChangeField(payload, "content");
const readFileChangeVersion = (payload: unknown) => readFileChangeField(payload, "version");
const readFileChangeWriteToken = (payload: unknown) => readFileChangeField(payload, "writeToken");

/**
 * Decode one delivery into the payload shape every reader above assumes.
 *
 * SSE delivers a `MessageEvent` whose `data` is a JSON string; the hot-reload
 * transports deliver the payload object. This is the only place that difference
 * exists: a reader handed an undecoded envelope reports every field as absent,
 * which is indistinguishable from a field that is genuinely unset.
 */
function decodeFileChange(delivery: unknown): unknown {
  // Structural, not `instanceof`: a polyfilled or cross-realm event must still decode.
  const data = (delivery as { data?: unknown } | null)?.data;
  if (typeof data !== "string") return delivery;
  try {
    return JSON.parse(data);
  } catch {
    logReload("file-change", { path: null, why: "unparseable payload" });
    return null;
  }
}

export function sseFileChangeChannel(
  onDelivery: (delivery: unknown) => void,
  onReconnect: () => void,
  onHistoryChanged: (delivery: unknown) => void = () => {},
): () => void {
  let needsCatchUp = false;
  const url = studioProjectUrl('/api/events?orderedEdits=1');
  const project = new URLSearchParams(url.split("?")[1]).get("projectId");
  let stopTrackingSources: (() => void) | undefined;
  function connect() {
    let revision: string | null = null;
    const bootstrap = project && hasEditorOpeningPreload(project);
    const eventSource = new EventSource(bootstrap ? url + "&openingHead=1" : url);
    stopTrackingSources = trackSourceReadStream(project, eventSource);
    eventSource.addEventListener("file-change", delivery => {
      const payload = decodeFileChange(delivery);
      if (bootstrap) noteOpeningFileChange(project);
      const ordered = orderedFileChange(payload);
      const next = readFileChangeField(payload, 'revision');
      if (ordered && revision && revision !== ordered.fromRevision) {
        // Concurrent commits can publish in reverse order. The HTTP readers know the current head.
        if (revision !== next) { revision = next; onReconnect(); }
        return;
      }
      revision = next;
      onDelivery(delivery);
      if (ordered) onHistoryChanged(delivery);
    });
    eventSource.addEventListener("history-changed", delivery => {
      // An older SSE gateway may relay the legacy notification over a negotiated stream.
      if ((decodeFileChange(delivery) as {includedInOrderedEdit?: boolean} | null)?.includedInOrderedEdit) return;
      onHistoryChanged(delivery);
    });
    eventSource.addEventListener("connected", event => {
      const connected = decodeFileChange(event);
      const projectId = readFileChangeField(connected, "projectId");
      if (bootstrap && project === projectId) {
        const head = readFileChangeField(connected, "revision");
        revision ??= head;
        if (noteOpeningConnection(projectId, head)) onReconnect();
      }
      if (projectId) notifyProjectActivity(projectId, "connected");
    });
    eventSource.addEventListener("catalog-changed", (event) => {
      const projectId = readFileChangeField(decodeFileChange(event), "projectId");
      if (projectId) notifyProjectActivity(projectId, "catalog-changed");
    });
    eventSource.addEventListener("render-updated", (event) => {
      const projectId = readFileChangeField(decodeFileChange(event), "projectId");
      if (projectId) notifyProjectActivity(projectId, "render-updated");
    });
    // Derived media (sprite/waveform/thumbnail/proxy/metadata) notifications update
    // timeline & sidebar caches without reloading the preview iframe.
    eventSource.addEventListener("media-derived-ready", (event) => {
      const decoded = decodeFileChange(event);
      if (isMediaDerivedReadyEvent(decoded)) {
        emitMediaDerived(decoded);
      }
    });
    // External / MCP media ingest placeholder & stage updates (never reload preview iframe).
    eventSource.addEventListener("media-ingest-status", (event) => {
      const decoded = decodeFileChange(event);
      if (isMediaIngestStatusEvent(decoded)) {
        emitMediaIngestStatus(decoded);
      }
    });
    eventSource.addEventListener("error", () => { needsCatchUp = true; revision = null; });
    eventSource.addEventListener("open", () => {
      if (needsCatchUp) onReconnect();
      needsCatchUp = true;
    });
    return eventSource;
  }

  let stream: EventSource | null = connect();
  // Chrome can retain an open EventSource across an offline interval while its
  // dependent preview/file requests fail. Reopen it before reconciling the project.
  function offline() {
    needsCatchUp = true;
    stopTrackingSources?.();
    stream?.close();
    stream = null;
  }
  function online() {
    if (!stream || stream.readyState === EventSource.CLOSED) stream = connect();
  }
  globalThis.addEventListener?.("offline", offline);
  globalThis.addEventListener?.("online", online);
  return () => {
    globalThis.removeEventListener?.("offline", offline);
    globalThis.removeEventListener?.("online", online);
    stopTrackingSources?.();
    stream?.close();
    if (project) leaveEditorOpening(project);
  };
}

function eventIdentity(path: string, payload: unknown): string | null {
  const revision = readFileChangeField(payload, "revision");
  if (revision) return `${path}\0${revision}\0${readFileChangeWriteToken(payload) ?? ""}`;
  const version = readFileChangeVersion(payload);
  if (version) return `${path}\0${version}`;
  const content = readFileChangeContent(payload);
  return content == null ? null : `${path}\0${content.length}\0${content}`;
}

export function useExternalFileChangeCoordinator({
  projectId,
  activeCompPath,
  recoveryFilePath = activeCompPath,
  pendingTimelineEditPathRef,
  drainPendingChanges,
  presentPendingPeerChange,
  getPendingCandidate,
  discardPendingChanges,
  reloadPreview,
  refreshFileViews,
  persistConflictSnapshot,
  persistFailureSnapshot,
  loadConflictSnapshot,
  deleteConflictSnapshot,
  overwriteConflict,
  readProjectFile,
  onUseExternalFile,
  resetSaveQueues,
  onAcceptedPersistedFileChange,
  refreshFileTree,
  onHistoryChanged,
}: ExternalFileChangeCoordinatorOptions): ExternalFileChangeCoordinatorHandle {
  const cloud = useCloudDisklessMode();
  // Vite can serve a cloud project through its development proxy. That backend publishes SSE.
  const useHotChannel = !cloud && Boolean(import.meta.hot || testHotAdapter());
  const [blocked, setBlockedState] = useState<ExternalFileChangeBlockedState | null>(null);
  const generationRef = useRef(0);
  const [previewUpdates] = useState(() => new ExternalPreviewUpdates());
  const mountedRef = useRef(true);
  const lastEventIdentityRef = useRef<string | null>(null);
  const blockedRef = useRef<ExternalFileChangeBlockedState | null>(null);
  const snapshotWriteTailRef = useRef<Promise<void>>(Promise.resolve());
  const drainingRef = useRef(false);
  const pendingPayloadRef = useRef<{ payload: unknown } | null>(null);
  // A newer blocked change replaces the held one, so it inherits what the held one owed.
  const setBlocked = useCallback((next: ExternalFileChangeBlockedState | null) => {
    const held = blockedRef.current;
    const current =
      next && held
        ? { ...next, payload: mergeFileChangePayloads(held.payload, next.payload) }
        : next;
    blockedRef.current = current;
    setBlockedState(current);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    pendingPayloadRef.current = null;
  }, [projectId]);

  useEffect(() => {
    generationRef.current += 1;
    setBlocked(null);
    lastEventIdentityRef.current = null;
    return () => previewUpdates.clear();
  }, [projectId, activeCompPath, setBlocked, previewUpdates]);

  useEffect(() => {
    if (!projectId || !recoveryFilePath || !loadConflictSnapshot) return;
    const generation = ++generationRef.current;
    let cancelled = false;
    void loadConflictSnapshot(projectId, recoveryFilePath)
      .then((snapshot) => {
        if (cancelled || !snapshot || !mountedRef.current || generation !== generationRef.current) {
          return;
        }
        const payload = {
          path: snapshot.filePath,
          version: snapshot.externalVersion,
          content: snapshot.externalContent,
        };
        if (snapshot.kind === "failed") {
          setBlocked({
            status: "failed",
            generation,
            path: snapshot.filePath,
            error: new Error(snapshot.failureMessage),
            payload,
            studioContent: snapshot.studioContent,
            recovered: true,
          });
        } else {
          const error = new StudioFileConflictError({
            filePath: snapshot.filePath,
            currentVersion: snapshot.externalVersion,
            currentContent: snapshot.externalContent,
            attemptedContent: snapshot.studioContent,
          });
          setBlocked({ status: "conflict", generation, error, payload });
        }
      })
      .catch(() => {
        // Storage may be unavailable in restricted browser contexts. A failed
        // best-effort restore must not create an unhandled rejection or block
        // a project that has no known recovery record.
      });
    return () => {
      cancelled = true;
    };
  }, [loadConflictSnapshot, projectId, recoveryFilePath, setBlocked]);

  const rootThumbnailEvent = useRef(0);
  const updateThumbnails = useCallback((project: string, payload: unknown) => {
    const versions = changedFileVersions(payload);
    const changedPaths = readFileChangeAffectsPreview(payload) ? changedFilePaths(payload) ?? undefined : undefined;
    const indexHeadHash = readFileChangeIndexHeadHash(payload);
    if (!versions && !changedPaths?.length && !indexHeadHash) return;
    if (indexHeadHash || (versions && 'index.html' in versions)) rootThumbnailEvent.current++;
    const missingHead = !indexHeadHash && versions?.['index.html'];
    const source = missingHead ? projectOrderedFile(project, 'index.html', payload) : undefined;
    updateCachedCompositionRevisions(project, versions, {
      changedPaths, indexHeadHash, indexHeadChanged: Boolean(missingHead && !source),
    });
    if (source) {
      // Only the head goes through SHA-256. Receipt and preview processing can proceed
      // immediately; an older digest must never replace a newer thumbnail dependency.
      const event = rootThumbnailEvent.current;
      const apply = (options: {indexHeadHash?: string; indexHeadChanged?: boolean}) => {
        if (rootThumbnailEvent.current === event) updateCachedCompositionRevisions(project, null, options);
      };
      void studioContentHash(extractIndexHeadMarkup(source.content)).then(
        digest => apply({ indexHeadHash: digest.slice(0, 12) }),
        () => apply({ indexHeadChanged: true }),
      );
    }
  }, []);

  // What a settled change owes: thumbnails (unless its own write's echo brings them), then reloads.
  const deliverOwed = useCallback(
    (owed: unknown, accept = true) => {
      const path = readStudioFileChangePath(owed) ?? ".";
      const changedPaths = readFileChangeAffectsPreview(owed) ? changedFilePaths(owed) ?? undefined : undefined;
      if (projectId) updateThumbnails(projectId, owed);
      const inPlace = refreshFileViews(owed, unaffectedPreview => {
        const compositions = readFileChangeAffectedCompositions(owed);
        if (accept) onAcceptedPersistedFileChange(path, unaffectedPreview && compositions
          ? compositions.filter(item => item !== unaffectedPreview) : compositions);
      });
      const affectsPreview = readFileChangeAffectsPreview(owed) && inPlace !== "unaffected";
      logReload(affectsPreview ? "reload" : "file-tree only", {
        path,
        by: "external-change coordinator",
      });
      if (affectsPreview) previewUpdates.track(changedPaths, inPlace, reloadPreview);
      // Fire-and-forget: a failed refresh leaves the tree as stale as it was,
      // which is the status quo this exists to improve on, not a new failure
      // mode to surface. The `absent`-triggered fallback in useSdkSession
      // covers the case where this call is missed entirely (server restart,
      // a watcher event the SSE never delivered).
      if (readFileTreeChanged(owed)) void refreshFileTree?.();
    },
    [projectId, onAcceptedPersistedFileChange, previewUpdates, reloadPreview, refreshFileViews, refreshFileTree, updateThumbnails],
  );

  const persistSnapshotInOrder = useCallback(async (write: () => Promise<void>) => {
    const next = snapshotWriteTailRef.current.catch(() => undefined).then(write);
    snapshotWriteTailRef.current = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
  }, []);

  const drainOnePending = useCallback(
    // fallow-ignore-next-line complexity
    async (payload: unknown) => {
      const path = readStudioFileChangePath(payload);
      if (!path) return;

      const generation = ++generationRef.current;
      const savingPath = getPendingCandidate?.()?.path;
      const result = await drainPendingChanges();
      if (!mountedRef.current || generation !== generationRef.current) return;

      if (result.status === "clean") {
        const previousBlocked = blockedRef.current;
        // Only saving the failed draft's file retires its copy; restored drafts are never queued.
        if (
          previousBlocked?.status === "failed" &&
          !previousBlocked.recovered &&
          previousBlocked.path === savingPath &&
          deleteConflictSnapshot
        ) {
          try {
            await deleteConflictSnapshot(projectId!, previousBlocked.path);
          } catch (error) {
            if (mountedRef.current && generation === generationRef.current) {
              setBlocked({
                ...previousBlocked,
                generation,
                error,
                payload: mergeFileChangePayloads(payload, previousBlocked.payload),
              });
            }
            return;
          }
        }
        if (!mountedRef.current || generation !== generationRef.current) return;
        setBlocked(null);
        const restored = previousBlocked?.status === "failed" && previousBlocked.recovered;
        deliverOwed(
          previousBlocked && !restored
            ? mergeFileChangePayloads(previousBlocked.payload, payload)
            : payload,
        );
        return;
      }
      if (result.status === "failed") {
        // The draft names the file to recover; the payload stays the scope to reload.
        const candidate = getPendingCandidate?.();
        const failedPath = candidate?.path ?? (path === "." ? (recoveryFilePath ?? path) : path);
        const studioContent = candidate?.content ?? null;
        const external = failedPath === path ? payload : null;
        let error = result.error;
        if (studioContent != null && persistFailureSnapshot) {
          try {
            await persistSnapshotInOrder(() =>
              persistFailureSnapshot(
                projectId!,
                failedPath,
                studioContent,
                readFileChangeVersion(external),
                readFileChangeContent(external),
                result.error,
              ),
            );
          } catch (snapshotError) {
            error = new Error(
              `Studio could not save the edit or its recovery snapshot: ${
                snapshotError instanceof Error ? snapshotError.message : String(snapshotError)
              }`,
              { cause: result.error },
            );
          }
        }
        if (!mountedRef.current || generation !== generationRef.current) return;
        setBlocked({
          status: "failed",
          generation,
          path: failedPath,
          error,
          payload,
          studioContent,
          recovered: false,
        });
        return;
      }
      try {
        await persistSnapshotInOrder(() => persistConflictSnapshot(projectId!, result.error));
      } catch (error) {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setBlocked({
          status: "failed",
          generation,
          path: result.error.filePath,
          error,
          payload,
          studioContent: result.error.attemptedContent,
          recovered: false,
        });
        return;
      }
      if (!mountedRef.current || generation !== generationRef.current) return;
      setBlocked({ status: "conflict", generation, error: result.error, payload });
    },
    [
      drainPendingChanges,
      setBlocked,
      projectId,
      deleteConflictSnapshot,
      getPendingCandidate,
      recoveryFilePath,
      persistConflictSnapshot,
      persistFailureSnapshot,
      persistSnapshotInOrder,
      deliverOwed,
    ],
  );

  const drainOnePendingRef = useRef(drainOnePending);
  drainOnePendingRef.current = drainOnePending;

  const startDrainLoop = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (mountedRef.current) {
        const pending = pendingPayloadRef.current;
        if (!pending) break;
        pendingPayloadRef.current = null;
        await drainOnePendingRef.current(pending.payload);
      }
    } finally {
      drainingRef.current = false;
    }
  }, []);

  const processChange = useCallback(
    // fallow-ignore-next-line complexity
    (payload: unknown) => {
      const path = readStudioFileChangePath(payload);
      if (!path || !projectId) {
        logReload("file-change", { path: null, why: path ? "no project" : "no path in payload" });
        return;
      }
      // `/api/events` is one connection per SERVER, not per project: under the
      // CLI host, a tab left open from a `preview` run that has since exited
      // shares this stream with whatever project now runs on that port. Both
      // commonly use the same default composition path, so without this check
      // a stale tab reloads its preview (which then 404s — the CLI host is
      // single-project, so it can't resolve the OTHER project it's serving)
      // and re-reads its own composition on every save the CURRENT project
      // makes. Absent field (older server, one release of skew) still passes.
      const deliveredProjectId = readFileChangeField(payload, "projectId");
      if (deliveredProjectId && deliveredProjectId !== projectId) {
        logReload("suppressed", { path, why: "other project" });
        return;
      }
      pendingTimelineEditPathRef.current.delete(path);

      const content = readFileChangeContent(payload);
      const token = readFileChangeWriteToken(payload);
      logReload("file-change", { path, token: token ?? null, hasContent: content != null });
      const identity = eventIdentity(path, payload);
      if (identity != null && identity === lastEventIdentityRef.current) {
        logReload("suppressed", { path, why: "duplicate event" });
        return;
      }
      lastEventIdentityRef.current = identity;
      invalidatePendingSourceReads(projectId, changedFilePaths(payload), changedFileVersions(payload));

      // All steps in an ordered delivery came from one sender. Retire every echo token.
      for (const step of orderedFileChange(payload)?.steps ?? []) {
        if (step.id !== token) consumeStudioWriteToken(step.id);
      }
      const ownWriteToken = consumeStudioWriteToken(token);
      const ownContentEcho = content != null && isSelfWriteEcho(path, content);
      if (!ownWriteToken) invalidateLatestSourceWrite();
      if (ownWriteToken || ownContentEcho) {
        updateThumbnails(projectId, payload);
        const version = changedFileVersion(payload, path);
        const ownWrite = ownWriteToken && token && version && isLatestSourceWrite(token) ? { token, version } : undefined;
        onAcceptedPersistedFileChange(path, readFileChangeAffectedCompositions(payload), ownWrite);
        logReload("suppressed", {
          path,
          why: ownWriteToken ? "own write token" : "own content echo",
        });
        return;
      }

      presentPendingPeerChange?.(payload);
      const waiting = pendingPayloadRef.current?.payload;
      pendingPayloadRef.current = {
        payload: waiting == null ? payload : mergeFileChangePayloads(waiting, payload),
      };
      void startDrainLoop();
    },
    [projectId, pendingTimelineEditPathRef, startDrainLoop, onAcceptedPersistedFileChange, presentPendingPeerChange, updateThumbnails],
  );

  const processChangeRef = useRef(processChange);
  processChangeRef.current = processChange;
  // Our own SSE echo can arrive before the command receipt and is suppressed.
  // A divergent receipt needs the same scoped refresh as another editor's write.
  useEffect(() => onRebasedFileEdit((pid, file) => {
    processChangeRef.current({ projectId: pid, path: file.path, fileTreeChanged: false });
  }), []);
  const processHistoryChange = useCallback(
    (delivery?: unknown, publishActivity = true) => {
      const payload = decodeFileChange(delivery);
      if (!payload || !projectId) return;
      const deliveredProjectId = readFileChangeField(payload, "projectId");
      if (deliveredProjectId && deliveredProjectId !== projectId) return;
      if (publishActivity) notifyProjectActivity(projectId, "history-changed");
      void Promise.resolve(onHistoryChanged?.(readFileChangeField(payload, "writeToken") ?? undefined)).catch((error) => {
        console.warn("Studio could not refresh project history after an external change.", error);
      });
    },
    [onHistoryChanged, projectId],
  );
  const processHistoryChangeRef = useRef(processHistoryChange);
  processHistoryChangeRef.current = processHistoryChange;
  useEffect(() => {
    // One decoder for all three transports; the rungs only choose the channel.
    const handler = (delivery?: unknown) => processChangeRef.current(decodeFileChange(delivery));
    const historyHandler = (delivery?: unknown) => processHistoryChangeRef.current(delivery);
    const adapter = useHotChannel && testHotAdapter();
    if (adapter) {
      adapter.on("hf:file-change", handler);
      return () => adapter.off("hf:file-change", handler);
    }
    if (useHotChannel && import.meta.hot) {
      import.meta.hot.on("hf:file-change", handler);
      import.meta.hot.on("hf:history-changed", historyHandler);
      return () => {
        import.meta.hot?.off?.("hf:file-change", handler);
        import.meta.hot?.off?.("hf:history-changed", historyHandler);
      };
    }
    const catchUp = () => {
      if (projectId) notifyProjectActivity(projectId, "reconnected");
      processChangeRef.current({ path: "." });
      processHistoryChangeRef.current({ projectId }, false);
    };
    return sseFileChangeChannel(handler, catchUp, historyHandler);
  }, [projectId, useHotChannel]);

  const retry = useCallback(async () => {
    const current = blockedRef.current;
    if (!current || current.status === "conflict" || current.recovered) return;
    resetSaveQueues?.();
    lastEventIdentityRef.current = null;
    processChange(current.payload);
  }, [processChange, resetSaveQueues]);

  const useExternalFile = useCallback(
    // fallow-ignore-next-line complexity
    async () => {
      const current = blockedRef.current;
      if (!current || !projectId || current.generation !== generationRef.current) return;
      const path = current.status === "conflict" ? current.error.filePath : current.path;
      const external =
        current.status === "conflict" && current.error.currentContent != null
          ? current.error.currentContent
          : await readProjectFile(path);
      if (current.generation !== generationRef.current) return;
      discardPendingChanges();
      resetSaveQueues?.();
      onUseExternalFile?.(path, external);
      await deleteConflictSnapshot?.(projectId, path);
      setBlocked(null);
      deliverOwed(current.payload);
    },
    [
      deleteConflictSnapshot,
      setBlocked,
      discardPendingChanges,
      onUseExternalFile,
      projectId,
      readProjectFile,
      deliverOwed,
      resetSaveQueues,
    ],
  );

  // fallow-ignore-next-line complexity
  const keepStudioFile = useCallback(async () => {
    const current = blockedRef.current;
    if (!current || !projectId) return;
    if (current.generation !== generationRef.current) return;
    let conflict: StudioFileConflictError;
    if (current.status === "conflict") {
      conflict = current.error;
    } else {
      if (!current.recovered || current.studioContent == null) return;
      try {
        const currentContent =
          readFileChangeContent(current.payload) ?? (await readProjectFile(current.path));
        conflict = new StudioFileConflictError({
          filePath: current.path,
          currentVersion: readFileChangeVersion(current.payload),
          currentContent,
          attemptedContent: current.studioContent,
        });
      } catch (error) {
        if (current.generation === generationRef.current) setBlocked({ ...current, error });
        return;
      }
    }
    try {
      await overwriteConflict(conflict);
    } catch (error) {
      if (current.generation === generationRef.current) {
        setBlocked({
          status: "failed",
          generation: current.generation,
          path: conflict.filePath,
          error,
          payload: current.payload,
          studioContent: conflict.attemptedContent,
          recovered: current.status === "failed" && current.recovered,
        });
      }
      return;
    }
    if (current.generation !== generationRef.current) return;
    discardPendingChanges();
    resetSaveQueues?.();
    await deleteConflictSnapshot?.(projectId, conflict.filePath);
    setBlocked(null);
    deliverOwed(
      mergeFileChangePayloads(current.payload, { path: conflict.filePath, affectsPreview: true }),
      readStudioFileChangePath(current.payload) !== conflict.filePath,
    );
  }, [
    deleteConflictSnapshot,
    setBlocked,
    discardPendingChanges,
    overwriteConflict,
    projectId,
    readProjectFile,
    deliverOwed,
    resetSaveQueues,
  ]);

  return { blocked, retry, useExternalFile, keepStudioFile };
}
import { studioProjectUrl } from '../utils/studioApiFetch';
