// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearVisitedEditorLoadingScopesForTest,
  EDITOR_LOADING_REVISIT_DEBOUNCE_MS,
  EditorAssetLoadingOverlay,
  useEditorAssetReadinessGate,
} from "./EditorAssetLoadingOverlay";
import { usePlayerStore } from "../player/store/playerStore";
import { registerRetryFailedAssetsHandler } from "../player/store/readinessSlice";
import { setCachedCloudDisklessMode } from "../utils/cloudRuntime";
import {
  clearClientCompositionCaptureCacheForTest,
  MAX_INITIAL_TIMELINE_PREVIEW_GATE,
  setClientCompositionCaptureCapabilityForTest,
  TIMELINE_PREVIEW_GATE_TIMEOUT_MS,
} from "../player/lib/clientCompositionCapture";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  usePlayerStore.getState().reset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  setCachedCloudDisklessMode(null);
  setClientCompositionCaptureCapabilityForTest(null);
  clearClientCompositionCaptureCacheForTest();
  clearVisitedEditorLoadingScopesForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("EditorAssetLoadingOverlay", () => {
  it("debounces for 150ms so warm cache hits never flash the overlay", () => {
    const onSkip = vi.fn();
    act(() => {
      root!.render(
        <EditorAssetLoadingOverlay loading={true} completed={0} total={19} loadGeneration={1} onSkip={onSkip} />,
      );
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(host!.querySelector('[data-testid="editor-asset-loading-overlay"]')).toBeNull();

    // Finishes before 150ms -> still never mounted.
    act(() => {
      root!.render(
        <EditorAssetLoadingOverlay loading={false} completed={19} total={19} loadGeneration={1} onSkip={onSkip} />,
      );
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(host!.querySelector('[data-testid="editor-asset-loading-overlay"]')).toBeNull();
  });

  it("renders asset progress after 150ms and exposes skip escape hatch after 8s", () => {
    const onSkip = vi.fn();
    act(() => {
      root!.render(
        <EditorAssetLoadingOverlay loading={true} completed={14} total={19} loadGeneration={1} onSkip={onSkip} />,
      );
    });
    act(() => {
      vi.advanceTimersByTime(160);
    });
    const overlay = host!.querySelector('[data-testid="editor-asset-loading-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toContain("14 / 19 assets");
    expect(overlay?.textContent).toContain("74%");
    expect(host!.querySelector('[data-testid="editor-asset-loading-skip"]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    const skipBtn = host!.querySelector<HTMLButtonElement>('[data-testid="editor-asset-loading-skip"]');
    expect(skipBtn).not.toBeNull();
    act(() => skipBtn!.click());
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});

describe("useEditorAssetReadinessGate", () => {
  it("locks editor and hotkeys until fileTree + timeline + assets are ready, then toasts partial failures with retry", async () => {
    const showToast = vi.fn(() => 1);
    let latest!: ReturnType<typeof useEditorAssetReadinessGate>;

    function Harness({ fileTreeLoaded }: { fileTreeLoaded: boolean }) {
      latest = useEditorAssetReadinessGate({
        projectId: "proj-1",
        fileTreeLoaded,
        unreachableProject: false,
        compositionMissing: false,
        showToast,
      });
      return null;
    }

    usePlayerStore.getState().beginTimelineSession("proj-1");
    const gen = usePlayerStore.getState().beginAssetReadinessLoad();

    act(() => root!.render(<Harness fileTreeLoaded={false} />));
    expect(latest.locked).toBe(true);
    expect(usePlayerStore.getState().editorInputLocked).toBe(true);

    act(() => root!.render(<Harness fileTreeLoaded={true} />));
    expect(latest.locked).toBe(true);

    act(() => {
      usePlayerStore.getState().setTimelineReady(true);
    });
    // Still locked while composition assets are loading.
    expect(latest.locked).toBe(true);

    const retrySpy = vi.fn(async () => []);
    registerRetryFailedAssetsHandler(gen, retrySpy);

    act(() => {
      usePlayerStore.getState().updateAssetReadiness(
        {
          status: "ready",
          completed: 5,
          total: 5,
          failed: [{ id: "img-2", label: "sarah.jpg", kind: "image", reason: "error" }],
        },
        gen,
      );
    });

    expect(latest.locked).toBe(false);
    expect(usePlayerStore.getState().editorInputLocked).toBe(false);
    expect(showToast).toHaveBeenCalledTimes(1);
    const [message, tone, presentation, action] = showToast.mock.calls[0] as unknown as [
      string,
      string,
      string,
      { label: string; onClick: () => Promise<void> },
    ];
    expect(message).toContain("sarah.jpg");
    expect(tone).toBe("error");
    expect(presentation).toBe("feedback");
    expect(action.label).toBe("Retry");

    await act(async () => {
      await action.onClick();
    });
    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenLastCalledWith("Assets reloaded", "info", "feedback");
  });

  it("releases the lock immediately when previewLoadError occurs", () => {
    const showToast = vi.fn(() => 1);
    let latest!: ReturnType<typeof useEditorAssetReadinessGate>;

    function Harness() {
      latest = useEditorAssetReadinessGate({
        projectId: "proj-err",
        fileTreeLoaded: true,
        unreachableProject: false,
        compositionMissing: false,
        showToast,
      });
      return null;
    }

    usePlayerStore.getState().beginTimelineSession("proj-err");
    act(() => root!.render(<Harness />));
    expect(latest.locked).toBe(true);

    act(() => {
      usePlayerStore.getState().setPreviewLoadError(true);
    });
    expect(latest.locked).toBe(false);
    expect(usePlayerStore.getState().editorInputLocked).toBe(false);
  });

  it("includes initial cloud timeline composition preview captures in the unified loading gate and never re-locks after unlock", () => {
    setCachedCloudDisklessMode(true);
    setClientCompositionCaptureCapabilityForTest(true);
    const showToast = vi.fn(() => 1);
    let latest!: ReturnType<typeof useEditorAssetReadinessGate>;

    function Harness() {
      latest = useEditorAssetReadinessGate({
        projectId: "proj-cloud",
        fileTreeLoaded: true,
        unreachableProject: false,
        compositionMissing: false,
        showToast,
      });
      return null;
    }

    usePlayerStore.getState().beginTimelineSession("proj-cloud");
    usePlayerStore.setState({
      thumbnailMode: "adaptive",
      elements: [
        {
          id: "scene-1",
          tag: "div",
          compositionSrc: "compositions/scene-1.html",
          start: 0,
          duration: 5,
          track: 0,
        },
      ],
    });
    const gen = usePlayerStore.getState().beginAssetReadinessLoad();

    act(() => root!.render(<Harness />));
    act(() => {
      usePlayerStore.getState().setTimelineReady(true);
      usePlayerStore.getState().updateAssetReadiness(
        { status: "ready", completed: 3, total: 3, failed: [] },
        gen,
      );
    });

    // Even before CompositionThumbnail mounts and registers its capture task,
    // the expected composition slot is reserved so progress never hits 100% and reverses.
    expect(latest.locked).toBe(true);
    expect(latest.completed).toBe(3);
    expect(latest.total).toBe(4);

    act(() => {
      usePlayerStore.getState().registerTimelinePreviewTask("proj-cloud:scene-1:0", gen);
    });

    // Gate stays locked while initial timeline preview capture is running, with combined progress.
    expect(latest.locked).toBe(true);
    expect(latest.completed).toBe(3);
    expect(latest.total).toBe(4);

    act(() => {
      usePlayerStore.getState().settleTimelinePreviewTask("proj-cloud:scene-1:0", gen);
    });
    expect(latest.locked).toBe(false);
    expect(latest.completed).toBe(4);
    expect(latest.total).toBe(4);

    // Later zoom/clip mounts in the same generation must never re-lock the editor.
    act(() => {
      usePlayerStore.getState().registerTimelinePreviewTask("proj-cloud:scene-2:0", gen);
    });
    expect(latest.locked).toBe(false);
  });

  it("caps blocking timeline preview slots on large projects and releases to background after timeout", () => {
    setCachedCloudDisklessMode(true);
    setClientCompositionCaptureCapabilityForTest(true);
    const showToast = vi.fn(() => 1);
    let latest!: ReturnType<typeof useEditorAssetReadinessGate>;

    function Harness() {
      latest = useEditorAssetReadinessGate({
        projectId: "proj-large",
        activeCompPath: "index.html",
        fileTreeLoaded: true,
        unreachableProject: false,
        compositionMissing: false,
        showToast,
      });
      return null;
    }

    usePlayerStore.getState().beginTimelineSession("proj-large");
    usePlayerStore.setState({
      thumbnailMode: "adaptive",
      elements: Array.from({ length: 12 }, (_, idx) => ({
        id: `scene-${idx}`,
        tag: "div",
        compositionSrc: `compositions/scene-${idx}.html`,
        start: idx * 5,
        duration: 5,
        track: 0,
      })),
    });
    const gen = usePlayerStore.getState().beginAssetReadinessLoad();

    act(() => root!.render(<Harness />));
    act(() => {
      usePlayerStore.getState().setTimelineReady(true);
      usePlayerStore.getState().updateAssetReadiness(
        { status: "ready", completed: 2, total: 2, failed: [] },
        gen,
      );
      usePlayerStore.getState().registerTimelinePreviewTask("proj-large:scene-0:0", gen);
    });

    // Only MAX_INITIAL_TIMELINE_PREVIEW_GATE (4) clips reserve unified gate slots, not all 12.
    expect(latest.locked).toBe(true);
    expect(latest.completed).toBe(2);
    expect(latest.total).toBe(2 + MAX_INITIAL_TIMELINE_PREVIEW_GATE);

    // If a slow capture stalls past the timeline-preview ceiling, unlock cleanly to background capture.
    act(() => {
      vi.advanceTimersByTime(TIMELINE_PREVIEW_GATE_TIMEOUT_MS + 50);
    });
    expect(latest.locked).toBe(false);
  });

  it("raises visual overlay debounce on revisit to a previously loaded scope", () => {
    const showToast = vi.fn(() => 1);
    let latest!: ReturnType<typeof useEditorAssetReadinessGate>;

    function Harness({ projectId }: { projectId: string }) {
      latest = useEditorAssetReadinessGate({
        projectId,
        activeCompPath: "index.html",
        fileTreeLoaded: true,
        unreachableProject: false,
        compositionMissing: false,
        showToast,
      });
      return null;
    }

    usePlayerStore.getState().beginTimelineSession("proj-revisit");
    const gen1 = usePlayerStore.getState().beginAssetReadinessLoad();
    act(() => root!.render(<Harness projectId="proj-revisit" />));
    expect(latest.debounceMs).toBe(150);

    act(() => {
      usePlayerStore.getState().setTimelineReady(true);
      usePlayerStore.getState().updateAssetReadiness(
        { status: "ready", completed: 1, total: 1, failed: [] },
        gen1,
      );
    });
    expect(latest.locked).toBe(false);

    // Revisiting the same scope uses the longer revisit anti-flash debounce.
    act(() => {
      usePlayerStore.getState().beginAssetReadinessLoad();
    });
    expect(latest.locked).toBe(true);
    expect(latest.debounceMs).toBe(EDITOR_LOADING_REVISIT_DEBOUNCE_MS);
  });
});
