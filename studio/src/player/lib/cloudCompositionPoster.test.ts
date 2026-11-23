// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { rememberCompositionPosterSource } from "./compositionPosterSource";
import { loadCloudCompositionPoster } from "./cloudCompositionPoster";
import { decodeImageThumbnail } from "./thumbnailImageDecoder";
import { usePlayerStore } from "../store/playerStore";

vi.mock("./thumbnailImageDecoder", () => ({ decodeImageThumbnail: vi.fn() }));
const picture = { value: { kind: "image" as const, url: "blob:representative", aspect: 1 }, weight: 32 };
const url = (query = "") => new URL("/api/projects/p/thumbnail/compositions/scene.html" + query, location.origin);
const signal = () => new AbortController().signal;
const original = usePlayerStore.getState();
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); usePlayerStore.setState(original); });

describe("cloud composition representatives", () => {
  it("uses the exact current-project manifest without reading HTML", async () => {
    usePlayerStore.setState({ previewBooted: true, timelineProjectId: "p", timelineSessionEpoch: 4,
      elements: [{ id: "photo", tag: "img", src: "../assets/hero.png", sourceFile: "compositions/scene.html", start: 0, duration: 4, track: 0 }] });
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(decodeImageThumbnail).mockResolvedValue(picture);
    expect(await loadCloudCompositionPoster(url(), "p", 4, signal())).toEqual(picture);
    expect(decodeImageThumbnail).toHaveBeenCalledWith(new URL("/api/projects/p/preview/assets/hero.png", location.origin).href, expect.anything());
    expect(fetch).not.toHaveBeenCalled();
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
});
