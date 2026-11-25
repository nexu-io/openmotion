import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrderedTextEditOperation } from "../../../shared/ordered-text-edits";
import { applyTextPatch } from "../../../shared/text-patch";
import { compositionInsertionFailureMessage } from "../i18n/editorErrors";
import { setCachedCloudDisklessMode } from "./cloudRuntime";
import { observeSourceRead } from "./confirmedTextSources";
import { saveOrderedTimeline } from "./orderedTimelineEdits";
import { commitTimelineCompositionInsertion } from "./timelineCompositionInsert";

afterEach(() => {
  vi.unstubAllGlobals();
  setCachedCloudDisklessMode(null);
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("commitTimelineCompositionInsertion", () => {
  it("projects successive cold drops while the first receipt is held, including an edit to the child between drops", async () => {
    setCachedCloudDisklessMode(true);
    const projectId = "cold-ordered-drops";
    const targetPath = "index.html", sourcePath = "compositions/slide.html";
    const sources: Record<string, string> = {
      [targetPath]: '<main id="root" data-composition-id="main"></main>',
      [sourcePath]: '<main data-composition-id="slide" data-duration="2"></main>',
    };
    const writes: OrderedTextEditOperation[][] = [];
    const reads: string[] = [];
    const first = Promise.withResolvers<void>();
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method !== "POST") {
        const path = decodeURIComponent(url.split("/files/")[1]!);
        reads.push(path);
        return Response.json({ content: sources[path], version: "initial" }, { headers: {
          "X-OpenMotion-Text-Edits": "1", "X-OpenMotion-Ordered-Edits": "1",
        } });
      }
      expect(url).toBe("/api/projects/" + projectId + "/text-edits/batch");
      const ops: OrderedTextEditOperation[] = JSON.parse(String(init.body)).operations;
      writes.push(ops);
      if (writes.length === 1) await first.promise;
      const committed = ops.map(op => {
        const file = op.files[0]!;
        sources[file.path] = "content" in file ? file.content : applyTextPatch(sources[file.path]!, file.patch);
        return { id: op.id, changedPaths: [file.path], versions: { [file.path]: "accepted-" + op.id } };
      });
      return Response.json({ committed });
    });

    const writeFile = vi.fn(), recordEdit = vi.fn(), selectHost = vi.fn(), onProjected = vi.fn(), refresh = vi.fn();
    const drop = () => commitTimelineCompositionInsertion({
      projectId, targetPath, sourcePath, start: 0, track: 0, writeFile, recordEdit, selectHost, onProjected, refresh,
    });
    const initial = drop();
    try {
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      const childEdit = saveOrderedTimeline(projectId, [{ path: sourcePath, apply: source => source.replace('duration="2"', 'duration="3"') }],
        "Change child duration", { recordEdit });
      const second = drop(), third = drop();
      await vi.waitFor(() => expect(onProjected).toHaveBeenCalledTimes(3));
      expect(writes).toHaveLength(1);
      expect(recordEdit).not.toHaveBeenCalled();
      expect(onProjected.mock.calls.map(([host]) => [host.track, host.duration])).toEqual([[0, 2], [1, 3], [2, 3]]);
      expect(new Set(selectHost.mock.calls.map(([key]) => key)).size).toBe(3);
      first.resolve();
      await Promise.all([initial, childEdit, second, third]);

      expect(reads.sort()).toEqual([sourcePath, targetPath].sort());
      expect(writes.map(ops => ops.length)).toEqual([1, 3]);
      const [child, parent, following] = writes[1]!;
      expect(parent!.dependencies).toEqual({ [sourcePath]: { after: child!.id } });
      expect(parent!.files[0]!.baseVersion).toBe("accepted-" + writes[0]![0]!.id);
      expect(following!.files[0]!.baseVersion).toEqual({ after: parent!.id });
      expect(following!.dependencies).toEqual({ [sourcePath]: { after: child!.id } });
      expect(sources[targetPath]!.match(/data-composition-src=/g)).toHaveLength(3);
      expect(selectHost).toHaveBeenCalledTimes(3);
      expect(recordEdit).toHaveBeenCalledTimes(4);
      expect(refresh).toHaveBeenCalledOnce();
      expect(writeFile).not.toHaveBeenCalled();
    } finally {
      first.resolve();
    }
  });

  it("explains an invalid duration on a cached composition before doing any writes", async () => {
    const projectId = "cached-invalid-duration";
    const supported = new Response(null, { headers: { "X-OpenMotion-Text-Edits": "1" } });
    observeSourceRead(projectId, "index.html", supported, { content: '<main data-composition-id="main"></main>', version: "parent" });
    observeSourceRead(projectId, "scene.html", supported, {
      content: '<div data-composition-id="scene" data-duration="invalid"></div>', version: "child",
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const writeFile = vi.fn();
    const recordEdit = vi.fn();

    const error = await commitTimelineCompositionInsertion({
      projectId, targetPath: "index.html", sourcePath: "scene.html", start: 1, track: 0,
      writeFile, recordEdit, selectHost: vi.fn(), refresh: vi.fn(),
    }).catch((cause: unknown) => cause);

    expect(compositionInsertionFailureMessage(error)).toBe("Set a valid duration on the composition before adding it to the timeline.");
    expect(fetch).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(recordEdit).not.toHaveBeenCalled();
  });

  it("records one history entry, then selects and refreshes once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ content: "before", version: "v1" }))
      .mockResolvedValueOnce(
        response({
          path: "index.html",
          hostId: "headline",
          track: 3,
          duration: 8,
          before: "before",
          after: "after",
          version: "v2",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const writeFile = vi.fn();
    const recordEdit = vi.fn();
    const observeVersion = vi.fn();
    const selectHost = vi.fn();
    const resync = vi.fn();
    const refresh = vi.fn();

    const element = await commitTimelineCompositionInsertion({
      projectId: "launch#demo",
      targetPath: "index.html",
      sourcePath: "headline.html",
      start: 4,
      track: 2,
      canvasPosition: { left: 345, top: 124 },
      writeFile,
      recordEdit,
      observeVersion,
      selectHost,
      resync,
      refresh,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/projects/launch%23demo/files/index.html",
      "/api/projects/launch%23demo/file-mutations/insert-composition/index.html",
    ]);
    const body = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ canvasPosition: { left: 345, top: 124 }, expectedVersion: "v1" });
    expect(recordEdit).toHaveBeenCalledOnce();
    expect(writeFile).not.toHaveBeenCalled();
    expect(observeVersion).toHaveBeenCalledWith("index.html", "v2");
    expect(selectHost).toHaveBeenCalledWith("index.html#headline");
    expect(resync).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(element).toMatchObject({ key: "index.html#headline", start: 4, track: 3, duration: 8 });
  });

  it("CAS-restores the server write when history registration fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response({ content: "before", version: "v1" }))
        .mockResolvedValueOnce(
          response({
            path: "index.html",
            hostId: "headline",
            track: 2,
            duration: 8,
            before: "before",
            after: "after",
            version: "v2",
          }),
        ),
    );
    const writeFile = vi.fn();
    const refresh = vi.fn();

    await expect(
      commitTimelineCompositionInsertion({
        projectId: "demo",
        targetPath: "index.html",
        sourcePath: "headline.html",
        start: 4,
        track: 2,
        writeFile,
        recordEdit: vi.fn().mockRejectedValue(new Error("history failed")),
        selectHost: vi.fn(),
        refresh,
      }),
    ).rejects.toThrow("history failed");

    expect(writeFile).toHaveBeenCalledWith("index.html", "before", "after");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps a durable insertion successful and refreshes when resync fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response({ content: "before", version: "v1" }))
        .mockResolvedValueOnce(
          response({
            path: "index.html",
            hostId: "headline",
            track: 2,
            duration: 8,
            before: "before",
            after: "after",
            version: "v2",
          }),
        ),
    );
    const refresh = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      commitTimelineCompositionInsertion({
        projectId: "demo",
        targetPath: "index.html",
        sourcePath: "headline.html",
        start: 4,
        track: 2,
        writeFile: vi.fn(),
        recordEdit: vi.fn(),
        selectHost: vi.fn(),
        resync: () => {
          throw new Error("resync failed");
        },
        refresh,
      }),
    ).resolves.toMatchObject({ key: "index.html#headline", duration: 8 });

    expect(refresh).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "[Studio] Composition insertion committed but preview resync failed",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});
