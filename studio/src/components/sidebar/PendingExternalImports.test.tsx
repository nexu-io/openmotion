// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingExternalImports } from "./PendingExternalImports";

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

describe("PendingExternalImports (MCP Option A placeholder cards)", () => {
  it("renders waiting_upload, downloading progress, and dismissible failed states", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onDismiss = vi.fn();

    await act(async () => {
      root!.render(
        <PendingExternalImports
          onDismiss={onDismiss}
          items={[
            {
              id: "t-1",
              ticketId: "t-1",
              filename: "agent-clip.mp4",
              bytes: 12 * 1024 * 1024,
              source: "mcp_upload",
              state: "waiting_upload",
              stage: "waiting_upload",
              updatedAt: Date.now(),
            },
            {
              id: "j-2",
              jobId: "j-2",
              filename: "remote-broll.mp4",
              source: "mcp_url",
              state: "processing",
              stage: "downloading",
              progress: 45,
              updatedAt: Date.now(),
            },
            {
              id: "j-3",
              jobId: "j-3",
              filename: "broken.mov",
              source: "mcp_upload",
              state: "failed",
              error: "Unsupported codec",
              updatedAt: Date.now(),
            },
          ]}
        />,
      );
    });

    const host = container.querySelector("[data-pending-external-imports]");
    expect(host).not.toBeNull();
    expect(host?.textContent).toContain("agent-clip.mp4");
    expect(host?.textContent).toContain("12.0 MB");
    expect(host?.textContent).toContain("remote-broll.mp4");
    expect(host?.textContent).toContain("45%");
    expect(host?.textContent).toContain("Unsupported codec");

    const dismissBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
    expect(dismissBtn).not.toBeNull();
    await act(async () => dismissBtn!.click());
    expect(onDismiss).toHaveBeenCalledWith("j-3");
  });
});
