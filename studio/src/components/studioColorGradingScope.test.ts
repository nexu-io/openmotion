// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { observeSourceRead } from "../utils/confirmedTextSources";
import { applyColorGradingScopeUpdate } from "./studioColorGradingScope";

it("shows grading on the mounted image before the ordered save returns", async () => {
  const project = "grade-preview";
  const path = "index.html";
  const html = '<main id="scene" data-hf-id="hf-scene"><img id="picture" data-hf-id="hf-picture"></main>';
  observeSourceRead(project, path, new Response(null, { headers: {
    "X-OpenMotion-Text-Edits": "1", "X-OpenMotion-Ordered-Edits": "1",
  }}), {content: html, version: "base"});
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frame.contentDocument!.body.innerHTML = html;
  const picture = frame.contentDocument!.getElementById("picture")!;
  let release: () => void = () => {};
  const wait = new Promise<void>(resolve => { release = resolve; });
  const post = vi.fn(async (_url: string, request: RequestInit) => {
    await wait;
    const [{id}] = JSON.parse(String(request.body)).operations;
    return Response.json({committed:[{id, changedPaths:[path], versions:{[path]:"next"}, writeToken:id, revision:"2", versionId:"next"}]});
  });
  vi.stubGlobal("fetch", post);
  const reloadPreview = vi.fn();
  const waitForPendingDomEditSaves = vi.fn(() => wait);
  try {
    const applying = applyColorGradingScopeUpdate({scope:"source-file", value:"warm", selectedSourceFile:path, compositionPaths:[path],
      projectId: project, frame, waitForPendingDomEditSaves, readProjectFile:vi.fn(), writeProjectFile:vi.fn(), recordEdit:vi.fn(),
      reloadPreview, showToast:vi.fn()});
    await vi.waitFor(() => expect(picture.getAttribute("data-color-grading")).toBe("warm"));
    expect(waitForPendingDomEditSaves).not.toHaveBeenCalled();
    release();
    await expect(applying).resolves.toEqual({changedElements:1,changedFiles:1});
    expect(post).toHaveBeenCalledTimes(1);
    expect(frame.contentDocument!.getElementById("picture")).toBe(picture);
    expect(reloadPreview).not.toHaveBeenCalled();
  } finally {
    release();
    vi.unstubAllGlobals();
    frame.remove();
  }
});
