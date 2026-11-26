// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { knownCompositionSource, MAX_POSTER_SOURCE_LENGTH, rememberCompositionPosterSource, shareCompositionPosterRead } from "./compositionPosterSource";
import { syncPeerComposition } from "../../hooks/syncPeerComposition";
import { openTimelineSource } from "./peerTimeline";
import { loadCloudCompositionPoster } from "./cloudCompositionPoster";
import { expectPosterFileVersion, readPosterFile } from "./posterFileRead";
import { decodeImageThumbnail } from "./thumbnailImageDecoder";
import { confirmedSource, forgetSource, rememberSource } from "../../utils/confirmedTextSources";
import { invalidateLatestSourceWrite, markStudioWriteToken } from "../../utils/studioFileVersion";
import { usePlayerStore } from "../store/playerStore";

vi.mock("./thumbnailImageDecoder", () => ({ decodeImageThumbnail: vi.fn() }));
const picture = { value: { kind: "image" as const, url: "blob:representative", aspect: 1 }, weight: 32 };
const url = (query = "") => new URL("/api/projects/p/thumbnail/compositions/scene.html" + query, location.origin);
const signal = () => new AbortController().signal;
const original = usePlayerStore.getState();
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); usePlayerStore.setState(original); });

describe("cloud composition representatives", () => {
  it("reuses only the confirmed bytes for this generation, independent of echo/receipt order", async () => {
    const project = "poster-echo", path = "compositions/scene.html", epoch = 4;
    const store = usePlayerStore.getState();
    usePlayerStore.setState({ timelineProjectId: project, timelineSessionEpoch: epoch, thumbnailRevisions: {} });
    const fetch = vi.fn(async () => Response.json({ content: "from server" }));
    vi.stubGlobal("fetch", fetch);
    const read = (revision: number, pid = project, file = path) => readPosterFile(pid, epoch, file, revision, signal());
    try {
      rememberSource(project, path, { content: "one", version: "v1" });
      markStudioWriteToken("local-1");
      expectPosterFileVersion(project, path, { token: "local-1", version: "v1" });
      expect(await read(0)).toBe("one");
      store.bumpThumbnailRevisions([path], path);
      markStudioWriteToken("local-2");
      expectPosterFileVersion(project, path, { token: "local-2", version: "v2" });
      rememberSource(project, path, { content: "two", version: "v2" });
      expect(await read(1)).toBe("two");
      expect(fetch).not.toHaveBeenCalled();

      // A failed or superseded local write has no matching confirmed source.
      store.bumpThumbnailRevisions([path], path);
      markStudioWriteToken("local-3");
      expectPosterFileVersion(project, path, { token: "local-3", version: "v3" });
      expect(await read(2)).toBe("from server");
      expect(await read(2, "other-project")).toBe("from server");
      expect(await read(0, project, "other.html")).toBe("from server");
      // A reconnect discards the echo proof, even when the bytes are still cached.
      store.bumpThumbnailRevisions(null, ".");
      expect(await read(3)).toBe("from server");
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      forgetSource(project, path);
    }
  });

  it("revalidates a late self echo after another editor writes or the project is reopened", async () => {
    const project = "poster-order", path = "intro.html", token = "local-late";
    const store = usePlayerStore.getState();
    store.beginTimelineSession(project);
    const read = () => {
      const s = usePlayerStore.getState();
      return readPosterFile(project, s.timelineSessionEpoch, path, s.thumbnailRevisions[path] ?? 0, signal());
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ content: "newer on server" })));
    try {
      markStudioWriteToken(token);
      rememberSource(project, path, { content: "old local", version: "v2" });
      invalidateLatestSourceWrite();
      store.bumpThumbnailRevisions([path], path);
      expect(await read()).toBe("newer on server");
      store.bumpThumbnailRevisions([path], path);
      expectPosterFileVersion(project, path, { token, version: "v2" });
      expect(await read()).toBe("newer on server");

      markStudioWriteToken("prior-session");
      store.beginTimelineSession("other");
      store.beginTimelineSession(project);
      expectPosterFileVersion(project, path, { token: "prior-session", version: "v2" });
      expect(await read()).toBe("newer on server");
    } finally {
      forgetSource(project, path);
    }
  });

  it("uses the exact current-project manifest without reading HTML", async () => {
    usePlayerStore.setState({ previewBooted: true, timelineProjectId: "p", timelineSessionEpoch: 4,
      elements: [{ id: "photo", tag: "img", src: "../assets/hero.png", sourceFile: "compositions/scene.html", start: 0, duration: 4, track: 0 }] });
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(decodeImageThumbnail).mockResolvedValue(picture);
    expect(await loadCloudCompositionPoster(url(), "p", 4, signal())).toEqual(picture);
    expect(decodeImageThumbnail).toHaveBeenCalledWith(new URL("/api/projects/p/preview/assets/hero.png", location.origin).href, expect.anything());
    expect(fetch).not.toHaveBeenCalled();
  });
  it("seeds a versioned source from the initial poster without replacing a newer edit or a different session", async () => {
    const path = "compositions/scene.html";
    const content = '<img src="assets/first.png">';
    const headers = { "X-OpenMotion-Text-Edits": "1" };
    const state = { timelineProjectId: "p", timelineSessionEpoch: 4, thumbnailRevisions: {} };
    usePlayerStore.setState(state);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ content, version: "v1" }, { headers })));
    vi.mocked(decodeImageThumbnail).mockResolvedValue(picture);
    try {
      await loadCloudCompositionPoster(url(), "p", 3, signal());
      expect(confirmedSource("p", path)).toBeUndefined();
      await loadCloudCompositionPoster(url(), "p", 4, signal());
      expect(confirmedSource("p", path)).toEqual({ content, version: "v1" });
      rememberSource("p", path, { content: "later", version: "v2" });
      await loadCloudCompositionPoster(url(), "p", 4, signal());
      expect(confirmedSource("p", path)?.version).toBe("v2");
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      forgetSource("p", path);
    }
  });
  it("shares one authored read across concurrent and later clip posters while retaining each label", async () => {
    const file = "compositions/scene.html";
    usePlayerStore.setState({ timelineProjectId: "p", timelineSessionEpoch: 4, thumbnailRevisions: {} });
    const content = ["Intro", "Middle", "End"].map(word => `<div class="clip"><h1>${word}</h1></div>`).join("");
    const fetch = vi.fn(async () => Response.json({ content }));
    vi.stubGlobal("fetch", fetch);
    const poster = (index: number, revision = 0) => loadCloudCompositionPoster(
      url(`?selector=.clip&selectorIndex=${index}&revision=${revision}`), "p", 4, signal());
    const [intro, middle] = await Promise.all([poster(0), poster(1)]);
    const end = await poster(2);
    expect([intro.value, middle.value, end.value]).toMatchObject([{ label: "Intro" }, { label: "Middle" }, { label: "End" }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    usePlayerStore.getState().bumpThumbnailRevisions([file], file);
    fetch.mockImplementationOnce(async () => Response.json({ content: content.replace("Intro", "Revised") }));
    expect((await poster(0, 1)).value).toMatchObject({ label: "Revised" });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const result of [intro, middle, end]) result.dispose?.();
  });

  it("cancels only the departing poster and retries if the last reader cancels or a fetch fails", async () => {
    usePlayerStore.setState({ timelineProjectId: "p", timelineSessionEpoch: 4, thumbnailRevisions: {} });
    const requests: { signal: AbortSignal; respond: (response: Response) => void }[] = [];
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise<Response>((resolve, reject) => {
      requests.push({ signal: init.signal, respond: resolve });
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    })));
    const first = new AbortController(), second = new AbortController();
    const poster = (signal: AbortSignal) => loadCloudCompositionPoster(url(), "p", 4, signal);
    const a = poster(first.signal), b = poster(second.signal);
    expect(requests).toHaveLength(1);
    first.abort();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(requests[0].signal.aborted).toBe(false);
    second.abort();
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
    expect(requests[0].signal.aborted).toBe(true);
    const failed = poster(signal());
    requests[1].respond(new Response("", { status: 503 }));
    await expect(failed).rejects.toThrow("503");
    const recovered = poster(signal());
    requests[2].respond(Response.json({ content: "<h1>Back</h1>" }));
    expect((await recovered).value).toMatchObject({ label: "Back" });
  });

  it("reuses the editor source only for the same file, thumbnail revision and session", async () => {
    const file = "compositions/scene.html";
    usePlayerStore.setState({ timelineProjectId: "p", timelineSessionEpoch: 4, thumbnailRevisions: { [file]: 1 } });
    const before = usePlayerStore.getState();
    const fetch = vi.fn(async () => Response.json({ content: '<img src="assets/new.png">' }));
    vi.stubGlobal("fetch", fetch);
    vi.mocked(decodeImageThumbnail).mockResolvedValue(picture);
    rememberCompositionPosterSource(before, "p", file, '<img src="assets/old.png">');
    await loadCloudCompositionPoster(url("?revision=1"), "p", 4, signal());
    expect(fetch).not.toHaveBeenCalled();
    expect(decodeImageThumbnail).toHaveBeenLastCalledWith(expect.stringContaining("assets/old.png"), expect.anything());

    await loadCloudCompositionPoster(url("?revision=1"), "p", 5, signal());
    expect(fetch).toHaveBeenCalledTimes(1);
    before.bumpThumbnailRevisions([file], file);
    // A stale SDK read can finish after the next edit.
    rememberCompositionPosterSource(before, "p", file, '<img src="assets/late.png">');
    await loadCloudCompositionPoster(url("?revision=2"), "p", 4, signal());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(decodeImageThumbnail).toHaveBeenLastCalledWith(expect.stringContaining("assets/new.png"), expect.anything());
  });
  it("shares the active peer read with its poster, without blocking other files or painting a late revision", async () => {
    const path = "compositions/scene.html";
    usePlayerStore.setState({ timelineProjectId: "p", timelineSessionEpoch: 4, thumbnailRevisions: {} });
    const close = openTimelineSource("p", path);
    const fetch = vi.fn(async () => Response.json({ content: '<img src="assets/other.png">' }));
    vi.stubGlobal("fetch", fetch);
    vi.mocked(decodeImageThumbnail).mockResolvedValue(picture);
    function startEdit(revision: number) {
      let finish!: (file: { content: string; version: string; missing: boolean }) => void;
      const pending = new Promise<Parameters<typeof finish>[0]>(resolve => { finish = resolve; });
      const read = vi.fn(() => pending);
      usePlayerStore.getState().bumpThumbnailRevisions([path], path);
      syncPeerComposition("p", path, [path], read, { current: null }, null);
      const poster = loadCloudCompositionPoster(url("?revision=" + revision), "p", 4, signal());
      expect(read).toHaveBeenCalledExactlyOnceWith("p", path);
      return { finish, poster };
    }
    try {
      const first = startEdit(1);
      const second = startEdit(2);
      expect(fetch).not.toHaveBeenCalled();
      const other = new URL("/api/projects/p/thumbnail/other.html", location.origin);
      await loadCloudCompositionPoster(other, "p", 4, signal());
      expect(fetch).toHaveBeenCalledTimes(1);
      second.finish({ content: '<img src="assets/current.png">', version: "v2", missing: false });
      expect(await second.poster).toEqual(picture);
      first.finish({ content: '<img src="assets/stale.png">', version: "v1", missing: false });
      await expect(first.poster).rejects.toMatchObject({ name: "AbortError" });
      await loadCloudCompositionPoster(url("?revision=2"), "p", 4, signal());
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(decodeImageThumbnail).toHaveBeenLastCalledWith(expect.stringContaining("assets/current.png"), expect.anything());
      expect(decodeImageThumbnail).not.toHaveBeenCalledWith(expect.stringContaining("assets/stale.png"), expect.anything());
    } finally { close(); }
  });
  it("recovers a failed shared read and avoids fetching oversized HTML again", async () => {
    const path = "compositions/scene.html";
    usePlayerStore.setState({ timelineProjectId: "p", timelineSessionEpoch: 4, thumbnailRevisions: { [path]: 1 } });
    const state = usePlayerStore.getState();
    const fetch = vi.fn(async () => Response.json({ content: '<img src="assets/retry.png">' }));
    vi.stubGlobal("fetch", fetch);
    vi.mocked(decodeImageThumbnail).mockResolvedValue(picture);
    shareCompositionPosterRead(state, "p", path, Promise.reject(new Error("offline")));
    await expect(loadCloudCompositionPoster(url("?revision=1"), "p", 4, signal())).resolves.toEqual(picture);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:text-cover");
    shareCompositionPosterRead(state, "p", path, Promise.resolve({ content: "x".repeat(MAX_POSTER_SOURCE_LENGTH + 1), version: "big" }));
    const fallback = await loadCloudCompositionPoster(url("?revision=1"), "p", 4, signal());
    expect(fallback.value).toMatchObject({ representative: "text" });
    expect(knownCompositionSource(state, "p", path)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("respects the selected occurrence in an inert template without external fetches", async () => {
    const html = '<template><div class="tile"><img src="https://example.invalid/logo.png"></div><div class="tile"><video poster="assets/2.jpg"></video></div></template>';
    const fetch = vi.fn(async () => Response.json({ content: html }));
    vi.stubGlobal("fetch", fetch);
    vi.mocked(decodeImageThumbnail).mockResolvedValue(picture);
    await loadCloudCompositionPoster(url("?selector=.tile&selectorIndex=1"), "p", 0, signal());
    expect(decodeImageThumbnail).toHaveBeenCalledWith(new URL("/api/projects/p/preview/assets/2.jpg", location.origin).href, expect.anything());
    expect(fetch.mock.calls).toHaveLength(1);
  });
  it("uses only this file's real title for text, external assets or traversal; releases the object URL", async () => {
    usePlayerStore.setState({ previewBooted: true, timelineProjectId: "other", timelineSessionEpoch: 1,
      elements: [{ id: "wrong", tag: "img", src: "assets/private.png", sourceFile: "compositions/scene.html", start: 0, duration: 9, track: 0 }] });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ content: '<template><script>steal()</script><h1>Real &amp; Safe</h1><img src="../../../../other/preview/asset.jpg"></template>' })));
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:scene");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const result = await loadCloudCompositionPoster(url(), "p", 1, signal());
    expect(decodeImageThumbnail).not.toHaveBeenCalled();
    const svg = await (create.mock.calls[0]![0] as Blob).text();
    expect(svg).toContain("Real &amp; Safe");
    expect(svg).not.toMatch(/script|steal|private.png/);
    result.dispose?.();
    expect(revoke).toHaveBeenCalledWith("blob:scene");
  });
  it("propagates a transient media failure so the scheduler can retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ content: '<img src="assets/poster.jpg">' })));
    vi.mocked(decodeImageThumbnail).mockRejectedValue(new Error("network"));
    await expect(loadCloudCompositionPoster(url(), "p", 0, signal())).rejects.toThrow("network");
    vi.mocked(decodeImageThumbnail).mockResolvedValue(picture);
    await expect(loadCloudCompositionPoster(url(), "p", 0, signal())).resolves.toEqual(picture);
  });
  it("rejects a mismatched project before requesting its file", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(loadCloudCompositionPoster(url(), "other", 0, signal())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("skips decorative avatars, brand marks and tiny insets, falling back to a semantic text poster", async () => {
    const html = [
      '<template><style>#lockup img{width:42px;height:42px}.portrait{width:200px;height:200px}</style>',
      '<div data-composition-id="film" data-width="1280" data-height="720">',
      '<div id="lockup"><img src="assets/brand-mark.svg" alt=""></div>',
      '<img class="avatar" src="assets/photos/avatar-13.jpg" style="width:46px;height:46px">',
      '<div class="portrait"><img src="assets/photos/person-one.jpg"></div>',
      '<span data-var-text="brand">OpenMotion</span>',
      '<span data-var-text="product">Glean Agents</span>',
      "</div></template>",
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ content: html })));
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:text-cover");
    const result = await loadCloudCompositionPoster(url(), "p", 0, signal());
    expect(decodeImageThumbnail).not.toHaveBeenCalled();
    expect(result.value).toMatchObject({
      kind: "image",
      url: "blob:text-cover",
      representative: "text",
      label: "Glean Agents",
    });
    expect(await (create.mock.calls[0]![0] as Blob).text()).toContain("Glean Agents");
  });
  it("skips a leading logo icon to pick a real hero image later in the composition", async () => {
    const html = [
      '<template><div data-composition-id="hero" data-width="1920" data-height="1080">',
      '<img class="logo" src="assets/brand-mark.svg" style="width:42px;height:42px">',
      '<img src="assets/hero-stage.jpg" style="width:1920px;height:1080px">',
      "</div></template>",
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ content: html })));
    vi.mocked(decodeImageThumbnail).mockResolvedValue(picture);
    expect(await loadCloudCompositionPoster(url(), "p", 0, signal())).toEqual(picture);
    expect(decodeImageThumbnail).toHaveBeenCalledWith(
      new URL("/api/projects/p/preview/assets/hero-stage.jpg", location.origin).href,
      expect.anything(),
    );
  });
  it("joins sibling data-var-text phrases, uses canvas aria-label, and strips .html from fallback names", async () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:text-cover");
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({
        content: '<template><div id="contrast"><span data-var-text="a">Not just</span><span data-var-text="b">a video.</span></div></template>',
      }),
    ));
    const phrase = await loadCloudCompositionPoster(url(), "p", 0, signal());
    expect(phrase.value).toMatchObject({ representative: "text", label: "Not just a video." });

    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({
        content: '<template><canvas aria-label="Editable motion artwork montage"></canvas></template>',
      }),
    ));
    const canvas = await loadCloudCompositionPoster(
      new URL("/api/projects/p/thumbnail/compositions/reel.html", location.origin),
      "p",
      0,
      signal(),
    );
    expect(canvas.value).toMatchObject({
      representative: "text",
      label: "Editable motion artwork montage",
    });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ content: "<template><canvas></canvas></template>" })));
    const stem = await loadCloudCompositionPoster(
      new URL("/api/projects/p/thumbnail/compositions/reel.html", location.origin),
      "p",
      0,
      signal(),
    );
    expect(stem.value).toMatchObject({ representative: "text", label: "reel" });
    expect(create).toHaveBeenCalledTimes(3);
  });
  it("skips decorative avatar entries in the live manifest when loading a whole composition poster", async () => {
    usePlayerStore.setState({
      previewBooted: true,
      timelineProjectId: "p",
      timelineSessionEpoch: 4,
      elements: [
        { id: "av", tag: "img", src: "assets/photos/avatar-13.jpg", sourceFile: "compositions/scene.html", start: 0, duration: 4, track: 0 },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ content: "<template><h1>Launch Film</h1></template>" })));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:text-cover");
    const result = await loadCloudCompositionPoster(url(), "p", 4, signal());
    expect(decodeImageThumbnail).not.toHaveBeenCalled();
    expect(result.value).toMatchObject({ representative: "text", label: "Launch Film" });
  });
  it("extracts project-local CSS background-image URLs from inline styles and <style> blocks while skipping decorative icons and gradients", async () => {
    vi.mocked(decodeImageThumbnail).mockResolvedValue(picture);
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({
        content: [
          '<template><div data-composition-id="bg-inline" data-width="1920" data-height="1080">',
          '<div class="avatar" style="background-image: url(\'assets/avatar-1.png\'); width: 48px; height: 48px"></div>',
          '<div class="hero" style="background: linear-gradient(transparent,#000), url(\'assets/hero-bg.webp\') center/cover"></div>',
          "</div></template>",
        ].join(""),
      }),
    ));
    expect(await loadCloudCompositionPoster(url(), "p", 0, signal())).toEqual(picture);
    expect(decodeImageThumbnail).toHaveBeenLastCalledWith(
      new URL("/api/projects/p/preview/assets/hero-bg.webp", location.origin).href,
      expect.anything(),
    );

    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({
        content: [
          '<template><style>',
          '.logo-badge{width:40px;height:40px;background-image:url("assets/logo.svg")}',
          '.backdrop{width:1920px;height:1080px;background-image:url("assets/sky-backdrop.jpg");mask-image:url("assets/mask.png")}',
          '</style><div data-composition-id="bg-style" data-width="1920" data-height="1080"><div class="backdrop"></div></div></template>',
        ].join(""),
      }),
    ));
    expect(await loadCloudCompositionPoster(url(), "p", 0, signal())).toEqual(picture);
    expect(decodeImageThumbnail).toHaveBeenLastCalledWith(
      new URL("/api/projects/p/preview/assets/sky-backdrop.jpg", location.origin).href,
      expect.anything(),
    );
  });
});
