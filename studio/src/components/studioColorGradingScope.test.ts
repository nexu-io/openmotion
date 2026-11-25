// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { OrderedTextEditOperation } from "../../../shared/ordered-text-edits";
import { applyTextPatch } from "../../../shared/text-patch";
import { setCachedCloudDisklessMode } from "../utils/cloudRuntime";
import { applyColorGradingScopeUpdate } from "./studioColorGradingScope";

it("paints consecutive scope edits from a cold hosted source without waiting for earlier receipts", async () => {
  const project = "grade-preview";
  const path = "index.html";
  const html = '<main id="scene" data-hf-id="hf-scene"><img id="picture" data-hf-id="hf-picture"></main>';
  setCachedCloudDisklessMode(true);
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frame.contentDocument!.body.innerHTML = html;
  const picture = frame.contentDocument!.getElementById("picture")!;
  const hold = Promise.withResolvers<void>();
  const batches: OrderedTextEditOperation[][] = [];
  let savedSource = html;
  const fetch = vi.fn(async (url: string, request?: RequestInit) => {
    if (request?.method !== "POST") {
      expect(url).toBe("/api/projects/" + project + "/files/" + path);
      return Response.json({ content:html, version:"base" }, { headers: {
        "X-OpenMotion-Text-Edits":"1", "X-OpenMotion-Ordered-Edits":"1",
      } });
    }
    expect(url).toBe("/api/projects/" + project + "/text-edits/batch");
    const operations: OrderedTextEditOperation[] = JSON.parse(String(request.body)).operations;
    batches.push(operations);
    if (batches.length === 1) await hold.promise;
    return Response.json({ committed:operations.map(op => {
      const file = op.files[0]!;
      savedSource = 'content' in file ? file.content : applyTextPatch(savedSource, file.patch);
      return { id:op.id, changedPaths:[path], versions:{[path]:op.id} };
    }) });
  });
  vi.stubGlobal("fetch", fetch);
  const reloadPreview = vi.fn();
  const waitForPendingDomEditSaves = vi.fn(() => hold.promise);
  const apply = (value: string) => applyColorGradingScopeUpdate({scope:"source-file", value, selectedSourceFile:path, compositionPaths:[path],
    projectId: project, frame, waitForPendingDomEditSaves, readProjectFile:vi.fn(), writeProjectFile:vi.fn(), recordEdit:vi.fn(),
    reloadPreview, showToast:vi.fn()});
  try {
    const first = apply("warm");
    await vi.waitFor(() => expect(picture.getAttribute("data-color-grading")).toBe("warm"));
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    const second = apply("cool"), third = apply("sepia");
    await vi.waitFor(() => expect(picture.getAttribute("data-color-grading")).toBe("sepia"));
    expect(waitForPendingDomEditSaves).not.toHaveBeenCalled();
    expect(batches).toHaveLength(1);
    hold.resolve();
    const results = await Promise.all([first,second,third]);
    expect(results).toEqual(Array(3).fill({ changedElements:1, changedFiles:1 }));
    expect(batches.map(batch => batch.length)).toEqual([1,2]);
    expect(batches[1]![0]!.files[0]!.baseVersion).toBe(batches[0]![0]!.id);
    expect(batches[1]![1]!.files[0]!.baseVersion).toEqual({ after:batches[1]![0]!.id });
    expect(savedSource).toContain('data-color-grading="sepia"');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(frame.contentDocument!.getElementById("picture")).toBe(picture);
    expect(reloadPreview).not.toHaveBeenCalled();
  } finally {
    hold.resolve();
    setCachedCloudDisklessMode(null);
    vi.unstubAllGlobals();
    frame.remove();
  }
});
