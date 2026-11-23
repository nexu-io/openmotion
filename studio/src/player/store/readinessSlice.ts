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
  /** Latched when the project's first preview shows its first frame (or fails), kept through edit
   *  reloads, so work that must not compete with the boot waits for it once. */
  previewBooted: boolean;
  /** Active composition asset readiness for unified editor unlock. */
  assetReadinessPhase: "loading" | "ready";
  assetReadinessCompleted: number;
  assetReadinessTotal: number;
  assetReadinessFailed: PreviewAssetFailure[];
  assetReadinessSkipped: boolean;
  assetReadinessGeneration: number;
  /** True when the live preview reported a fatal boot/load error and shows its own retry UI. */
  previewLoadError: boolean;
  /** Initial visible timeline composition preview capture progress integrated into unified loading. */
  timelinePreviewCompleted: number;
  timelinePreviewTotal: number;
  timelinePreviewSettledInitial: boolean;
  /** True while StudioApp holds the unified editor loading lock (gates global edit & playback hotkeys). */
  editorInputLocked: boolean;
  setTimelineReady: (ready: boolean) => void;
  markPreviewBooted: () => void;
  beginAssetReadinessLoad: () => number;
  updateAssetReadiness: (progress: PreviewAssetProgress, generation?: number) => void;
  skipAssetReadiness: () => void;
  setPreviewLoadError: (hasError: boolean) => void;
  registerTimelinePreviewTask: (taskId: string, generation: number) => void;
  settleTimelinePreviewTask: (taskId: string, generation: number) => void;
  markInitialTimelinePreviewGateSettled: (generation: number) => void;
  setEditorInputLocked: (locked: boolean) => void;
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
let timelinePreviewGeneration = 0;
const timelinePreviewRegistered = new Set<string>();
const timelinePreviewSettled = new Set<string>();
let retryFailedAssetsEntry: {
  generation: number;
  handler: () => Promise<PreviewAssetFailure[]>;
} | null = null;
const loadStepDocs = new WeakSet<Document>();
let awaitingLoadStep: { doc: Document; generation: number } | null = null;

function resetTimelinePreviewTracking(generation: number): void {
  timelinePreviewGeneration = generation;
  timelinePreviewRegistered.clear();
  timelinePreviewSettled.clear();
}

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
  | "assetReadinessSkipped"
  | "assetReadinessGeneration"
  | "previewLoadError"
  | "timelinePreviewCompleted"
  | "timelinePreviewTotal"
  | "timelinePreviewSettledInitial"
> {
  timelineReadyGeneration++;
  assetReadinessGenerationCounter++;
  resetTimelinePreviewTracking(assetReadinessGenerationCounter);
  retryFailedAssetsEntry = null;
  return {
    timelineReady: false,
    previewBooted: false,
    assetReadinessPhase: "loading",
    assetReadinessCompleted: 0,
    assetReadinessTotal: 0,
    assetReadinessFailed: [],
    assetReadinessSkipped: false,
    assetReadinessGeneration: assetReadinessGenerationCounter,
    previewLoadError: false,
    timelinePreviewCompleted: 0,
    timelinePreviewTotal: 0,
    timelinePreviewSettledInitial: false,
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
    assetReadinessSkipped: false,
    assetReadinessGeneration: 0,
    previewLoadError: false,
    timelinePreviewCompleted: 0,
    timelinePreviewTotal: 0,
    timelinePreviewSettledInitial: false,
    editorInputLocked: false,
    markPreviewBooted: () => set({ previewBooted: true }),
    beginAssetReadinessLoad: () => {
      const generation = ++assetReadinessGenerationCounter;
      resetTimelinePreviewTracking(generation);
      retryFailedAssetsEntry = null;
      set({
        assetReadinessPhase: "loading",
        assetReadinessCompleted: 0,
        assetReadinessTotal: 0,
        assetReadinessFailed: [],
        assetReadinessSkipped: false,
        assetReadinessGeneration: generation,
        previewLoadError: false,
        timelinePreviewCompleted: 0,
        timelinePreviewTotal: 0,
        timelinePreviewSettledInitial: false,
      });
      return generation;
    },
    updateAssetReadiness: (progress, generation) =>
      set((state) => {
        if (generation !== undefined && generation !== state.assetReadinessGeneration) {
          return state;
        }
        const skipped = state.assetReadinessSkipped || progress.skipped === true;
        return {
          assetReadinessPhase: skipped ? "ready" : progress.status,
          assetReadinessCompleted: progress.completed,
          assetReadinessTotal: progress.total,
          assetReadinessFailed: progress.failed,
          assetReadinessSkipped: skipped,
        };
      }),
    skipAssetReadiness: () =>
      set({
        assetReadinessPhase: "ready",
        assetReadinessSkipped: true,
        timelinePreviewSettledInitial: true,
      }),
    setPreviewLoadError: (hasError) => set({ previewLoadError: hasError }),
    registerTimelinePreviewTask: (taskId, generation) =>
      set((state) => {
        if (
          !taskId ||
          generation !== state.assetReadinessGeneration ||
          generation !== timelinePreviewGeneration ||
          state.timelinePreviewSettledInitial
        ) {
          return state;
        }
        if (timelinePreviewRegistered.has(taskId)) return state;
        timelinePreviewRegistered.add(taskId);
        return {
          timelinePreviewTotal: timelinePreviewRegistered.size,
          timelinePreviewCompleted: timelinePreviewSettled.size,
        };
      }),
    settleTimelinePreviewTask: (taskId, generation) =>
      set((state) => {
        if (
          !taskId ||
          generation !== state.assetReadinessGeneration ||
          generation !== timelinePreviewGeneration ||
          !timelinePreviewRegistered.has(taskId) ||
          timelinePreviewSettled.has(taskId)
        ) {
          return state;
        }
        timelinePreviewSettled.add(taskId);
        return {
          timelinePreviewCompleted: timelinePreviewSettled.size,
          timelinePreviewTotal: timelinePreviewRegistered.size,
        };
      }),
    markInitialTimelinePreviewGateSettled: (generation) =>
      set((state) => {
        if (generation !== state.assetReadinessGeneration || state.timelinePreviewSettledInitial) {
          return state;
        }
        return { timelinePreviewSettledInitial: true };
      }),
    setEditorInputLocked: (locked) => set({ editorInputLocked: locked }),
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
