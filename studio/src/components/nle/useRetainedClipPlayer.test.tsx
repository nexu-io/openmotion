// @vitest-environment happy-dom
import { act, forwardRef, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { PlayerProps } from "../../player/components/Player";
import { trackStudioProjectSave } from "../../utils/studioSaveState";
import { markStudioWriteToken } from "../../utils/studioFileVersion";
import { notifyExternalFileReload } from "../../hooks/externalFileReloadBus";
import { useRetainedClipPlayers } from "./useRetainedClipPlayer";

const { patch } = vi.hoisted(() => ({ patch: vi.fn(async () => true) }));
vi.mock("../../player/peerTimingPreview", () => ({ tryApplyPeerChanges: patch, mountedPeerFileVersion: () => undefined }));
vi.mock("../../player/lib/previewLease", async importOriginal => ({
  ...await importOriginal<object>(), isolatedPreviewOrigin: () => "https://preview.test",
}));

const Frame = forwardRef<HTMLIFrameElement, PlayerProps>(({ parked, style, inert }, ref) =>
  <iframe style={style} inert={inert} data-clip-painted="true" data-parked={!!parked} ref={ref}/>);
function Stage({ path, generation, project = "p" }: { path: string; generation: number; project?: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const url = path === "index.html" ? undefined : `/api/projects/${project}/preview/comp/${path}`;
  const player = <Frame key={path + generation} directUrl={url} ref={ref} onLoad={() => {}}/>;
  return useRetainedClipPlayers(project, url, ref, [player], player);
}

it("keeps the previous document through a peer patch, retires it on catch-up, and bounds retained frames", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const visit = (path: string, generation = 0) => {
    act(() => root.render(<Stage path={path} generation={generation}/>));
    expect(host.querySelectorAll("iframe").length).toBeLessThanOrEqual(3);
    return host.querySelector('iframe[data-parked=false]')!;
  };
  try {
    const a = visit("a.html");
    let saved!: () => void;
    const unrelated = trackStudioProjectSave("p", "c.html", () => new Promise<void>(resolve => { saved = resolve; }));
    const b = visit("b.html");
    saved();
    await unrelated;
    await act(async () => notifyExternalFileReload("a.html", undefined, {
      projectId: "p", paths: ["a.html"], treeChanged: false, previous: { version: "v1", content: "old" }, current: { version: "v2", content: "new" },
    }));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(visit("a.html", 3)).toBe(a);
    expect(visit("b.html")).toBe(b);
    act(() => notifyExternalFileReload(".", undefined, { projectId: "p", paths: null, treeChanged: false }));
    expect(visit("a.html")).not.toBe(a);
    visit("c.html");
    expect(visit("b.html")).toBe(b);
  } finally { act(() => root.unmount()); host.remove(); }
});

it("evicts the least recently used preview, including the master, and releases all previews on a project switch", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const visit = (path: string, project = "p") => {
    act(() => root.render(<Stage path={path} generation={0} project={project}/>));
    expect(host.querySelectorAll("iframe").length).toBeLessThanOrEqual(4);
    return host.querySelector<HTMLIFrameElement>("iframe[data-parked=false]")!;
  };
  try {
    const master = visit("index.html");
    const intro = visit("intro.html");
    const choice = visit("choice.html");
    const editor = visit("editor.html");
    expect(visit("intro.html")).toBe(intro);
    visit("outro.html");
    expect(master.isConnected).toBe(false);
    expect(choice.isConnected).toBe(true);
    expect(editor.isConnected).toBe(true);
    expect(visit("choice.html")).toBe(choice);
    expect(visit("index.html")).not.toBe(master);
    expect(editor.isConnected).toBe(false);
    visit("intro.html", "another-project");
    expect(host.querySelectorAll("iframe")).toHaveLength(1);
    expect(master.isConnected).toBe(false);
  } finally { act(() => root.unmount()); host.remove(); }
});

it("does not resume a master from before a local write to a nested clip", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const visit = (path: string) => {
    act(() => root.render(<Stage path={path} generation={0}/>));
    return host.querySelector("iframe[data-parked=false]");
  };
  try {
    const master = visit("index.html");
    visit("intro.html");
    markStudioWriteToken("nested-clip-commit");
    expect(visit("index.html")).not.toBe(master);
  } finally { act(() => root.unmount()); host.remove(); }
});

it("finishes ordered background patches before reactivating the same frame, including a full upload", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const visit = (path: string) => act(() => root.render(<Stage path={path} generation={0}/>));
  let ack!: (applied: boolean) => void;
  const pending = new Promise<boolean>(resolve => { ack = resolve; });
  patch.mockClear();
  patch.mockReturnValueOnce(pending);
  const source = (version: string) => ({ version, content: version });
  try {
    visit("a.html");
    const original = host.querySelector("iframe");
    visit("b.html");
    await act(async () => {
      const change = { projectId: "p", paths: ["a.html"], treeChanged: false };
      notifyExternalFileReload("a.html", undefined, { ...change, previous: source("v1"), current: source("v2") });
      notifyExternalFileReload("a.html", () => Promise.resolve({ ...source("v3"), missing: false }),
        { ...change, previous: source("v2") });
    });
    expect(patch).toHaveBeenCalledTimes(1);
    visit("a.html");
    expect(original?.dataset.parked).toBe("true");
    expect(original?.style.display).not.toBe("none");
    expect(original?.hasAttribute("inert")).toBe(true);
    await act(async () => { ack(true); });
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenLastCalledWith(original, {
      path: "a.html", previous: source("v2"), current: source("v3"),
    }, expect.any(Function));
    expect(host.querySelector("iframe[data-parked=false]")).toBe(original);
  } finally { act(() => root.unmount()); host.remove(); }
});
