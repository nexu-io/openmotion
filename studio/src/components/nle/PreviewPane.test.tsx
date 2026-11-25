// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewPane } from "./PreviewPane";
import { StudioHostContext } from "../../motion/StudioHost";
import { PreviewReadOnlyProvider } from "../editor/previewReadOnlyContext";
import { usePlayerStore } from "../../player/store/playerStore";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../editor/PreviewGuides", () => ({ PreviewGuides: () => <i data-testid="guides" /> }));
const emptyState = vi.hoisted(() => ({ empty: false }));
vi.mock("./useEmptyPreview", () => ({ useEmptyPreview: () => emptyState.empty }));
vi.mock("../../player", () => ({ PlayerControls: ({ onToggleFullscreen, isFullscreen }: { onToggleFullscreen: () => void; isFullscreen: boolean }) => <button data-testid="transport" onClick={onToggleFullscreen}>{isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}</button> }));
vi.mock("./NLEPreview", () => ({ NLEPreview: ({ canEditWhileLoading }: { canEditWhileLoading: boolean }) => <i data-testid="preview" data-can-edit={canEditWhileLoading} /> }));
const session = { shell: null as { projectId: string; activeCompPath: string; writeBlockedReason: string | null; renderQueue: { isRendering: boolean } } | null, timelineDisabled: false };
vi.mock("../../contexts/StudioContext", async original => ({
  ...(await original<typeof import("../../contexts/StudioContext")>()),
  useStudioShellContextOptional: () => session.shell,
}));
vi.mock("./CompositionBreadcrumb", () => ({ CompositionBreadcrumb: () => <nav data-testid="breadcrumb" /> }));
vi.mock("./AssetPreviewOverlay", () => ({ AssetPreviewOverlay: () => null }));
vi.mock("../../motion/ReviewComposerOverlay", () => ({ ReviewComposerOverlay: () => null }));
vi.mock("../../motion/ReviewAnnotationOverlay", () => ({ ReviewAnnotationOverlay: () => null }));
vi.mock("./usePreviewBlockDrop", () => ({
  usePreviewBlockDrop: () => ({
    isDragOver: false,
    handleDragEnter: vi.fn(),
    handleDragOver: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDrop: vi.fn(),
  }),
}));
vi.mock("./NLEContext", () => ({
  useNLEContext: () => ({
    projectId: "p",
    iframeRef: { current: null },
    togglePlay: vi.fn(),
    seek: vi.fn(),
    onIframeLoad: vi.fn(),
    compositionStack: [{ id: "master", previewUrl: undefined }, { id: "first.html", previewUrl: "/first.html" }],
    handleNavigateComposition: vi.fn(),
    setCompositionLoading: vi.fn(),
    timelineDisabled: session.timelineDisabled,
    hasLoadedOnceRef: { current: false },
    previewCompositionSize: null,
    setPreviewCompositionSize: vi.fn(),
  }),
}));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("PreviewPane", () => {
  it("offers continued editing only for the writable current timeline while its first frame is pending", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const render = (readOnly = false) => act(() => root.render(<PreviewReadOnlyProvider readOnly={readOnly}><PreviewPane /></PreviewReadOnlyProvider>));
    const canEdit = () => host.querySelector('[data-testid="preview"]')?.getAttribute("data-can-edit");
    try {
      session.timelineDisabled = true;
      usePlayerStore.setState({ timelineProjectId: "p", authoredTimelinePath: "first.html", timelineReady: false });
      render();
      expect(canEdit()).toBe("false");
      session.shell = { projectId: "p", activeCompPath: "first.html", writeBlockedReason: null, renderQueue: { isRendering: false } };
      render();
      expect(canEdit()).toBe("true");
      render(true);
      expect(canEdit()).toBe("false");
      act(() => usePlayerStore.getState().setEditorInputLocked(true));
      render();
      expect(canEdit()).toBe("false");
      act(() => usePlayerStore.getState().setEditorInputLocked(false));
      session.shell.writeBlockedReason = "Source changed";
      render();
      expect(canEdit()).toBe("false");
      session.shell.writeBlockedReason = null;
      act(() => usePlayerStore.setState({ authoredTimelinePath: "previous.html" }));
      render();
      expect(canEdit()).toBe("false");
    } finally {
      act(() => root.unmount());
      session.timelineDisabled = false;
      session.shell = null;
      usePlayerStore.getState().reset();
    }
  });
  it("draws the guides in the pane itself, not through the previewOverlay slot", () => {
    const host = document.createElement("div");
    document.body.append(host);
    act(() => createRoot(host).render(<PreviewPane />));
    expect(host.querySelector('[data-testid="guides"]')).not.toBeNull();
  });
});

it("omits duplicate preview navigation only in the MVP", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<PreviewPane />));
  expect(host.querySelector('[data-testid="breadcrumb"]')).not.toBeNull();
  expect(host.querySelector('[data-studio-fullscreen-target]')).not.toBeNull();
  act(() => root.render(<StudioHostContext.Provider value={{ mvpEditor: true }}><PreviewPane /></StudioHostContext.Provider>));
  expect(host.querySelector('[data-testid="breadcrumb"]')).toBeNull();
  expect(host.querySelector('[data-studio-fullscreen-target]')).not.toBeNull();
  expect(host.querySelector('[data-testid="guides"]')).not.toBeNull();
  act(() => root.unmount());
});

it('fullscreen hides editing guides without remounting the player and restores them on exit', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<StudioHostContext.Provider value={{ mvpEditor: true }}><PreviewPane previewOverlay={<i data-testid="selection" />} /></StudioHostContext.Provider>));
  const target = host.querySelector<HTMLElement>('[data-studio-fullscreen-target]')!, preview = host.querySelector('[data-testid="preview"]');
  const enter = vi.fn(async () => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: target }); document.dispatchEvent(new Event('fullscreenchange')); });
  Object.defineProperty(target, 'requestFullscreen', { configurable: true, value: enter });
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="transport"]')!.click());
  expect(enter).toHaveBeenCalledOnce(); expect(host.querySelector('[data-testid="preview"]')).toBe(preview);
  expect(host.querySelector('[data-testid="guides"]')).toBeNull(); expect(host.querySelector('[data-testid="selection"]')).toBeNull();
  expect(host.querySelector('[data-fullscreen-playback-surface]')).not.toBeNull();
  await act(async () => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null }); document.dispatchEvent(new Event('fullscreenchange')); });
  expect(host.querySelector('[data-testid="preview"]')).toBe(preview); expect(host.querySelector('[data-testid="selection"]')).not.toBeNull();
  await act(async () => root.unmount());
});

it("hides placeholder transport while empty and restores controls when content arrives without unmounting preview", () => {
  const host = document.createElement("div"); const root = createRoot(host);
  const render = () => act(() => root.render(<StudioHostContext.Provider value={{ mvpEditor: true }}><PreviewPane /></StudioHostContext.Provider>));
  emptyState.empty = false; render();
  const preview = host.querySelector('[data-testid="preview"]');
  expect(host.querySelector('[data-testid="transport"]')).not.toBeNull();
  emptyState.empty = true; render();
  expect(host.querySelector('[data-preview-empty]')).not.toBeNull();
  expect(host.querySelector('[data-testid="transport"]')).toBeNull();
  expect(host.querySelector('[data-testid="preview"]')).toBe(preview);
  emptyState.empty = false; render();
  expect(host.querySelector('[data-preview-empty]')).toBeNull();
  expect(host.querySelector('[data-testid="transport"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="preview"]')).toBe(preview);
  act(() => root.unmount());
});
