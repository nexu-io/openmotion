import { buildProjectApiPath } from "../utils/projectRouting";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { FONT_EXT } from "../utils/mediaTypes";
import { fontFamilyFromAssetPath, type ImportedFontAsset } from "../components/editor/fontAssets";
import { captureProjectProvenance } from "../components/feedback/projectProvenance";
import { studioApiFetch } from "../utils/studioApiFetch";
import { trackStudioEvent } from "../utils/studioTelemetry";
import { errorProps } from "../utils/rejectionTelemetry";
import { encodeUrlPath } from "@hyperframes/parsers";
import { setCachedCloudDisklessMode } from "../utils/cloudRuntime";
import { setCachedProjectRevision } from "../player/lib/clientCompositionCapture";
import {
  subscribeMediaDerived,
  subscribeMediaIngestStatus,
  type MediaIngestSource,
  type MediaIngestStatusEvent,
} from "../utils/mediaDerivedBus";

export interface PendingExternalImport {
  id: string;
  ticketId?: string;
  jobId?: string;
  filename: string;
  targetPath?: string;
  bytes?: number;
  source: MediaIngestSource;
  state: "waiting_upload" | "processing" | "failed";
  stage?: string;
  progress?: number;
  error?: string;
  expiresAt?: string;
  updatedAt: number;
}

export interface AssetMetadataSummary {
  duration?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  hasVideo?: boolean;
  proxyStatus?: "ready" | "failed";
  spriteStatus?: "ready" | "failed";
  waveformReady?: boolean;
  thumbnailReady?: boolean;
  optimizationStatus?: "optimizing" | "ready";
}

interface UseFileTreeOptions {
  projectId: string | null;
  projectIdRef: React.RefObject<string | null>;
}

export interface FileTreeRefreshOptions {
  projectId: string;
  requiredPaths: readonly string[];
}

interface FetchedFileTree {
  projectId: string;
  loaded: boolean;
  fileTree: string[];
  compositionPaths: string[];
  projectDir: string | null;
  assetNames?: Record<string, string>;
  assetMetadata?: Record<string, AssetMetadataSummary>;
  pendingImports?: PendingExternalImport[];
  fonts?: Array<Omit<ImportedFontAsset, "url">>;
}

// Stable references so a mismatched projectId doesn't create a new array every render
// and defeat useMemo/useCallback deps downstream (e.g. the `assets` memo below).
const EMPTY_FILE_LIST: string[] = [];
const EMPTY_PENDING_IMPORTS: PendingExternalImport[] = [];

type TreeListing = {
  assetNames?: Record<string, string>;
  assetMetadata?: Record<string, AssetMetadataSummary>;
  pendingImports?: PendingExternalImport[];
  dir?: string;
  files?: string[];
  compositions?: string[];
  fonts?: Array<Omit<ImportedFontAsset, "url">>;
};

async function readTreeListing(projectId: string, signal: AbortSignal): Promise<TreeListing> {
  const res = await studioApiFetch(buildProjectApiPath(projectId), { signal });
  if (!res.ok) throw new Error(`tree fetch failed: ${res.status}`);
  return res.json();
}

function reportRefreshFailure(err: unknown): void {
  const { error_name, error_message } = errorProps(err);
  trackStudioEvent("file_tree_refresh_failed", { error_name, error_message });
}

/**
 * Holds the tree with the `projectId` it was fetched for; exposes empty/not-loaded
 * whenever that id doesn't match the current one, so a switch can't read another project's tree.
 */
export function useFileTree({ projectId, projectIdRef }: UseFileTreeOptions) {
  const [fetched, setFetched] = useState<FetchedFileTree | null>(null);
  const cacheByProjectRef = useRef<Map<string, FetchedFileTree>>(new Map());
  const refreshRequestRef = useRef(0);
  const appliedRequestRef = useRef(0);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const failureReportedRef = useRef(false);
  const current =
    fetched?.projectId === projectId
      ? fetched
      : projectId
        ? (cacheByProjectRef.current.get(projectId) ?? null)
        : null;
  const fileTree = current?.fileTree ?? EMPTY_FILE_LIST;
  const compositionPaths = current?.compositionPaths ?? EMPTY_FILE_LIST;
  const projectDir = current?.projectDir ?? null;
  const fileTreeLoaded = current?.loaded ?? false;

  const rememberProjectTree = useCallback((entry: FetchedFileTree) => {
    const cache = cacheByProjectRef.current;
    cache.delete(entry.projectId);
    cache.set(entry.projectId, entry);
    while (cache.size > 16) {
      const oldest = cache.keys().next().value;
      if (!oldest) break;
      cache.delete(oldest);
    }
  }, []);

  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const requestId = ++refreshRequestRef.current;
    const warm = cacheByProjectRef.current.get(projectId);
    if (warm) {
      // Stale-while-revalidate: serve previously fetched project tree immediately on revisit
      // while refreshing silently in the background.
      setFetched(warm);
    } else {
      setFetched({ projectId, loaded: false, fileTree: [], compositionPaths: [], projectDir: null });
    }
    studioApiFetch(buildProjectApiPath(projectId))
      // An unresolvable project answers 404 with a JSON body, so without this
      // the error path parsed cleanly and the success branch below recorded an
      // empty tree — and an empty provenance snapshot — for a project that was
      // never read. Throwing hands it to the catch instead.
      .then((r) => {
        if (!r.ok) throw new Error(`tree fetch failed: ${r.status}`);
        return r.json();
      })
      .then((data: TreeListing) => {
        if (cancelled || requestId < appliedRequestRef.current) return;
        appliedRequestRef.current = requestId;
        if (typeof data.dir === "string" && data.dir.startsWith("/virtual/")) {
          setCachedCloudDisklessMode(true);
        }
        if (typeof (data as { revision?: unknown }).revision === "string") {
          setCachedProjectRevision(projectId, (data as { revision?: string }).revision);
        }
        const nextEntry: FetchedFileTree = {
          projectId,
          loaded: true,
          fileTree: data.files ?? [],
          compositionPaths: data.compositions ?? [],
          projectDir: typeof data.dir === "string" ? data.dir : null,
          fonts: data.fonts,
          assetNames: data.assetNames,
          assetMetadata: data.assetMetadata,
          pendingImports: Array.isArray(data.pendingImports) ? data.pendingImports : undefined,
        };
        rememberProjectTree(nextEntry);
        setFetched(nextEntry);
        // Snapshot how this project was made, while the listing is in hand and
        // the app is still alive. A crash later has no other way to learn it.
        void captureProjectProvenance(projectId, data.files ?? [], data.compositions ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          cacheByProjectRef.current.delete(projectId);
          setFetched((prev) => (prev?.projectId === projectId ? { ...prev, loaded: true } : prev));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, rememberProjectTree]);

  const refreshFileTree = useCallback(async (options?: FileTreeRefreshOptions) => {
    const pid = options?.projectId ?? projectIdRef.current;
    if (!pid) return;
    if (options && projectIdRef.current !== pid) throw new Error('Active project changed before asset refresh');
    // Same id+abort pair as useFileManager.ts's openSourceForSelection: cancel the
    // superseded request instead of letting it complete and discarding the result.
    refreshAbortRef.current?.abort();
    const requestId = ++refreshRequestRef.current;
    const controller = new AbortController();
    // A verified import refresh must finish even if an external file event also
    // refreshes the tree. Ordinary background refreshes remain cancellable.
    refreshAbortRef.current = options ? null : controller;
    let data: TreeListing;
    try {
      data = await readTreeListing(pid, controller.signal);
      if (options && (!Array.isArray(data.files) || options.requiredPaths.some(path => !data.files!.includes(path)))) {
        throw new Error('Imported files are missing from the project listing');
      }
    } catch (err) {
      if (!options && err instanceof DOMException && err.name === "AbortError") return;
      if (!failureReportedRef.current) reportRefreshFailure(err);
      failureReportedRef.current = true;
      if (options) throw err;
      return;
    }
    failureReportedRef.current = false;
    if (options && projectIdRef.current !== pid) throw new Error('Active project changed during asset refresh');
    if (data.files && !controller.signal.aborted && projectIdRef.current === pid && requestId >= appliedRequestRef.current) {
      appliedRequestRef.current = requestId;
      if (typeof data.dir === "string" && data.dir.startsWith("/virtual/")) {
        setCachedCloudDisklessMode(true);
      }
      if (typeof (data as { revision?: unknown }).revision === "string") {
        setCachedProjectRevision(pid, (data as { revision?: string }).revision);
      }
      setFetched((prev) => {
        if (prev?.projectId !== pid) return prev;
        const nextEntry: FetchedFileTree = {
          ...prev,
          loaded: true,
          projectDir: typeof data.dir === "string" ? data.dir : prev.projectDir,
          fileTree: data.files ?? prev.fileTree,
          // A response that omits `compositions` must not wipe out a
          // known-good list — only replace it when the field is present.
          compositionPaths: data.compositions ?? prev.compositionPaths,
          fonts: data.fonts ?? prev.fonts,
          assetNames: data.assetNames ?? prev.assetNames,
          assetMetadata: data.assetMetadata ?? prev.assetMetadata,
          pendingImports: Array.isArray(data.pendingImports)
            ? data.pendingImports
            : prev.pendingImports?.filter(
                (item) => !item.targetPath || !(data.files ?? prev.fileTree).includes(item.targetPath),
              ),
        };
        rememberProjectTree(nextEntry);
        return nextEntry;
      });
    }
  }, [projectIdRef, rememberProjectTree]);

  const dismissPendingImport = useCallback((id: string) => {
    setFetched((prev) =>
      prev?.pendingImports
        ? { ...prev, pendingImports: prev.pendingImports.filter((item) => item.id !== id) }
        : prev,
    );
  }, []);

  // Track live external / MCP media-ingest-status SSE events (placeholder & stage progress).
  useEffect(() => {
    if (!projectId) return;
    const applyIngestEvent = (event: MediaIngestStatusEvent) => {
      if (event.projectId !== projectId) return;
      const matchId = event.jobId ?? event.ticketId ?? event.targetPath ?? event.filename;
      setFetched((prev) => {
        if (!prev || prev.projectId !== projectId) return prev;
        const list = prev.pendingImports ?? [];
        const matches = (item: PendingExternalImport) =>
          item.id === matchId ||
          (Boolean(event.ticketId) && item.ticketId === event.ticketId) ||
          (Boolean(event.jobId) && item.jobId === event.jobId) ||
          (Boolean(event.targetPath) && item.targetPath === event.targetPath);

        if (event.state === "completed") {
          const next = list.filter((item) => !matches(item));
          return next.length === list.length ? prev : { ...prev, pendingImports: next };
        }

        const updated: PendingExternalImport = {
          id: matchId,
          ...(event.ticketId ? { ticketId: event.ticketId } : {}),
          ...(event.jobId ? { jobId: event.jobId } : {}),
          filename: event.filename,
          ...(event.targetPath ? { targetPath: event.targetPath } : {}),
          ...(typeof event.bytes === "number" ? { bytes: event.bytes } : {}),
          source: event.source,
          state: event.state,
          ...(event.stage ? { stage: event.stage } : {}),
          ...(typeof event.progress === "number" ? { progress: event.progress } : {}),
          ...(event.error ? { error: event.error } : {}),
          ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
          updatedAt: event.ts ?? Date.now(),
        };
        const existingIdx = list.findIndex(matches);
        const next =
          existingIdx >= 0
            ? list.map((item, idx) => (idx === existingIdx ? { ...item, ...updated } : item))
            : [updated, ...list].slice(0, 30);
        return { ...prev, pendingImports: next };
      });
    };
    return subscribeMediaIngestStatus(applyIngestEvent);
  }, [projectId]);

  // Periodically prune expired waiting_upload tickets so abandoned MCP tickets don't linger.
  useEffect(() => {
    if (!current?.pendingImports?.length) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setFetched((prev) => {
        if (!prev?.pendingImports?.length) return prev;
        const filtered = prev.pendingImports.filter(
          (item) =>
            item.state !== "waiting_upload" ||
            !item.expiresAt ||
            Date.parse(item.expiresAt) > now,
        );
        return filtered.length === prev.pendingImports.length
          ? prev
          : { ...prev, pendingImports: filtered };
      });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [current?.pendingImports?.length]);

  // Refresh cached assetMetadata cleanly when worker-media finishes metadata/thumbnail/sprite/proxy jobs.
  useEffect(() => {
    if (!projectId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeMediaDerived((event) => {
      if (event.projectId !== projectId) return;
      if (
        event.kind !== "metadata" &&
        event.kind !== "thumbnail" &&
        event.kind !== "sprite" &&
        event.kind !== "waveform" &&
        event.kind !== "proxy"
      ) {
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void refreshFileTree();
      }, 350);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [projectId, refreshFileTree]);

  const assets = useMemo(
    () =>
      fileTree.filter((f) => !f.endsWith(".html") && !f.endsWith(".md") && !f.endsWith(".json")),
    [fileTree],
  );

  const fontAssets = useMemo<ImportedFontAsset[]>(
    () =>
      current?.fonts?.map(font => ({ ...font, url: buildProjectApiPath(projectId!, `/preview/${encodeUrlPath(font.path)}`) })) ?? (projectId ? assets : [])
        .filter((asset) => FONT_EXT.test(asset))
        .map((asset) => ({
          family: fontFamilyFromAssetPath(asset),
          path: asset,
          url: projectId ? buildProjectApiPath(projectId, `/preview/${encodeUrlPath(asset)}`) : "",
        })),
    [assets, projectId, current?.fonts],
  );

  return {
    projectDir,
    fileTree,
    fileTreeLoaded,
    refreshFileTree,
    compositions: compositionPaths,
    assets,
    fontAssets,
    assetNames: current?.assetNames,
    assetMetadata: current?.assetMetadata,
    pendingImports: current?.pendingImports ?? EMPTY_PENDING_IMPORTS,
    dismissPendingImport,
  };
}
