import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPreviewAdapter,
  PREVIEW_BRIDGE_SOURCE,
  PREVIEW_BRIDGE_VERSION,
} from "./previewAdapter";

function frame(projectId = "project-1", token = "token-1") {
  const src = `http://studio.test/api/projects/${projectId}/preview?pt=${token}`;
  const contentWindow = { postMessage: vi.fn() } as unknown as Window;
  const iframe = {
    src,
    getAttribute: (name: string) => (name === "src" ? src : null),
    contentWindow,
    contentDocument: null,
  } as unknown as HTMLIFrameElement;
  return { iframe, contentWindow };
}

describe("PreviewAdapter", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      location: { origin: "http://studio.test", href: "http://studio.test/" },
      crypto: { randomUUID: () => "request-1" },
      setTimeout,
      clearTimeout,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("accepts only the active iframe, exact origin, project and token", () => {
    const { iframe, contentWindow } = frame();
    const adapter = createPreviewAdapter({ iframe });
    const valid = {
      source: contentWindow,
      origin: window.location.origin,
      data: {
        source: PREVIEW_BRIDGE_SOURCE,
        version: PREVIEW_BRIDGE_VERSION,
        type: "preview-ready",
        projectId: "project-1",
        token: "token-1",
      },
    } as unknown as MessageEvent;

    expect(adapter.accepts(valid)).toBe(true);
    expect(
      adapter.accepts(
        {
          source: contentWindow,
          origin: "https://foreign.example",
          data: valid.data,
        } as unknown as MessageEvent,
      ),
    ).toBe(false);
    expect(
      adapter.accepts(
        {
          source: contentWindow,
          origin: window.location.origin,
          data: { ...valid.data, token: "other-token" },
        } as unknown as MessageEvent,
      ),
    ).toBe(false);
  });

  it("posts with the exact preview origin and scoped identity", () => {
    const { iframe, contentWindow } = frame();
    const adapter = createPreviewAdapter({ iframe });
    const requestId = adapter.send("handshake");
    expect(requestId).toBeTruthy();
    expect(contentWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "openmotion-studio",
        type: "handshake",
        projectId: "project-1",
        token: "token-1",
        requestId,
      }),
      window.location.origin,
    );
  });

  it("returns null for a local preview without a project token", () => {
    const src = "http://studio.test/api/projects/project-1/preview";
    const contentWindow = { postMessage: vi.fn() } as unknown as Window;
    const iframe = {
      src,
      getAttribute: (name: string) => (name === "src" ? src : null),
      contentWindow,
      contentDocument: null,
    } as unknown as HTMLIFrameElement;
    const adapter = createPreviewAdapter({ iframe });
    expect(adapter.send("handshake")).toBeNull();
  });
});
