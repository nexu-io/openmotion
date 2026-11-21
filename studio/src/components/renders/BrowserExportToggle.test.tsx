// @vitest-environment happy-dom

import { StudioHostContext } from "../../motion/StudioHost";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderQueue, type StartRenderHandler } from "./RenderQueue";
import { usePreviewIframeStore } from "../../player/store/previewIframeStore";
import { ISOLATED_PREVIEW_EXPORT_REASON } from "../../render/browserExportPreflight";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("VideoEncoder", class {});
  vi.stubGlobal("VideoFrame", class {});
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  usePreviewIframeStore.getState().setIframe(null);
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("BrowserExportToggle integration in RenderQueue", () => {
  it("unblocks export when ffmpeg is missing and routes startRender with engine='browser'", () => {
    const onStartRender = vi.fn<StartRenderHandler>();
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root?.render(
        <StudioHostContext.Provider value={{ mvpEditor: false }}>
          <RenderQueue
            jobs={[]}
            projectId="demo"
            onDelete={vi.fn()}
            onClearCompleted={vi.fn()}
            onStartRender={onStartRender}
            isRendering={false}
            compositionDimensions={{ width: 1920, height: 1080 }}
            ffmpeg={{ ok: false, mode: "remote-worker", title: "Render worker unavailable" }}
            ffmpegChecking={false}
            onRecheckFfmpeg={vi.fn()}
          />
        </StudioHostContext.Provider>,
      );
    });

    const exportBtn = host.querySelector<HTMLButtonElement>('[data-testid="renders-export"]')!;
    expect(exportBtn.disabled).toBe(true);

    const toggle = host.querySelector<HTMLElement>('[role="switch"][aria-label="Browser export (Beta)"]')!;
    expect(toggle).toBeTruthy();
    act(() => toggle.click());

    expect(exportBtn.disabled).toBe(false);
    act(() => exportBtn.click());

    expect(onStartRender).toHaveBeenCalledExactlyOnceWith(
      "mp4",
      "standard",
      "auto",
      30,
      false,
      undefined,
      "browser",
    );
  });

  it("disables browser export for non-open compositions and isolated preview iframes", () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root?.render(
        <StudioHostContext.Provider value={{ mvpEditor: false }}>
          <RenderQueue
            jobs={[]}
            projectId="demo"
            onDelete={vi.fn()}
            onClearCompleted={vi.fn()}
            onStartRender={vi.fn()}
            isRendering={false}
            canBrowserExport={false}
            compositionDimensions={{ width: 1920, height: 1080 }}
            ffmpeg={{ ok: false, mode: "remote-worker", title: "Render worker unavailable" }}
            ffmpegChecking={false}
            onRecheckFfmpeg={vi.fn()}
          />
        </StudioHostContext.Provider>,
      );
    });

    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Browser export (Beta)"]')!;
    const exportBtn = host.querySelector<HTMLButtonElement>('[data-testid="renders-export"]')!;
    expect(toggle.getAttribute("aria-disabled") === "true" || toggle.disabled).toBe(true);
    expect(exportBtn.disabled).toBe(true);
    expect(host.textContent).toContain("Browser export only applies to the currently open composition.");

    const isolatedIframe = document.createElement("iframe");
    isolatedIframe.setAttribute("src", "https://preview.example.com/api/projects/demo/preview");
    Object.defineProperty(isolatedIframe, "contentDocument", {
      get: () => {
        throw new Error("Blocked a frame with origin");
      },
    });
    act(() => {
      usePreviewIframeStore.getState().setIframe(isolatedIframe);
      root?.render(
        <StudioHostContext.Provider value={{ mvpEditor: false }}>
          <RenderQueue
            jobs={[]}
            projectId="demo"
            onDelete={vi.fn()}
            onClearCompleted={vi.fn()}
            onStartRender={vi.fn()}
            isRendering={false}
            canBrowserExport={true}
            compositionDimensions={{ width: 1920, height: 1080 }}
            ffmpeg={{ ok: false, mode: "remote-worker", title: "Render worker unavailable" }}
            ffmpegChecking={false}
            onRecheckFfmpeg={vi.fn()}
          />
        </StudioHostContext.Provider>,
      );
    });

    expect(exportBtn.disabled).toBe(true);
    expect(host.textContent).toContain(ISOLATED_PREVIEW_EXPORT_REASON);
  });
});
