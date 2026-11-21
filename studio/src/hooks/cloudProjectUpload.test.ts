// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ASSET_BYTES } from "../../../shared/asset-limits";
import {
  buildProjectUploadTargetPath,
  inferUploadMimeType,
  isCloudDirectUploadFile,
  uploadCloudProjectFile,
} from "./cloudProjectUpload";

class MockMediaJobEventSource {
  static instances: MockMediaJobEventSource[] = [];
  onerror: (() => void) | null = null;
  listeners = new Map<string, (event: MessageEvent) => void>();
  closed = false;

  constructor(readonly url: string) {
    MockMediaJobEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, listener);
  }

  close() {
    this.closed = true;
  }

  emitProgress(payload: Record<string, unknown>) {
    this.listeners.get("progress")?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

describe("cloudProjectUpload", () => {
  beforeEach(() => {
    MockMediaJobEventSource.instances = [];
    vi.stubGlobal("EventSource", MockMediaJobEventSource);
    // Use fetch path in tests by stubbing XMLHttpRequest undefined unless explicitly tested.
    vi.stubGlobal("XMLHttpRequest", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("classifies binary media and fonts for direct S3 upload while keeping SVG and text on small-file route", () => {
    expect(isCloudDirectUploadFile(new File(["x"], "hero.mp4", { type: "video/mp4" }))).toBe(true);
    expect(isCloudDirectUploadFile(new File(["x"], "clip.MOV"))).toBe(true);
    expect(isCloudDirectUploadFile(new File(["x"], "song.wav"))).toBe(true);
    expect(isCloudDirectUploadFile(new File(["x"], "photo.png", { type: "image/png" }))).toBe(true);
    expect(isCloudDirectUploadFile(new File(["x"], "font.woff2"))).toBe(true);

    expect(isCloudDirectUploadFile(new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }))).toBe(false);
    expect(isCloudDirectUploadFile(new File(["<html>"], "index.html", { type: "text/html" }))).toBe(false);
    expect(isCloudDirectUploadFile(new File(["{}"], "data.json", { type: "application/json" }))).toBe(false);
  });

  it("infers MIME types when browser File.type is empty and resolves collision-free target paths", () => {
    expect(inferUploadMimeType(new File(["x"], "clip.mp4"))).toBe("video/mp4");
    expect(inferUploadMimeType(new File(["x"], "font.woff2"))).toBe("font/woff2");

    const existing = new Set(["assets/clip.mp4", "assets/clip (2).mp4"]);
    expect(buildProjectUploadTargetPath("clip.mp4", "assets", existing)).toBe("assets/clip (3).mp4");
    expect(buildProjectUploadTargetPath("intro.mp4", undefined, existing)).toBe("intro.mp4");
  });

  it("rejects empty and oversized files locally without touching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const emptyRes = await uploadCloudProjectFile({
      projectId: "proj-1",
      file: new File([], "empty.mp4", { type: "video/mp4" }),
      targetPath: "assets/empty.mp4",
    });
    expect(emptyRes.status).toBe("failed");
    expect(emptyRes.category).toBe("unreadable");

    const hugeFile = new File(["x"], "huge.mp4", { type: "video/mp4" });
    Object.defineProperty(hugeFile, "size", { value: MAX_ASSET_BYTES + 1 });
    const hugeRes = await uploadCloudProjectFile({
      projectId: "proj-1",
      file: hugeFile,
      targetPath: "assets/huge.mp4",
    });
    expect(hugeRes.status).toBe("failed");
    expect(hugeRes.category).toBe("too_large");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uploads directly via presigned PUT + confirm + media-jobs SSE and never falls back to /api/projects/:id/upload", async () => {
    const progressUpdates: Array<{ phase: string; progress: number }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/motion-api/assets/uploads/tickets") {
        const body = JSON.parse(String(init?.body));
        expect(body.purpose).toBe("project_asset");
        expect(body.targetProjectId).toBe("proj-1");
        expect(body.targetPath).toBe("assets/big.mp4");
        return Response.json(
          {
            uploadId: "up-1",
            uploadUrl: "https://s3.local/staging/up-1?sig=abc",
            method: "PUT",
            headers: { "Content-Type": "video/mp4" },
          },
          { status: 201 },
        );
      }
      if (url === "https://s3.local/staging/up-1?sig=abc") {
        expect(init?.method).toBe("PUT");
        return new Response(null, { status: 200 });
      }
      if (url === "/motion-api/assets/uploads/up-1/confirm") {
        return Response.json({ uploadId: "up-1", jobId: "job-99", state: "queued" }, { status: 202 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = uploadCloudProjectFile({
      projectId: "proj-1",
      file: new File(["mp4bytes"], "big.mp4", { type: "video/mp4" }),
      targetPath: "assets/big.mp4",
      onProgress: (u) => progressUpdates.push({ phase: u.phase, progress: u.progress }),
    });

    await vi.waitFor(() => {
      expect(MockMediaJobEventSource.instances).toHaveLength(1);
    });
    const sse = MockMediaJobEventSource.instances[0];
    expect(sse.url).toContain("/api/media-jobs/job-99/progress");
    sse.emitProgress({ state: "running", stage: "probing", progress: 60 });
    sse.emitProgress({
      state: "completed",
      stage: "completed",
      progress: 100,
      result: { projectPath: "assets/big.mp4", sha256: "a".repeat(64) },
    });

    const result = await promise;
    expect(result).toEqual({
      status: "imported",
      path: "assets/big.mp4",
      sha256: "a".repeat(64),
      resumed: false,
    });
    expect(progressUpdates.some((u) => u.phase === "uploading" && u.progress === 100)).toBe(true);
    expect(progressUpdates.some((u) => u.phase === "processing" && u.progress === 60)).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/upload?"))).toBe(false);
  });

  it("short-circuits with 0 bytes uploaded when same-workspace CAS instant commit hits", async () => {
    const progressUpdates: Array<{ phase: string; progress: number }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/motion-api/assets/uploads/tickets") {
        const body = JSON.parse(String(init?.body));
        expect(body.allowInstantCommit).toBe(true);
        expect(body.expectedSha256).toMatch(/^[a-f0-9]{64}$/);
        return Response.json(
          {
            uploadId: "up-instant",
            instantCommitted: true,
            projectPath: "assets/dup.mp4",
            sha256: body.expectedSha256,
          },
          { status: 200 },
        );
      }
      throw new Error(`Unexpected network call during instant commit: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadCloudProjectFile({
      projectId: "proj-1",
      file: new File(["duplicate-video-bytes"], "dup.mp4", { type: "video/mp4" }),
      targetPath: "assets/dup.mp4",
      onProgress: (u) => progressUpdates.push({ phase: u.phase, progress: u.progress }),
    });

    expect(result.status).toBe("imported");
    expect(result.instant).toBe(true);
    expect(result.path).toBe("assets/dup.mp4");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(progressUpdates.some((u) => u.phase === "uploading" && u.progress === 100)).toBe(true);
  });

  it("splits large files into S3 multipart chunks and resumes skipped parts from localStorage", async () => {
    window.localStorage.clear();
    const payload = new Uint8Array(1024 * 3);
    payload.fill(0x55);
    const largeFile = new File([payload], "huge-clip.mp4", { type: "video/mp4", lastModified: 1700000000000 });
    const uploadedPartNumbers: number[] = [];

    // Seed an active interrupted multipart session where part 1 was already uploaded to S3!
    window.localStorage.setItem(
      `om:multipart:v1:proj-1:huge-clip.mp4:${largeFile.size}:1700000000000`,
      JSON.stringify({
        uploadId: "up-mp-resume",
        targetPath: "assets/huge-clip.mp4",
        partSize: 1024,
        totalParts: 3,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    );

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/motion-api/assets/uploads/up-mp-resume/parts") {
        return Response.json(
          {
            uploadId: "up-mp-resume",
            partSize: 1024,
            totalParts: 3,
            uploadedParts: [{ partNumber: 1, etag: '"etag-part-1"', size: 1024 }],
            urls: [
              { partNumber: 2, uploadUrl: "https://s3.local/mp/part-2", sizeBytes: 1024 },
              { partNumber: 3, uploadUrl: "https://s3.local/mp/part-3", sizeBytes: 1024 },
            ],
          },
          { status: 200 },
        );
      }
      if (url === "https://s3.local/mp/part-2") {
        uploadedPartNumbers.push(2);
        return new Response(null, { status: 200, headers: { ETag: '"etag-part-2"' } });
      }
      if (url === "https://s3.local/mp/part-3") {
        uploadedPartNumbers.push(3);
        return new Response(null, { status: 200, headers: { ETag: '"etag-part-3"' } });
      }
      if (url === "/motion-api/assets/uploads/up-mp-resume/complete-multipart") {
        const body = JSON.parse(String(init?.body)) as { parts: Array<{ partNumber: number; etag: string }> };
        expect(body.parts).toEqual([
          { partNumber: 1, etag: '"etag-part-1"' },
          { partNumber: 2, etag: '"etag-part-2"' },
          { partNumber: 3, etag: '"etag-part-3"' },
        ]);
        return Response.json({ uploadId: "up-mp-resume", completed: true, partsCount: 3 }, { status: 200 });
      }
      if (url === "/motion-api/assets/uploads/up-mp-resume/confirm") {
        return Response.json(
          {
            uploadId: "up-mp-resume",
            state: "committed",
            replayed: false,
            result: { projectPath: "assets/huge-clip.mp4", sha256: "c".repeat(64) },
          },
          { status: 200 },
        );
      }
      throw new Error(`Unexpected multipart fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadCloudProjectFile({
      projectId: "proj-1",
      file: largeFile,
      targetPath: "assets/huge-clip.mp4",
      multipartThresholdBytes: 2048,
    });

    expect(result.status).toBe("imported");
    expect(result.resumed).toBe(true);
    expect(uploadedPartNumbers.sort()).toEqual([2, 3]);
    expect(
      window.localStorage.getItem(`om:multipart:v1:proj-1:huge-clip.mp4:${largeFile.size}:1700000000000`),
    ).toBeNull();
  });

  it("recovers via idempotent /confirm polling if media-job SSE disconnects", async () => {
    let confirmCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/motion-api/assets/uploads/tickets") {
        return Response.json(
          { uploadId: "up-2", uploadUrl: "https://s3.local/staging/up-2", method: "PUT" },
          { status: 201 },
        );
      }
      if (url === "https://s3.local/staging/up-2") {
        return new Response(null, { status: 200 });
      }
      if (url === "/motion-api/assets/uploads/up-2/confirm") {
        confirmCalls += 1;
        if (confirmCalls === 1) {
          return Response.json({ uploadId: "up-2", jobId: "job-100", state: "processing" }, { status: 202 });
        }
        return Response.json(
          {
            uploadId: "up-2",
            state: "committed",
            replayed: true,
            result: { projectPath: "assets/recovered.mp4", sha256: "b".repeat(64) },
          },
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = uploadCloudProjectFile({
      projectId: "proj-1",
      file: new File(["mp4bytes"], "recovered.mp4", { type: "video/mp4" }),
      targetPath: "assets/recovered.mp4",
    });

    await vi.waitFor(() => {
      expect(MockMediaJobEventSource.instances).toHaveLength(1);
    });
    MockMediaJobEventSource.instances[0].onerror?.();

    const result = await promise;
    expect(result.status).toBe("imported");
    expect(result.path).toBe("assets/recovered.mp4");
    expect(confirmCalls).toBe(2);
  });
});
