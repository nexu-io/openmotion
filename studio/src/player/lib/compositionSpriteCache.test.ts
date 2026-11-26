// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCompositionCacheKeyRevision,
  resetCompositionRevisionsForTest,
  setCachedProjectRevision,
  updateCachedCompositionRevisions,
} from "./compositionRevisionKey";
import {
  MEMORY_STRIP_CACHE_MAX_BYTES,
  peekCachedCompositionCapture,
  resetCompositionSpriteCacheForTest,
  retainCachedCompositionCapture,
  seedClientCompositionSpriteForTest,
  setMemoryStripCacheMaxBytesForTest,
} from "./compositionSpriteCache";
import { sliceVideoFallbackUrls } from "./videoThumbnailRequest";

afterEach(() => {
  resetCompositionSpriteCacheForTest();
  resetCompositionRevisionsForTest();
  vi.restoreAllMocks();
});

describe("compositionRevisionKey & compositionSpriteCache modular boundaries", () => {
  it("enforces L0 RAM decoded pixel byte budget (32 MiB default) via LRU while keeping retained URLs alive", () => {
    expect(MEMORY_STRIP_CACHE_MAX_BYTES).toBe(32 * 1024 * 1024);

    let seq = 0;
    const revoked: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:mem-${++seq}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revoked.push(String(url));
    });

    // Each 8-frame 160x90 sprite weighs 8 * 160 * 90 * 4 = 460,800 bytes.
    // Set a 1,000,000-byte budget so at most 2 sprites fit in L0 RAM concurrently.
    setMemoryStripCacheMaxBytesForTest(1_000_000);
    setCachedProjectRevision("proj-mem", "rev-1", {
      "compositions/s1.html": '"sha256:s1"|shared:h1:a1',
      "compositions/s2.html": '"sha256:s2"|shared:h1:a1',
      "compositions/s3.html": '"sha256:s3"|shared:h1:a1',
    });

    const url1 = "/api/projects/proj-mem/preview/comp/compositions/s1.html";
    const url2 = "/api/projects/proj-mem/preview/comp/compositions/s2.html";
    const url3 = "/api/projects/proj-mem/preview/comp/compositions/s3.html";

    const v1 = seedClientCompositionSpriteForTest(
      { projectId: "proj-mem", previewUrl: url1, contentRevision: 0, frameCount: 8 },
      new Blob(["s1"], { type: "image/jpeg" }),
    );
    const releaseV1 = retainCachedCompositionCapture(v1);

    const v2 = seedClientCompositionSpriteForTest(
      { projectId: "proj-mem", previewUrl: url2, contentRevision: 0, frameCount: 8 },
      new Blob(["s2"], { type: "image/jpeg" }),
    );

    // Both s1 and s2 fit within 1,000,000 bytes (921,600 <= 1,000,000).
    expect(
      peekCachedCompositionCapture({ projectId: "proj-mem", previewUrl: url1, contentRevision: 0, frameCount: 8 }),
    ).toBe(v1);
    expect(
      peekCachedCompositionCapture({ projectId: "proj-mem", previewUrl: url2, contentRevision: 0, frameCount: 8 }),
    ).toBe(v2);

    // Inserting s3 pushes total to 1,382,400 > 1,000,000 -> evicts oldest (s1),
    // but s1's blob URL stays alive until releaseV1() is called!
    const v3 = seedClientCompositionSpriteForTest(
      { projectId: "proj-mem", previewUrl: url3, contentRevision: 0, frameCount: 8 },
      new Blob(["s3"], { type: "image/jpeg" }),
    );
    expect(
      peekCachedCompositionCapture({ projectId: "proj-mem", previewUrl: url1, contentRevision: 0, frameCount: 8 }),
    ).toBeNull();
    expect(
      peekCachedCompositionCapture({ projectId: "proj-mem", previewUrl: url2, contentRevision: 0, frameCount: 8 }),
    ).toBe(v2);
    expect(
      peekCachedCompositionCapture({ projectId: "proj-mem", previewUrl: url3, contentRevision: 0, frameCount: 8 }),
    ).toBe(v3);
    expect(revoked).toEqual([]);

    releaseV1();
    expect(revoked).toEqual(["blob:mem-1"]);
  });

  it("isolates revision updates through compositionRevisionKey without invalidating untouched scenes on audio edits", () => {
    setCachedProjectRevision("proj-mod", "rev-1", {
      "compositions/a.html": '"sha256:a1"|shared:head1:assets1',
      "compositions/b.html": '"sha256:b1"|shared:head1:assets1',
    });
    const beforeA = getCompositionCacheKeyRevision("proj-mod", "compositions/a.html", 0);
    const beforeB = getCompositionCacheKeyRevision("proj-mod", "compositions/b.html", 0);

    // Pure audio upload leaves both A and B intact.
    updateCachedCompositionRevisions("proj-mod", { "assets/track.m4a": '"sha256:aud"' });
    expect(getCompositionCacheKeyRevision("proj-mod", "compositions/a.html", 0)).toBe(beforeA);
    expect(getCompositionCacheKeyRevision("proj-mod", "compositions/b.html", 0)).toBe(beforeB);

    // Editing A updates only A.
    updateCachedCompositionRevisions("proj-mod", { "compositions/a.html": '"patch:a2"' });
    expect(getCompositionCacheKeyRevision("proj-mod", "compositions/a.html", 0)).not.toBe(beforeA);
    expect(getCompositionCacheKeyRevision("proj-mod", "compositions/b.html", 0)).toBe(beforeB);
  });

  it("keeps scenes without |media: warm on unused image upload and preserves |media: across live HTML edits", () => {
    setCachedProjectRevision("proj-media", "rev-1", {
      "compositions/pure.html": '"sha256:p1"|shared:head1:assets1',
      "compositions/with-img.html": '"sha256:m1"|media:abc123def456|shared:head1:assets1',
    });
    const pureBefore = getCompositionCacheKeyRevision("proj-media", "compositions/pure.html", 0);
    const imgBefore = getCompositionCacheKeyRevision("proj-media", "compositions/with-img.html", 0);

    // Live HTML edit on a leaf scene with |media: preserves the |media: hash suffix for reload parity.
    updateCachedCompositionRevisions("proj-media", { "compositions/with-img.html": '"patch:m2"' });
    expect(getCompositionCacheKeyRevision("proj-media", "compositions/with-img.html", 0)).toBe(
      'file:"patch:m2"|media:abc123def456|shared:head1:assets1',
    );
    expect(getCompositionCacheKeyRevision("proj-media", "compositions/pure.html", 0)).toBe(pureBefore);

    // Uploading/editing a visual image leaves scenes without |media: untouched while refreshing |media: scenes.
    updateCachedCompositionRevisions("proj-media", { "assets/unused.png": '"sha256:png1"' });
    expect(getCompositionCacheKeyRevision("proj-media", "compositions/pure.html", 0)).toBe(pureBefore);
    expect(getCompositionCacheKeyRevision("proj-media", "compositions/with-img.html", 0)).not.toBe(imgBefore);
  });

  it("keeps peekCachedCompositionCapture read-only without evicting or revoking unretained URLs", () => {
    let seq = 0;
    const revoked: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:ro-${++seq}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revoked.push(String(url));
    });

    setMemoryStripCacheMaxBytesForTest(500_000);
    setCachedProjectRevision("proj-ro", "rev-1", {
      "compositions/s1.html": '"sha256:s1"|shared:h1:a1',
      "compositions/s2.html": '"sha256:s2"|shared:h1:a1',
    });
    const url1 = "/api/projects/proj-ro/preview/comp/compositions/s1.html";
    const url2 = "/api/projects/proj-ro/preview/comp/compositions/s2.html";
    seedClientCompositionSpriteForTest(
      { projectId: "proj-ro", previewUrl: url1, contentRevision: 0, frameCount: 8 },
      new Blob(["s1"], { type: "image/jpeg" }),
    );
    // Seeding s2 evicts s1 from memoryStripCache, leaving s1 only in sharedCoverCache.
    const v2 = seedClientCompositionSpriteForTest(
      { projectId: "proj-ro", previewUrl: url2, contentRevision: 0, frameCount: 8 },
      new Blob(["s2"], { type: "image/jpeg" }),
    );
    const revokedBeforePeek = revoked.length;

    // Peeking s1 (frameCount: 1) during render must NOT hydrate from sharedCoverCache or evict/revoke v2.
    expect(
      peekCachedCompositionCapture({ projectId: "proj-ro", previewUrl: url1, contentRevision: 0, frameCount: 1 }),
    ).toBeNull();
    expect(revoked.length).toBe(revokedBeforePeek);
    expect(
      peekCachedCompositionCapture({ projectId: "proj-ro", previewUrl: url2, contentRevision: 0, frameCount: 8 }),
    ).toBe(v2);
  });

  it("returns empty fallback URLs when video fallback and child clip source windows do not overlap", () => {
    const urls = ["f0", "f1", "f2", "f3"];
    expect(sliceVideoFallbackUrls(urls, 0, 5, 20, 5)).toEqual([]);
    expect(sliceVideoFallbackUrls(urls, 0, 10, 5, 5)).toEqual(["f2", "f3"]);
  });
});
