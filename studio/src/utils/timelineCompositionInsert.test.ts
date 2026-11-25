import { afterEach, describe, expect, it, vi } from "vitest";
import { compositionInsertionFailureMessage } from "../i18n/editorErrors";
import { observeSourceRead } from "./confirmedTextSources";
import { commitTimelineCompositionInsertion } from "./timelineCompositionInsert";

afterEach(() => vi.unstubAllGlobals());

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("commitTimelineCompositionInsertion", () => {
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
