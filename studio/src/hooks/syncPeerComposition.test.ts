// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { openTimelineSource } from "../player/lib/peerTimeline";
import { knownCompositionSource, rememberCompositionPosterSource } from "../player/lib/compositionPosterSource";
import { usePlayerStore } from "../player/store/playerStore";
import { rememberPeerTimingDocument } from "../player/peerTimingPreview";
import { rememberSource, forgetSource } from "../utils/confirmedTextSources";
import { rememberPreviewHtmlSources } from "../player/lib/previewHtmlSources";
import { syncPeerComposition } from "./syncPeerComposition";

afterEach(() => vi.unstubAllGlobals());

it("lets a preview without live timing support start its rebuild while the source read is pending", () => {
  const state = usePlayerStore.getState();
  state.beginTimelineSession("p");
  const close = openTimelineSource("p", "index.html");
  try {
    const frame = document.createElement("iframe");
    Object.defineProperty(frame, "contentDocument", { value: null });
    rememberCompositionPosterSource(usePlayerStore.getState(), "p", "index.html", "<main></main>", "v1");
    const pending = vi.fn(() => new Promise<never>(() => {}));
    const previous = knownCompositionSource(usePlayerStore.getState(), "p", "index.html");
    expect(syncPeerComposition("p", "index.html", ["index.html"], pending, { current: frame }, previous)).toBeUndefined();
    expect(pending).toHaveBeenCalledExactlyOnceWith("p", "index.html");
  } finally {
    close();
    state.reset();
  }
});

it("starts the scripted rebuild immediately and reads a changed child only if its previous source is already available", () => {
  const state = usePlayerStore.getState();
  state.beginTimelineSession("p");
  const path = "compositions/intro.html";
  const frame = document.createElement("iframe");
  rememberPeerTimingDocument(frame, "token", undefined, "document");
  const pending = vi.fn(() => new Promise<never>(() => {}));
  const sync = (paths: string[]) => syncPeerComposition("p", "index.html", paths, pending, { current: frame }, null);
  try {
    expect(sync([path])).toBeUndefined();
    expect(pending).not.toHaveBeenCalled();
    rememberSource("p", path, { content: "<p>Hi</p>", version: "first" });
    expect(sync([path, "other.html"])).toBeUndefined();
    expect(pending).not.toHaveBeenCalled();
    expect(sync([path])).toBeUndefined();
    expect(pending).toHaveBeenCalledExactlyOnceWith("p", path);
  } finally {
    forgetSource("p", path);
    state.reset();
  }
});

it("recovers the exact mounted child revision only after a cold peer observes an edit", async () => {
  const state = usePlayerStore.getState();
  state.beginTimelineSession("p");
  const frame = document.createElement("iframe");
  const path = "child.html", hash = "a".repeat(64), version = `"patch:${hash}"`;
  rememberPeerTimingDocument(frame, "token", undefined, "document", { position: true }, false, { [path]: version });
  // A revision that has already been removed from history takes the regular document refresh.
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("gone", { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  const read = vi.fn(async () => ({ content: "<p>Changed</p>", version: "next" }));
  const sync = (changed: string) => syncPeerComposition("p", "index.html", [changed], read, { current: frame }, null);
  try {
    expect(sync("unmounted.html")).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await sync(path)).toBe(false);
    expect(read).toHaveBeenCalledExactlyOnceWith("p", path);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/projects/p/history/blob/" + hash);
  } finally {
    state.reset();
  }
});

it("accepts multiple source versions together, reading only the warm affected scene and recovering each failed path once", async () => {
  const state = usePlayerStore.getState();
  state.beginTimelineSession("multi");
  const frame = document.body.appendChild(document.createElement("iframe"));
  Object.defineProperty(frame, "contentDocument", { value: null });
  rememberPeerTimingDocument(frame, "token", "document");
  rememberPreviewHtmlSources(frame, "multi", ["index.html", "open.html", "cold.html"]);
  rememberSource("multi", "open.html", { content: "<p>Hi</p>", version: "v1" });
  const release = Promise.withResolvers<{ content: string; version: string }>();
  const read = vi.fn(() => release.promise);
  const refresh = vi.fn();
  try {
    const versions = { "open.html": "v2", "cold.html": "v3", "unused.html": "v4" };
    expect(await syncPeerComposition("multi", "index.html", Object.keys(versions), read, { current: frame }, null,
      undefined, { versions, treeChanged: false, refresh })).toBe(true);
    await vi.waitFor(() => expect(read).toHaveBeenCalledExactlyOnceWith("multi", "open.html"));
    expect(refresh).not.toHaveBeenCalled();
    release.resolve({ content: "<p>Edited</p>", version: "v2" });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledExactlyOnceWith(["open.html", "cold.html"]));
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    frame.remove();
    forgetSource("multi", "open.html");
    state.reset();
  }
});
