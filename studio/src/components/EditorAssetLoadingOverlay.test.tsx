// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDITOR_ASSET_AUTO_RELEASE_MS,
  EDITOR_ASSET_ESCAPE_HATCH_MS,
  EDITOR_ASSET_PROGRESS_DEBOUNCE_MS,
  EDITOR_ASSET_PROGRESS_MIN_VISIBLE_MS,
  EditorAssetLoadingOverlay,
  EditorAssetProgressBar,
  triggerEditorAssetRetry,
  useEditorAssetReadiness,
} from "./EditorAssetLoadingOverlay";
import { usePlayerStore } from "../player/store/playerStore";
import { registerRetryFailedAssetsHandler } from "../player/store/readinessSlice";
import { thumbnailScheduler } from "../player/lib/thumbnailScheduler";
import { TIMELINE_PREVIEW_GATE_TIMEOUT_MS } from "../player/lib/clientCompositionCapture";

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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("EditorAssetLoadingOverlay", () => {
  it("renders a seamless solid cover with breathing mark, 4s escape hatch, and 12s auto-release", () => {
    const onSkip = vi.fn();
    act(() => {
      root!.render(<EditorAssetLoadingOverlay visible={true} onSkip={onSkip} />);
    });

    const overlay = host!.querySelector('[data-testid="editor-asset-loading-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute("data-visible")).toBe("true");
    expect(overlay?.textContent).toContain("Preparing project assets");
    expect(host!.querySelector('[data-testid="editor-asset-loading-skip"]')).toBeNull();

    // After 4s, the escape button appears cleanly and invokes onSkip when clicked.
    act(() => {
      vi.advanceTimersByTime(EDITOR_ASSET_ESCAPE_HATCH_MS + 20);
    });
    expect(overlay?.textContent).toContain("Still loading media…");
    const skipBtn = host!.querySelector<HTMLButtonElement>('[data-testid="editor-asset-loading-skip"]');
    expect(skipBtn).not.toBeNull();
    expect(skipBtn?.textContent).toContain("Enter editor now");
    act(() => skipBtn!.click());
    expect(onSkip).toHaveBeenCalledTimes(1);

    // Auto-releases at 12s if the user never clicked Skip.
    act(() => {
      vi.advanceTimersByTime(EDITOR_ASSET_AUTO_RELEASE_MS);
    });
    expect(onSkip).toHaveBeenCalledTimes(2);
  });

  it("fades out cleanly and unmounts once visible becomes false", () => {
    const onSkip = vi.fn();
    act(() => {
      root!.render(<EditorAssetLoadingOverlay visible={true} onSkip={onSkip} />);
    });
    act(() => {
      root!.render(<EditorAssetLoadingOverlay visible={false} onSkip={onSkip} />);
    });
    const overlay = host!.querySelector('[data-testid="editor-asset-loading-overlay"]');
    expect(overlay?.getAttribute("data-visible")).toBe("false");

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(host!.querySelector('[data-testid="editor-asset-loading-overlay"]')).toBeNull();
  });
});

describe("EditorAssetProgressBar", () => {
  it("debounces briefly so instant cache hits never paint the hairline", () => {
    act(() => {
      root!.render(
        <EditorAssetProgressBar loading={true} completed={0} total={9} />,
      );
    });
    act(() => {
      vi.advanceTimersByTime(EDITOR_ASSET_PROGRESS_DEBOUNCE_MS - 40);
    });
    expect(host!.querySelector('[data-testid="editor-asset-progress-bar"]')).toBeNull();

    act(() => {
      root!.render(
        <EditorAssetProgressBar loading={false} completed={9} total={9} />,
      );
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(host!.querySelector('[data-testid="editor-asset-progress-bar"]')).toBeNull();
  });

  it("renders a non-blocking hairline progress bar and holds it briefly once shown", () => {
    act(() => {
      root!.render(
        <EditorAssetProgressBar loading={true} completed={4} total={9} />,
      );
    });
    act(() => {
      vi.advanceTimersByTime(EDITOR_ASSET_PROGRESS_DEBOUNCE_MS + 20);
    });
    const bar = host!.querySelector('[data-testid="editor-asset-progress-bar"]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute("role")).toBe("progressbar");
    expect(bar?.getAttribute("aria-valuenow")).toBe("44");
    expect(host!.querySelector('[data-testid="editor-asset-loading-overlay"]')).toBeNull();
    expect(host!.querySelector('[data-testid="editor-asset-loading-skip"]')).toBeNull();

    // Completing immediately after mount still holds the bar for the minimum dwell time.
    act(() => {
      root!.render(
        <EditorAssetProgressBar loading={false} completed={9} total={9} />,
      );
    });
    act(() => {
      vi.advanceTimersByTime(EDITOR_ASSET_PROGRESS_MIN_VISIBLE_MS - 100);
    });
    expect(host!.querySelector('[data-testid="editor-asset-progress-bar"]')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(host!.querySelector('[data-testid="editor-asset-progress-bar"]')).toBeNull();
  });
});

describe("useEditorAssetReadiness", () => {
  it("blocks until files, preview first frame, and all assets settle; then never re-blocks on retry and cascades thumbnail retry", async () => {
    const showToast = vi.fn(() => 1);
    const onReloadPreview = vi.fn();
    const retryThumbSpy = vi.spyOn(thumbnailScheduler, "retryFailed");
    let latest!: ReturnType<typeof useEditorAssetReadiness>;

    function Harness({ fileTreeLoaded = false }: { fileTreeLoaded?: boolean }) {
      latest = useEditorAssetReadiness({
        projectId: "proj-1",
        fileTreeLoaded,
        unreachableProject: false,
        compositionMissing: false,
        showToast,
        onReloadPreview,
      });
      return null;
    }

    usePlayerStore.getState().beginTimelineSession("proj-1");
    const gen = usePlayerStore.getState().beginAssetReadinessLoad();

    act(() => root!.render(<Harness fileTreeLoaded={false} />));
    expect(latest.blocking).toBe(true);
    expect(latest.backgroundLoading).toBe(false);
    expect(usePlayerStore.getState().editorInputLocked).toBe(true);

    // File tree ready + preview booted, but assets still loading -> cover stays up.
    act(() => {
      usePlayerStore.getState().markPreviewBooted();
      root!.render(<Harness fileTreeLoaded={true} />);
    });
    expect(latest.blocking).toBe(true);

    const retrySpy = vi.fn(async () => {
      usePlayerStore.getState().updateAssetReadiness(
        { status: "ready", completed: 5, total: 5, failed: [] },
        gen,
      );
      return [];
    });
    registerRetryFailedAssetsHandler(gen, retrySpy);

    // All assets settle (with 1 failure) -> cover releases, input unlocks, failure Toast appears.
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

    expect(latest.blocking).toBe(false);
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

    // Subsequent in-place retry uses background hairline and never re-blocks the full cover.
    await act(async () => {
      await action.onClick();
    });
    expect(latest.blocking).toBe(false);
    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retryThumbSpy).toHaveBeenCalledWith("proj-1");
    expect(onReloadPreview).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenLastCalledWith("Assets reloaded", "info", "feedback");
  });

  it("hands off to the non-blocking background hairline when the user skips the initial cover", () => {
    const showToast = vi.fn(() => 1);
    let latest!: ReturnType<typeof useEditorAssetReadiness>;

    function Harness() {
      latest = useEditorAssetReadiness({
        projectId: "proj-skip",
        fileTreeLoaded: true,
        unreachableProject: false,
        compositionMissing: false,
        showToast,
      });
      return null;
    }

    usePlayerStore.getState().beginTimelineSession("proj-skip");
    usePlayerStore.getState().beginAssetReadinessLoad();

    act(() => root!.render(<Harness />));
    expect(latest.blocking).toBe(true);
    expect(latest.backgroundLoading).toBe(false);
    expect(usePlayerStore.getState().editorInputLocked).toBe(true);

    act(() => latest.skip());
    expect(latest.blocking).toBe(false);
    expect(latest.backgroundLoading).toBe(true);
    expect(usePlayerStore.getState().editorInputLocked).toBe(false);
  });

  it("falls back to reloading preview when retrying non-DOM-retryable failures such as fonts", async () => {
    const showToast = vi.fn(() => 1);
    const onReloadPreview = vi.fn();

    function Harness() {
      useEditorAssetReadiness({
        projectId: "proj-font",
        fileTreeLoaded: true,
        unreachableProject: false,
        compositionMissing: false,
        showToast,
        onReloadPreview,
      });
      return null;
    }

    usePlayerStore.getState().beginTimelineSession("proj-font");
    usePlayerStore.getState().markPreviewBooted();
    const gen = usePlayerStore.getState().beginAssetReadinessLoad();
    registerRetryFailedAssetsHandler(gen, async () => usePlayerStore.getState().assetReadinessFailed);

    act(() => root!.render(<Harness />));
    act(() => {
      usePlayerStore.getState().updateAssetReadiness(
        {
          status: "ready",
          completed: 1,
          total: 1,
          failed: [{ id: "fonts", label: "Fonts", kind: "font", reason: "timeout" }],
        },
        gen,
      );
    });

    await act(async () => {
      await triggerEditorAssetRetry();
    });
    expect(onReloadPreview).toHaveBeenCalledTimes(1);
  });

  it("releases the cover and hides the hairline when previewLoadError occurs", () => {
    const showToast = vi.fn(() => 1);
    let latest!: ReturnType<typeof useEditorAssetReadiness>;

    function Harness() {
      latest = useEditorAssetReadiness({
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
    expect(latest.blocking).toBe(true);

    act(() => {
      usePlayerStore.getState().setPreviewLoadError(true);
    });
    expect(latest.blocking).toBe(false);
    expect(latest.backgroundLoading).toBe(false);
    expect(usePlayerStore.getState().editorInputLocked).toBe(false);
  });

  it("holds the initial cover until registered composition and video filmstrip tasks settle", () => {
    const showToast = vi.fn(() => 1);
    let latest!: ReturnType<typeof useEditorAssetReadiness>;

    function Harness() {
      latest = useEditorAssetReadiness({
        projectId: "proj-strips",
        fileTreeLoaded: true,
        compositionLoading: false,
        unreachableProject: false,
        compositionMissing: false,
        showToast,
      });
      return null;
    }

    usePlayerStore.getState().beginTimelineSession("proj-strips");
    usePlayerStore.getState().markPreviewBooted();
    const gen = usePlayerStore.getState().beginAssetReadinessLoad();
    usePlayerStore.getState().registerTimelinePreviewTask("comp:proj-strips:intro", gen);
    usePlayerStore.getState().registerTimelinePreviewTask("video:proj-strips:hero.mp4", gen);
    usePlayerStore.getState().updateAssetReadiness(
      { status: "ready", completed: 3, total: 3, failed: [] },
      gen,
    );

    act(() => root!.render(<Harness />));
    // Core assets are ready, but 2 clip filmstrips are still pending -> cover stays up.
    expect(latest.blocking).toBe(true);

    act(() => {
      usePlayerStore.getState().settleTimelinePreviewTask("comp:proj-strips:intro", gen);
    });
    expect(latest.blocking).toBe(true);

    act(() => {
      usePlayerStore.getState().settleTimelinePreviewTask("video:proj-strips:hero.mp4", gen);
    });
    expect(latest.blocking).toBe(false);
  });

  it("releases the cover after TIMELINE_PREVIEW_GATE_TIMEOUT_MS if a clip filmstrip stalls", () => {
    const showToast = vi.fn(() => 1);
    let latest!: ReturnType<typeof useEditorAssetReadiness>;

    function Harness() {
      latest = useEditorAssetReadiness({
        projectId: "proj-stall",
        fileTreeLoaded: true,
        compositionLoading: false,
        unreachableProject: false,
        compositionMissing: false,
        showToast,
      });
      return null;
    }

    usePlayerStore.getState().beginTimelineSession("proj-stall");
    usePlayerStore.getState().markPreviewBooted();
    const gen = usePlayerStore.getState().beginAssetReadinessLoad();
    usePlayerStore.getState().registerTimelinePreviewTask("comp:proj-stall:slow", gen);
    usePlayerStore.getState().updateAssetReadiness(
      { status: "ready", completed: 2, total: 2, failed: [] },
      gen,
    );

    act(() => root!.render(<Harness />));
    expect(latest.blocking).toBe(true);

    act(() => {
      vi.advanceTimersByTime(TIMELINE_PREVIEW_GATE_TIMEOUT_MS + 50);
    });
    expect(latest.blocking).toBe(false);
  });
});
