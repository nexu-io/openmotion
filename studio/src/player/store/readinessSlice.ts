/** Gates `timelineReady` on the composition's declared readiness inputs
 * (media, compute, and the paint-and-idle default) instead of just a known
 * duration. The generation counter is module-scope, not store state: it
 * guards an in-flight settlement, not something a component reads, so
 * bumping it shouldn't trigger a render. */
import type { StoreApi } from "zustand";
import { settleCompositionReadiness } from "@hyperframes/core/composition-readiness";
import type { PreviewAssetFailure, PreviewAssetProgress } from "../lib/previewAssetReadiness";

export interface PlaybackReadinessSlice {
  timelineReady: boolean;
  /** Releases deferred editing work after preview boot, including a responsive runtime waiting
   * on slow media. A displayable first frame is reported separately by the player. */
  previewBooted: boolean;
  /** Active composition asset readiness for background progress and failure recovery. */
  assetReadinessPhase: "loading" | "ready";
  assetReadinessCompleted: number;
  assetReadinessTotal: number;
  assetReadinessFailed: PreviewAssetFailure[];
  assetReadinessPendingAsset?: string;
  assetReadinessGeneration: number;
  /** True after the user clicks the escape button or the cover auto-releases on timeout. */
  assetReadinessSkipped: boolean;
  /** True while the full-cover initial opening gate is actively blocking editor input. */
  editorInputLocked: boolean;
  /** True while the user explicitly triggered an in-place retry of failed preview assets. */
  assetReadinessRetrying: boolean;
  /** True when the live preview reported a fatal boot/load error and shows its own retry UI. */
  previewLoadError: boolean;
  /** True when an active video/audio element at the current playhead is buffering media data. */
  mediaBuffering: boolean;
  setTimelineReady: (ready: boolean) => void;
  markPreviewBooted: () => void;
  beginAssetReadinessLoad: () => number;
  updateAssetReadiness: (progress: PreviewAssetProgress, generation?: number) => void;
  skipAssetReadiness: () => void;
  setEditorInputLocked: (locked: boolean) => void;
  setAssetReadinessRetrying: (retrying: boolean) => void;
  setPreviewLoadError: (hasError: boolean) => void;
  setMediaBuffering: (buffering: boolean) => void;
  playLocked: boolean;
  setPlayLocked: (locked: boolean) => void;
  /** Sets timelineReady once doc's readiness inputs settle, or immediately
   *  if doc is null. A wait a later call supersedes never wins the race.
   *  Waits for doc's load step first: it pauses and rewinds the preview, so a
   *  Play enabled before it would be undone. */
  requestTimelineReady: (doc: Document | null) => void;
  /** Called by the preview's load step for the document it ran on. */
  markPreviewLoadStep: (doc: Document) => void;
}

let timelineReadyGeneration = 0;
let assetReadinessGenerationCounter = 0;
let retryFailedAssetsEntry: {
  generation: number;
  handler: () => Promise<PreviewAssetFailure[]>;
} | null = null;
const loadStepDocs = new WeakSet<Document>();
let awaitingLoadStep: { doc: Document; generation: number } | null = null;

export function registerRetryFailedAssetsHandler(
  generation: number,
  handler: (() => Promise<PreviewAssetFailure[]>) | null,
): void {
  if (!handler) {
    if (retryFailedAssetsEntry?.generation === generation) {
      retryFailedAssetsEntry = null;
    }
    return;
  }
  retryFailedAssetsEntry = { generation, handler };
}

export function hasRetryFailedAssetsHandler(): boolean {
  return retryFailedAssetsEntry !== null;
}

export async function retryFailedPreviewAssets(): Promise<PreviewAssetFailure[]> {
  const entry = retryFailedAssetsEntry;
  if (!entry) return [];
  return entry.handler();
}

/** For a full timeline reset: bumps the generation so any requestTimelineReady
 * wait in flight can never resolve into what replaced it. */
export function resetPlaybackReadinessState(): Pick<
  PlaybackReadinessSlice,
  | "timelineReady"
  | "previewBooted"
  | "assetReadinessPhase"
  | "assetReadinessCompleted"
  | "assetReadinessTotal"
  | "assetReadinessFailed"
  | "assetReadinessPendingAsset"
  | "assetReadinessGeneration"
  | "assetReadinessSkipped"
  | "editorInputLocked"
  | "assetReadinessRetrying"
  | "previewLoadError"
  | "mediaBuffering"
> {
  timelineReadyGeneration++;
  assetReadinessGenerationCounter++;
  retryFailedAssetsEntry = null;
  return {
    timelineReady: false,
    previewBooted: false,
    assetReadinessPhase: "loading",
    assetReadinessCompleted: 0,
    assetReadinessTotal: 0,
    assetReadinessFailed: [],
    assetReadinessPendingAsset: undefined,
    assetReadinessGeneration: assetReadinessGenerationCounter,
    assetReadinessSkipped: false,
    editorInputLocked: false,
    assetReadinessRetrying: false,
    previewLoadError: false,
    mediaBuffering: false,
  };
}

export function createPlaybackReadinessSlice(
  set: StoreApi<PlaybackReadinessSlice>["setState"],
): PlaybackReadinessSlice {
  const settle = (doc: Document, generation: number) =>
    settleCompositionReadiness(doc, () => {
      if (generation === timelineReadyGeneration) set({ timelineReady: true });
    });
  return {
    timelineReady: false,
    previewBooted: false,
    assetReadinessPhase: "loading",
    assetReadinessCompleted: 0,
    assetReadinessTotal: 0,
    assetReadinessFailed: [],
    assetReadinessGeneration: 0,
    assetReadinessSkipped: false,
    editorInputLocked: false,
    assetReadinessRetrying: false,
    previewLoadError: false,
    mediaBuffering: false,
    markPreviewBooted: () => set({ previewBooted: true }),
    beginAssetReadinessLoad: () => {
      const generation = ++assetReadinessGenerationCounter;
      retryFailedAssetsEntry = null;
      set({
        assetReadinessPhase: "loading",
        assetReadinessCompleted: 0,
        assetReadinessTotal: 0,
        assetReadinessFailed: [],
        assetReadinessPendingAsset: undefined,
        assetReadinessGeneration: generation,
        assetReadinessSkipped: false,
        assetReadinessRetrying: false,
        previewLoadError: false,
        mediaBuffering: false,
      });
      return generation;
    },
    updateAssetReadiness: (progress, generation) =>
      set((state) => {
        if (generation !== undefined && generation !== state.assetReadinessGeneration) {
          return state;
        }
        return {
          assetReadinessPhase: progress.status,
          assetReadinessCompleted: progress.completed,
          assetReadinessTotal: progress.total,
          assetReadinessFailed: progress.failed,
          assetReadinessPendingAsset: progress.status === "loading" ? progress.pendingAsset : undefined,
        };
      }),
    skipAssetReadiness: () =>
      set({
        assetReadinessSkipped: true,
        editorInputLocked: false,
      }),
    setEditorInputLocked: (locked) =>
      set((state) => (state.editorInputLocked === locked ? state : { editorInputLocked: locked })),
    setAssetReadinessRetrying: (retrying) => set({ assetReadinessRetrying: retrying }),
    setPreviewLoadError: (hasError) => set({ previewLoadError: hasError }),
    setMediaBuffering: (buffering) =>
      set((state) => (state.mediaBuffering === buffering ? state : { mediaBuffering: buffering })),
    playLocked: false,
    setPlayLocked: (locked) => set({ playLocked: locked }),
    setTimelineReady: (ready) => {
      timelineReadyGeneration++;
      set({ timelineReady: ready });
    },
    requestTimelineReady: (doc) => {
      const generation = ++timelineReadyGeneration;
      if (!doc) return set({ timelineReady: true });
      if (!loadStepDocs.has(doc)) {
        awaitingLoadStep = { doc, generation };
        return;
      }
      settle(doc, generation);
    },
    markPreviewLoadStep: (doc) => {
      loadStepDocs.add(doc);
      if (awaitingLoadStep?.doc !== doc) return;
      const { generation } = awaitingLoadStep;
      awaitingLoadStep = null;
      settle(doc, generation);
    },
  };
}
