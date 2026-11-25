import { orderedEditFixture } from "../../tests/orderedEditFixture";
import { describe, expect, it, vi } from "vitest";
import { setCachedCloudDisklessMode } from "./cloudRuntime";
import { saveProjectFilesWithHistory, saveServerRewriteWithHistory, type StudioWriteHistory } from "./studioFileHistory";
import { serializeStudioFileMutation } from "./studioFileMutationCoordinator";

describe("saveProjectFilesWithHistory", () => {
  it("projects a structural edit before its write and restores it once if that write fails", async () => {
    const order: string[] = [];
    const save = saveProjectFilesWithHistory({
      projectId: "p", label: "Duplicate clip", files: { "index.html": before => before + "-copy" },
      readFile: async () => "clip",
      projectPending(files) {
        expect(files["index.html"]).toEqual({ before: "clip", after: "clip-copy" });
        order.push("show");
        return () => { order.push("restore"); };
      },
      writeFile: async () => { order.push("write"); throw new Error("rejected"); },
      recordEdit: async () => { order.push("history"); },
    });
    await expect(save).rejects.toThrow("rejected");
    expect(order).toEqual(["show", "write", "restore"]);
  });

  it("passes each cloud action label and reuses a window only for the same coalescible action", async () => {
    const writeFile = vi.fn();
    const save = (label: string, coalesceKey?: string) => saveProjectFilesWithHistory({
      projectId: "p", files: { "index.html": () => "edited" }, readFile: async () => "original",
      writeFile, recordEdit: async () => {}, label, coalesceKey,
    });
    setCachedCloudDisklessMode(true);
    try {
      await save("Edit source", "source:index.html");
      await save("Edit source", "source:index.html");
      await save("Split clip");
      await save("Edit source", "source:index.html");
      const histories = writeFile.mock.calls.map(args => args[4]);
      expect(histories[0]).toEqual({label: "Edit source", windowId: expect.any(String)});
      expect(histories[1]).toEqual(histories[0]);
      expect(histories[2].label).toBe("Split clip");
      expect(new Set([histories[1].windowId, histories[2].windowId, histories[3].windowId]).size).toBe(3);
    } finally {
      setCachedCloudDisklessMode(null);
    }
  });

  it("allocates a single window before the rewrite and reuses it for the follow-up save", async () => {
    setCachedCloudDisklessMode(true);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ content: "before" })));
    try {
      const writeFile = vi.fn();
      const rewrite = vi.fn(async (_source: string, _history?: StudioWriteHistory) => ({ disk: "removed", after: "shrunk" }));
      await saveServerRewriteWithHistory({
        projectId: "p", path: "index.html", label: "Delete timeline clip",
        writeFile, rewrite, recordEdit: vi.fn(),
      });
      const history = { label: "Delete timeline clip", windowId: expect.any(String) };
      expect(rewrite).toHaveBeenCalledWith("before", history);
      expect(writeFile).toHaveBeenCalledExactlyOnceWith("index.html", "shrunk", "removed", undefined,
        rewrite.mock.lastCall?.[1]);
    } finally {
      vi.unstubAllGlobals();
      setCachedCloudDisklessMode(null);
    }
  });

  it("reads before content, writes after content, and records a history entry", async () => {
    const reads: Record<string, string> = { "index.html": "before" };
    const writes: Record<string, string> = {};
    const recordEdit = vi.fn();

    await saveProjectFilesWithHistory({
      projectId: "project-1",
      label: "Move layer",
      files: { "index.html": () => "after" },
      readFile: async (path) => reads[path],
      writeFile: async (path, content) => {
        writes[path] = content;
      },
      recordEdit,
    });

    expect(writes).toEqual({ "index.html": "after" });
    expect(recordEdit).toHaveBeenCalledWith({
      label: "Move layer",
      coalesceKey: undefined,
      files: { "index.html": { before: "before", after: "after" } },
    });
  });

  /**
   * Deleting a clip POSTs `remove-element`, which rewrites the file server-side,
   * and only then saves the duration shrink. Expecting the content read before
   * the mutation made the server refuse that write as a conflict: the save queue
   * paused on the 409 and the clip stayed on the timeline until a reload.
   */
  it("expects what is on disk, not the undo baseline, when they differ", async () => {
    const expectations: Record<string, string | undefined> = {};
    const recordEdit = vi.fn();

    await saveProjectFilesWithHistory({
      projectId: "project-1",
      label: "Delete timeline clip",
      files: { "index.html": () => "removed+shrunk" },
      readFile: async () => "original",
      diskContent: { "index.html": "removed" },
      writeFile: async (path, _content, expectedContent) => {
        expectations[path] = expectedContent;
      },
      recordEdit,
    });

    expect(expectations["index.html"]).toBe("removed");
    // Undo still goes all the way back, which is the whole reason the two are
    // allowed to differ.
    expect(recordEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        files: { "index.html": { before: "original", after: "removed+shrunk" } },
      }),
    );
  });

  it("still expects the undo baseline when nothing says otherwise", async () => {
    const expectations: Record<string, string | undefined> = {};
    await saveProjectFilesWithHistory({
      projectId: "project-1",
      label: "Move layer",
      files: { "index.html": () => "after" },
      readFile: async () => "before",
      writeFile: async (path, _content, expectedContent) => {
        expectations[path] = expectedContent;
      },
      recordEdit: vi.fn(),
    });
    expect(expectations["index.html"]).toBe("before");
  });

  it("skips writes and history for unchanged content", async () => {
    const writeFile = vi.fn();
    const recordEdit = vi.fn();

    const changedPaths = await saveProjectFilesWithHistory({
      projectId: "project-1",
      label: "Edit layer",
      files: { "index.html": () => "same" },
      readFile: async () => "same",
      writeFile,
      recordEdit,
    });

    expect(changedPaths).toEqual([]);
    expect(writeFile).not.toHaveBeenCalled();
    expect(recordEdit).not.toHaveBeenCalled();
  });

  it("rolls back files already written when a later file write fails", async () => {
    const reads: Record<string, string> = {
      "index.html": "index-before",
      "scene.html": "scene-before",
    };
    const writes: Array<[string, string]> = [];
    const recordEdit = vi.fn();

    await expect(
      saveProjectFilesWithHistory({
        projectId: "project-1",
        label: "Move layer",
        files: {
          "index.html": () => "index-after",
          "scene.html": () => "scene-after",
        },
        readFile: async (path) => reads[path],
        writeFile: async (path, content) => {
          writes.push([path, content]);
          if (path === "scene.html") {
            throw new Error("disk full");
          }
        },
        recordEdit,
      }),
    ).rejects.toThrow("disk full");

    expect(writes).toEqual([
      ["index.html", "index-after"],
      ["scene.html", "scene-after"],
      ["index.html", "index-before"],
    ]);
    expect(recordEdit).not.toHaveBeenCalled();
  });

  it("rolls back written files when the injected history recorder throws", async () => {
    const reads: Record<string, string> = {
      "index.html": "index-before",
      "scene.html": "scene-before",
    };
    const writes: Array<[string, string]> = [];

    await expect(
      saveProjectFilesWithHistory({
        projectId: "project-1",
        label: "Move layer",
        files: {
          "index.html": () => "index-after",
          "scene.html": () => "scene-after",
        },
        readFile: async (path) => reads[path],
        writeFile: async (path, content) => {
          writes.push([path, content]);
        },
        recordEdit: async () => {
          throw new Error("history unavailable");
        },
      }),
    ).rejects.toThrow("history unavailable");

    expect(writes).toEqual([
      ["index.html", "index-after"],
      ["scene.html", "scene-after"],
      ["scene.html", "scene-before"],
      ["index.html", "index-before"],
    ]);
  });

  it("reports rollback failure with the original write failure", async () => {
    const reads: Record<string, string> = {
      "index.html": "index-before",
      "scene.html": "scene-before",
    };
    const writes: Array<[string, string]> = [];

    await expect(
      saveProjectFilesWithHistory({
        projectId: "project-1",
        label: "Move layer",
        files: {
          "index.html": () => "index-after",
          "scene.html": () => "scene-after",
        },
        readFile: async (path) => reads[path],
        writeFile: async (path, content) => {
          writes.push([path, content]);
          if (path === "scene.html" && content === "scene-after") {
            throw new Error("write denied");
          }
          if (path === "index.html" && content === "index-before") {
            throw new Error("rollback denied");
          }
        },
        recordEdit: vi.fn(),
      }),
    ).rejects.toThrow("rollback did not complete");

    expect(writes).toEqual([
      ["index.html", "index-after"],
      ["scene.html", "scene-after"],
      ["index.html", "index-before"],
    ]);
  });

  it("builds from what the file holds after an earlier same-file mutation completes", async () => {
    let disk = "before";
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writeFile = vi.fn(async (_path: string, content: string) => {
      disk = content;
    });
    const priorMutation = serializeStudioFileMutation(writeFile, "index.html", async () => {
      await blocked;
      disk = "sdk-after";
    });
    const readFile = vi.fn(async () => disk);
    const recordEdit = vi.fn();

    const save = saveProjectFilesWithHistory({
      projectId: "project-1",
      label: "Edit source",
      files: { "index.html": (current) => `${current}+editor` },
      readFile,
      writeFile,
      recordEdit,
    });

    await Promise.resolve();
    expect(readFile).not.toHaveBeenCalled();
    release();
    await priorMutation;
    await save;

    expect(disk).toBe("sdk-after+editor");
    expect(recordEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        files: { "index.html": { before: "sdk-after", after: "sdk-after+editor" } },
      }),
    );
  });
  it("keeps the same undo window when a repeated gesture batches two compositions", async () => {
    const source = '<main data-composition-id="scene" data-duration="12" data-hf-id="root"><div data-hf-id="hf-clip" data-start="0" data-duration="2"></div></main>';
    const server = orderedEditFixture("p", {"index.html": source, "child.html": source});
    const writeFile = vi.fn();
    const save = (start: number) => saveProjectFilesWithHistory({
      projectId: "p", label: "Move clips", coalesceKey: "drag", continuous: true, writeFile,
      files: Object.fromEntries(Object.keys(server.files).map(path => [path, (html: string) => html.replace(/data-start="\d+"/, 'data-start="' + start + '"')])),
      commandForWrite: () => ({ kind: "moveClip", hfId: "hf-clip", start }),
      readFile: async path => server.files[path]!, recordEdit: vi.fn(),
    });
    setCachedCloudDisklessMode(true);
    try {
      await save(1);
      await save(2);
      const operations = server.packets.flat();
      expect(operations).toHaveLength(2);
      expect(operations[0]?.undoGroup).toEqual(expect.any(String));
      expect(operations[1]?.undoGroup).toBe(operations[0]?.undoGroup);
      expect(operations.every(operation => operation.files.length === 2)).toBe(true);
      expect(writeFile).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      setCachedCloudDisklessMode(null);
    }
  });
});
