// @vitest-environment happy-dom
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/I18n";
import { EditorAssetLoadingOverlay } from "../components/EditorAssetLoadingOverlay";
import {
  EditorOpeningGateHost,
  SuspenseOpeningGateMarker,
} from "./editorOpeningGate";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("EditorOpeningGateHost unified opening cover", () => {
  it("keeps one continuous DOM overlay across shell resolve, Suspense chunk load, and editor asset readiness", async () => {
    const onSkip = vi.fn();
    let resolveChunk!: () => void;
    let chunkReady = false;
    const chunkPromise = new Promise<void>((resolve) => {
      resolveChunk = () => {
        chunkReady = true;
        resolve();
      };
    });

    function LazyEditor({ blocking }: { blocking: boolean }) {
      if (!chunkReady) throw chunkPromise;
      return (
        <div data-testid="mounted-editor">
          <EditorAssetLoadingOverlay visible={blocking} onSkip={onSkip} />
        </div>
      );
    }

    function Harness({
      shellLoading,
      targetProjectId,
      editorBlocking,
    }: {
      shellLoading: boolean;
      targetProjectId: string | null;
      editorBlocking: boolean;
    }) {
      return (
        <I18nProvider initialLocale="en">
          <EditorOpeningGateHost
            shellLoading={shellLoading}
            suppressed={false}
            targetProjectId={targetProjectId}
          >
            {targetProjectId ? (
              <Suspense fallback={<SuspenseOpeningGateMarker />}>
                <LazyEditor blocking={editorBlocking} />
              </Suspense>
            ) : null}
          </EditorOpeningGateHost>
        </I18nProvider>
      );
    }

    // Phase 1: shell resolving project route.
    await act(async () => {
      root.render(<Harness shellLoading={true} targetProjectId={null} editorBlocking={true} />);
    });
    const phase1Overlay = container.querySelector('[data-testid="editor-asset-loading-overlay"]');
    expect(phase1Overlay).not.toBeNull();
    expect(phase1Overlay?.getAttribute("data-visible")).toBe("true");
    expect(phase1Overlay?.textContent).toContain("Opening project…");
    expect(container.querySelectorAll(".motion-loading")).toHaveLength(1);

    // Phase 2: route resolved, lazy editor chunk suspends -> exact same DOM node remains mounted.
    await act(async () => {
      root.render(<Harness shellLoading={false} targetProjectId="proj-1" editorBlocking={true} />);
    });
    const phase2Overlay = container.querySelector('[data-testid="editor-asset-loading-overlay"]');
    expect(phase2Overlay).toBe(phase1Overlay);
    expect(phase2Overlay?.getAttribute("data-visible")).toBe("true");
    expect(container.querySelectorAll(".motion-loading")).toHaveLength(1);

    // Advance 2.5s while suspended before editor mounts; escape clock carries over continuously.
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    expect(container.querySelector('[data-testid="editor-asset-loading-skip"]')).toBeNull();

    // Phase 3: lazy editor resolves and delegates to the host cover -> still the exact same DOM node.
    await act(async () => {
      resolveChunk();
      await chunkPromise;
    });
    const phase3Overlay = container.querySelector('[data-testid="editor-asset-loading-overlay"]');
    expect(phase3Overlay).toBe(phase1Overlay);
    expect(phase3Overlay?.getAttribute("data-visible")).toBe("true");
    expect(container.querySelectorAll(".motion-loading")).toHaveLength(1);

    // Only 1.5s more (4s total across phases) reveals the working escape button without restarting timers.
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    const skipBtn = container.querySelector<HTMLButtonElement>('[data-testid="editor-asset-loading-skip"]');
    expect(skipBtn).not.toBeNull();
    expect(phase3Overlay?.textContent).toContain("Opening project…");
    act(() => skipBtn!.click());
    expect(onSkip).toHaveBeenCalledTimes(1);

    // Phase 4: editor signals ready -> fades out over 200ms and unmounts cleanly.
    await act(async () => {
      root.render(<Harness shellLoading={false} targetProjectId="proj-1" editorBlocking={false} />);
    });
    expect(phase3Overlay?.getAttribute("data-visible")).toBe("false");
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(container.querySelector('[data-testid="editor-asset-loading-overlay"]')).toBeNull();
  });

  it("unmounts immediately without fade when suppressed by an error screen", async () => {
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <EditorOpeningGateHost shellLoading={true} suppressed={false} targetProjectId={null}>
            <div />
          </EditorOpeningGateHost>
        </I18nProvider>,
      );
    });
    expect(container.querySelector(".motion-loading")).not.toBeNull();

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <EditorOpeningGateHost shellLoading={false} suppressed={true} targetProjectId={null}>
            <div role="alert">Error</div>
          </EditorOpeningGateHost>
        </I18nProvider>,
      );
    });
    expect(container.querySelector(".motion-loading")).toBeNull();
  });

  it("preserves the new project's delegation when switching directly between two mounted editors", async () => {
    const skipA = vi.fn();
    const skipB = vi.fn();

    function SwitchHarness({ projectId }: { projectId: "a" | "b" }) {
      return (
        <I18nProvider initialLocale="en">
          <EditorOpeningGateHost shellLoading={false} suppressed={false} targetProjectId={projectId}>
            <EditorAssetLoadingOverlay
              key={projectId}
              visible={true}
              onSkip={projectId === "a" ? skipA : skipB}
              escapeDelayMs={100}
            />
          </EditorOpeningGateHost>
        </I18nProvider>
      );
    }

    await act(async () => {
      root.render(<SwitchHarness projectId="a" />);
    });
    const overlay = container.querySelector('[data-testid="editor-asset-loading-overlay"]');
    expect(overlay?.getAttribute("data-visible")).toBe("true");

    await act(async () => {
      root.render(<SwitchHarness projectId="b" />);
    });
    expect(container.querySelector('[data-testid="editor-asset-loading-overlay"]')).toBe(overlay);
    expect(overlay?.getAttribute("data-visible")).toBe("true");

    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    const skipBtn = container.querySelector<HTMLButtonElement>('[data-testid="editor-asset-loading-skip"]');
    expect(skipBtn).not.toBeNull();
    act(() => skipBtn!.click());
    expect(skipA).not.toHaveBeenCalled();
    expect(skipB).toHaveBeenCalledTimes(1);
  });
});
