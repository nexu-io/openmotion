// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filterPendingExternalImports, PendingExternalImports } from "./PendingExternalImports";
import type { ManualImportBatch } from "../../hooks/manualImportResults";
import type { PendingExternalImport } from "../../hooks/useFileTree";

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

  it("allows dismissing a stale processing placeholder while keeping fresh processing items non-dismissible", async () => {
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
              id: "stale-job",
              jobId: "stale-job",
              filename: "timed-out.mp4",
              source: "web_upload",
              state: "processing",
              updatedAt: Date.now() - 6 * 60_000,
            },
          ]}
        />,
      );
    });

    const dismissBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
    expect(dismissBtn).not.toBeNull();
    await act(async () => dismissBtn!.click());
    expect(onDismiss).toHaveBeenCalledWith("stale-job");
  });

  it("deduplicates timed-out web_upload items already shown in ManualImportResults while keeping unrelated MCP imports", () => {
    const batch: ManualImportBatch = {
      id: "batch-1",
      projectId: "proj-1",
      items: [
        {
          id: "batch-1-0",
          name: "hero.mp4",
          targetPath: "assets/hero.mp4",
          status: "unknown",
        },
      ],
      paths: [],
      busy: false,
      listing: "ready",
    };
    const pending: PendingExternalImport[] = [
      {
        id: "web-1",
        filename: "hero.mp4",
        targetPath: "assets/hero.mp4",
        source: "web_upload",
        state: "processing",
        updatedAt: Date.now(),
      },
      {
        // Even if an expired ticket lost its web_upload source, matching targetPath still deduplicates it.
        id: "orphan-1",
        filename: "hero.mp4",
        targetPath: "assets/hero.mp4",
        source: "mcp_upload",
        state: "processing",
        updatedAt: Date.now(),
      },
      {
        id: "mcp-1",
        filename: "agent-broll.mp4",
        targetPath: "assets/agent-broll.mp4",
        source: "mcp_upload",
        state: "processing",
        updatedAt: Date.now(),
      },
    ];

    expect(filterPendingExternalImports(pending, batch).map((item) => item.id)).toEqual(["mcp-1"]);
  });
});
