import { describe, expect, it, vi } from "vitest";
import { resolveTimelineViewportBudgets } from "./timelineViewportBudgets";
import {
  createThumbnailKey,
  createThumbnailRequestIdentity,
  ThumbnailScheduler,
  type ThumbnailLoadedResult,
  type ThumbnailPriority,
  type ThumbnailRequest,
} from "./thumbnailScheduler";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function result(name: string, weight = 1, dispose = vi.fn()): ThumbnailLoadedResult {
  return { value: { kind: "image", url: name, aspect: 1 }, weight, dispose };
}

function request(
  key: string,
  load: ThumbnailRequest["load"],
  priority: ThumbnailPriority = "visible",
  overrides: Partial<ThumbnailRequest> = {},
): ThumbnailRequest {
  return {
    key,
    projectId: "project-a",
    sessionEpoch: 1,
    kind: "image",
    priority,
    load,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ThumbnailScheduler", () => {
  it("deduplicates identical requests and releases subscribers independently", async () => {
    const scheduler = new ThumbnailScheduler();
    const pending = deferred<ThumbnailLoadedResult>();
    const load = vi.fn(() => pending.promise);
    const listenerA = vi.fn();
    const listenerB = vi.fn();

    const leaseA = scheduler.acquire(request("same", load), listenerA);
    const leaseB = scheduler.acquire(request("same", load), listenerB);
    expect(load).toHaveBeenCalledTimes(1);

    leaseA.release();
    listenerA.mockClear();
    pending.resolve(result("poster"));
    await flush();
    expect(scheduler.getSnapshot(request("same", load))).toMatchObject({
      status: "ready",
      value: { url: "poster" },
    });
    expect(listenerA).not.toHaveBeenCalled();
    expect(listenerB).toHaveBeenCalled();

    leaseB.release();
    expect(scheduler.getDiagnostics().leases).toBe(0);
  });

  it("keeps snapshots referentially stable and supports independent leases sharing a callback", async () => {
    const scheduler = new ThumbnailScheduler();
    const listener = vi.fn();
    const shared = request("stable", async () => result("stable"));
    const first = scheduler.acquire(shared, listener);
    const second = scheduler.acquire(shared, listener);
    await flush();
    expect(scheduler.getSnapshot(shared)).toBe(scheduler.getSnapshot(shared));
    listener.mockClear();
    scheduler.invalidateProject("project-a");
    expect(listener).not.toHaveBeenCalled();
    expect(scheduler.getDiagnostics().leases).toBe(2);
    first.release();
    second.release();
    scheduler.invalidateProject("project-a");
    expect(scheduler.getSnapshot(shared).status).toBe("idle");
  });

  it("scopes the same caller key by work shape", async () => {
    const scheduler = new ThumbnailScheduler();
    const poster = request("shared", async () => result("poster"));
    const strip = request("shared", async () => result("strip"), "visible", {
      kind: "video",
      rich: true,
    });

    scheduler.acquire(poster, vi.fn());
    scheduler.acquire(strip, vi.fn());
    await flush();

    expect(scheduler.getSnapshot(poster)).toMatchObject({
      status: "ready",
      value: { url: "poster" },
    });
    expect(scheduler.getSnapshot(strip)).toMatchObject({
      status: "ready",
      value: { url: "strip" },
    });
  });

  it("orders interaction before visible before overscan when a slot opens", async () => {
    const scheduler = new ThumbnailScheduler(
      resolveTimelineViewportBudgets({ concurrentMetadataJobs: 1 }),
    );
    const first = deferred<ThumbnailLoadedResult>();
    const starts: string[] = [];
    const load = (name: string, pending?: ReturnType<typeof deferred<ThumbnailLoadedResult>>) =>
      vi.fn(() => {
        starts.push(name);
        return pending?.promise ?? Promise.resolve(result(name));
      });

    scheduler.acquire(request("first", load("first", first)), vi.fn());
    scheduler.acquire(request("overscan", load("overscan"), "overscan"), vi.fn());
    scheduler.acquire(request("visible", load("visible"), "visible"), vi.fn());
    scheduler.acquire(request("interaction", load("interaction"), "interaction"), vi.fn());
    expect(starts).toEqual(["first"]);

    first.resolve(result("first"));
    await vi.waitFor(() => {
      expect(starts).toEqual(["first", "interaction", "visible", "overscan"]);
    });
  });

  it("suspends new rich work while scrolling but lets posters proceed", async () => {
    const scheduler = new ThumbnailScheduler();
    const richLoad = vi.fn(async () => result("rich"));
    const posterLoad = vi.fn(async () => result("poster"));
    scheduler.setScrolling(true);

    scheduler.acquire(request("rich", richLoad, "interaction", { rich: true }), vi.fn());
    scheduler.acquire(request("poster", posterLoad), vi.fn());
    await flush();
    expect(richLoad).not.toHaveBeenCalled();
    expect(posterLoad).toHaveBeenCalledTimes(1);

    scheduler.setScrolling(false);
    await flush();
    expect(richLoad).toHaveBeenCalledTimes(1);
  });

  it("starts no visible or overscan video decode while the preview plays, but still a scrub's", async () => {
    const scheduler = new ThumbnailScheduler();
    const starts: string[] = [];
    const load = (name: string) =>
      vi.fn(async () => {
        starts.push(name);
        return result(name);
      });
    const video = { kind: "video" as const };
    scheduler.setPlaybackActive(true);

    const visible = scheduler.acquire(
      request("visible", load("visible"), "visible", video),
      vi.fn(),
    );
    scheduler.acquire(request("overscan", load("overscan"), "overscan", video), vi.fn());
    scheduler.acquire(request("scrub", load("scrub"), "interaction", video), vi.fn());
    scheduler.acquire(request("image", load("image"), "visible"), vi.fn());
    await flush();
    expect(starts).toEqual(["scrub", "image"]);

    visible.updatePriority("interaction");
    await flush();
    expect(starts).toEqual(["scrub", "image", "visible"]);
  });

  it("drains the video decodes it held once playback pauses", async () => {
    const scheduler = new ThumbnailScheduler();
    const starts: string[] = [];
    const load = (name: string) =>
      vi.fn(async () => {
        starts.push(name);
        return result(name);
      });
    scheduler.setPlaybackActive(true);
    scheduler.acquire(request("visible", load("visible"), "visible", { kind: "video" }), vi.fn());
    scheduler.acquire(
      request("overscan", load("overscan"), "overscan", { kind: "video" }),
      vi.fn(),
    );
    await flush();
    expect(starts).toEqual([]);

    scheduler.setPlaybackActive(false);
    await vi.waitFor(() => expect(starts).toEqual(["visible", "overscan"]));
  });

  it("holds composition renders while the preview reloads and re-runs the ones it preempted", async () => {
    const scheduler = new ThumbnailScheduler();
    const signals: AbortSignal[] = [];
    const composition = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<ThumbnailLoadedResult>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        if (signals.length > 1) resolve(result("scene"));
      });
    });
    const image = vi.fn(async () => result("still"));
    const scene = request("scene", composition, "visible", { kind: "composition" });
    const still = request("still", image);

    scheduler.acquire(scene, vi.fn());
    expect(composition).toHaveBeenCalledTimes(1);
    scheduler.setPreviewReloading(true);
    await flush();
    expect(signals[0]?.aborted).toBe(true);
    expect(scheduler.getSnapshot(scene)).toEqual({ status: "queued" });
    scheduler.acquire(still, vi.fn());
    expect(image).toHaveBeenCalledTimes(1);
    expect(composition).toHaveBeenCalledTimes(1);

    scheduler.setPreviewReloading(false);
    await flush();
    expect(composition).toHaveBeenCalledTimes(2);
    expect(scheduler.getSnapshot(scene)).toMatchObject({
      status: "ready",
      value: { url: "scene" },
    });
  });

  it("aborts queued and active jobs after the final release", async () => {
    const scheduler = new ThumbnailScheduler(
      resolveTimelineViewportBudgets({ concurrentVideoDecodes: 1 }),
    );
    const active = deferred<ThumbnailLoadedResult>();
    let activeSignal: AbortSignal | undefined;
    const activeLease = scheduler.acquire(
      request(
        "active",
        (signal) => {
          activeSignal = signal;
          return active.promise;
        },
        "visible",
        { kind: "video" },
      ),
      vi.fn(),
    );
    const queuedLoad = vi.fn(async () => result("queued"));
    const queuedLease = scheduler.acquire(
      request("queued", queuedLoad, "visible", { kind: "video" }),
      vi.fn(),
    );

    queuedLease.release();
    activeLease.release();
    expect(activeSignal?.aborted).toBe(true);
    expect(queuedLoad).not.toHaveBeenCalled();
    active.reject(new DOMException("aborted", "AbortError"));
    await flush();
    expect(scheduler.getDiagnostics()).toMatchObject({ queued: 0, active: 0, leases: 0 });
  });

  it("starts nothing that a release later in the same batch drops", async () => {
    const scheduler = new ThumbnailScheduler(
      resolveTimelineViewportBudgets({ concurrentVideoDecodes: 1 }),
    );
    const video = (key: string, load: ThumbnailRequest["load"]) =>
      scheduler.acquire(request(key, load, "visible", { kind: "video" }), vi.fn());
    const activeLease = video("active", () => deferred<ThumbnailLoadedResult>().promise);
    const droppedLoad = vi.fn(async () => result("dropped"));
    const droppedLease = video("dropped", droppedLoad);
    const keptLoad = vi.fn(async () => result("kept"));
    video("kept", keptLoad);

    // A timeline jump unmounts its clips in one commit, the loading one first.
    activeLease.release();
    droppedLease.release();
    await flush();
    expect(droppedLoad).not.toHaveBeenCalled();
    expect(keptLoad).toHaveBeenCalledTimes(1);
  });

  it("frees an aborted job's slot at once, even when its loader ignores the abort", async () => {
    const scheduler = new ThumbnailScheduler(
      resolveTimelineViewportBudgets({ concurrentVideoDecodes: 1 }),
    );
    const stuck = deferred<ThumbnailLoadedResult>();
    const lease = scheduler.acquire(
      request("stuck", () => stuck.promise, "visible", { kind: "video" }),
      vi.fn(),
    );
    lease.release();
    const nextLoad = vi.fn(async () => result("next"));
    scheduler.acquire(request("next", nextLoad, "visible", { kind: "video" }), vi.fn());
    expect(nextLoad).toHaveBeenCalledTimes(1);
  });

  it("disposes a late result exactly once after its final lease releases", async () => {
    const scheduler = new ThumbnailScheduler();
    const pending = deferred<ThumbnailLoadedResult>();
    const dispose = vi.fn();
    const lease = scheduler.acquire(
      request("late", () => pending.promise),
      vi.fn(),
    );

    lease.release();
    pending.resolve(result("late", 1, dispose));
    await flush();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(scheduler.getSnapshot(request("late", () => pending.promise))).toEqual({
      status: "idle",
    });
  });

  it("preserves a synchronous re-acquire when an expired failure is replaced", async () => {
    vi.useFakeTimers();
    const scheduler = new ThumbnailScheduler(
      resolveTimelineViewportBudgets({ metadataFailureTtlMs: 10 }),
    );
    const load = vi
      .fn<ThumbnailRequest["load"]>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue(result("recovered"));
    const failed = request("retry", load);
    let reacquireOnNotify = false;
    let nestedLease: ReturnType<ThumbnailScheduler["acquire"]> | undefined;
    const firstLease = scheduler.acquire(failed, () => {
      if (!reacquireOnNotify) return;
      reacquireOnNotify = false;
      nestedLease = scheduler.acquire(failed, vi.fn());
    });
    await flush();
    vi.advanceTimersByTime(11);
    reacquireOnNotify = true;

    const outerLease = scheduler.acquire(failed, vi.fn());
    await flush();

    expect(load).toHaveBeenCalledTimes(2);
    expect(scheduler.getSnapshot(failed)).toMatchObject({
      status: "ready",
      value: { url: "recovered" },
    });
    expect(scheduler.getDiagnostics().leases).toBe(2);
    firstLease.release();
    nestedLease?.release();
    outerLease.release();
    vi.useRealTimers();
  });

  it("times out a hung loader, frees its bucket, and disposes a late result", async () => {
    vi.useFakeTimers();
    const scheduler = new ThumbnailScheduler(
      resolveTimelineViewportBudgets({
        concurrentVideoDecodes: 1,
        thumbnailLoadTimeoutMs: 10,
      }),
    );
    const hung = deferred<ThumbnailLoadedResult>();
    const dispose = vi.fn();
    let signal: AbortSignal | undefined;
    const hungRequest = request(
      "hung",
      (activeSignal) => {
        signal = activeSignal;
        return hung.promise;
      },
      "visible",
      { kind: "video" },
    );
    const nextLoad = vi.fn(async () => result("next"));
    const nextRequest = request("next", nextLoad, "visible", { kind: "video" });
    const hungLease = scheduler.acquire(hungRequest, vi.fn());
    const nextLease = scheduler.acquire(nextRequest, vi.fn());

    await vi.advanceTimersByTimeAsync(11);
    await flush();
    expect(signal?.aborted).toBe(true);
    // Said apart from a cancel: a job that timed out without progress failed its source.
    expect(signal?.reason).toMatchObject({ name: "TimeoutError" });
    expect(nextLoad).toHaveBeenCalledTimes(1);
    expect(scheduler.getSnapshot(hungRequest).status).toBe("error");

    hung.resolve(result("late", 1, dispose));
    await flush();
    expect(dispose).toHaveBeenCalledTimes(1);
    hungLease.release();
    nextLease.release();
    vi.useRealTimers();
  });

  it("isolates late results by session epoch", async () => {
    const scheduler = new ThumbnailScheduler();
    const old = deferred<ThumbnailLoadedResult>();
    const oldRequest = request("poster", () => old.promise, "visible", { sessionEpoch: 1 });
    const nextRequest = request("poster", async () => result("next"), "visible", {
      sessionEpoch: 2,
    });
    scheduler.acquire(oldRequest, vi.fn());
    scheduler.acquire(nextRequest, vi.fn());
    await flush();
    old.resolve(result("old"));
    await flush();
    expect(scheduler.getSnapshot(nextRequest)).toMatchObject({
      status: "ready",
      value: { url: "next" },
    });
  });

  it("turns synchronous loader errors into bounded failure snapshots", async () => {
    const scheduler = new ThumbnailScheduler();
    const bad = request("throws", () => {
      throw new Error("sync failure");
    });
    const lease = scheduler.acquire(bad, vi.fn());
    await flush();
    expect(scheduler.getSnapshot(bad)).toMatchObject({ status: "error" });
    expect(scheduler.getDiagnostics().active).toBe(0);
    lease.release();
  });

  it("disposes uncached results after the final lease and tolerates broken disposers", async () => {
    const scheduler = new ThumbnailScheduler(
      resolveTimelineViewportBudgets({ thumbnailCacheBytes: 1 }),
    );
    const dispose = vi.fn(() => {
      throw new Error("cleanup failure");
    });
    const oversized = request("oversized", async () => result("large", 2, dispose));
    const lease = scheduler.acquire(oversized, vi.fn());
    await flush();
    expect(scheduler.getSnapshot(oversized).status).toBe("ready");
    expect(() => lease.release()).not.toThrow();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(scheduler.getSnapshot(oversized).status).toBe("idle");
  });

  it("evicts least-recently-used unleased values by bytes, count, and project count", async () => {
    const scheduler = new ThumbnailScheduler(
      resolveTimelineViewportBudgets({
        thumbnailCacheBytes: 6,
        thumbnailCacheEntries: 2,
        thumbnailCacheEntriesPerProject: 2,
      }),
    );
    const disposals = [vi.fn(), vi.fn(), vi.fn()];
    for (let index = 0; index < 3; index++) {
      const lease = scheduler.acquire(
        request(`key-${index}`, async () => result(`url-${index}`, 3, disposals[index])),
        vi.fn(),
      );
      await flush();
      lease.release();
    }

    expect(scheduler.getDiagnostics()).toMatchObject({ cacheEntries: 2, cacheBytes: 6 });
    expect(disposals[0]).toHaveBeenCalledTimes(1);
    expect(disposals[1]).not.toHaveBeenCalled();
    expect(disposals[2]).not.toHaveBeenCalled();
  });

  it("keeps failed requests quiet until the TTL expires", async () => {
    vi.useFakeTimers();
    const scheduler = new ThumbnailScheduler(
      resolveTimelineViewportBudgets({ metadataFailureTtlMs: 100 }),
    );
    const load = vi.fn(async () => {
      throw new Error("unsupported");
    });

    const first = scheduler.acquire(request("failed", load), vi.fn());
    await flush();
    first.release();
    const second = scheduler.acquire(request("failed", load), vi.fn());
    expect(load).toHaveBeenCalledTimes(1);
    second.release();

    vi.advanceTimersByTime(101);
    scheduler.acquire(request("failed", load), vi.fn());
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("isolates client-capture concurrency from composition poster fetches while still preempting on preview reload", async () => {
    const scheduler = new ThumbnailScheduler(
      resolveTimelineViewportBudgets({
        concurrentCompositionFetches: 2,
        concurrentClientCompositionCaptures: 3,
      }),
    );
    const captureSignals: AbortSignal[] = [];
    const starts: string[] = [];
    for (let i = 0; i < 4; i++) {
      scheduler.acquire(
        request(
          `cap-${i}`,
          (signal) => {
            starts.push(`cap-${i}`);
            captureSignals.push(signal);
            return new Promise<ThumbnailLoadedResult>((_, reject) => {
              signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
            });
          },
          "visible",
          { kind: "composition", concurrencyBucket: "client-capture" },
        ),
        vi.fn(),
      );
    }
    for (let i = 0; i < 2; i++) {
      scheduler.acquire(
        request(
          `poster-${i}`,
          () => {
            starts.push(`poster-${i}`);
            return deferred<ThumbnailLoadedResult>().promise;
          },
          "visible",
          { kind: "composition" },
        ),
        vi.fn(),
      );
    }
    // 3 client captures AND 2 posters run simultaneously without blocking each other.
    expect(starts).toEqual(["cap-0", "cap-1", "cap-2", "poster-0", "poster-1"]);

    // Preview reload still preempts client-capture jobs because their kind is "composition".
    scheduler.setPreviewReloading(true);
    await flush();
    expect(captureSignals.every((s) => s.aborted)).toBe(true);
  });

  it("evicts matching unleased entries immediately and disposes matching leased entries on release", async () => {
    const scheduler = new ThumbnailScheduler();
    const disposeStaleUnleased = vi.fn();
    const disposeStaleLeased = vi.fn();
    const disposeUntouched = vi.fn();
    const disposeOtherProject = vi.fn();

    const staleUnleasedReq = request("stale-unleased", async () => result("u", 1, disposeStaleUnleased), "visible", {
      kind: "composition",
      compositionPath: "compositions/choice.html",
      contentRevision: 0,
    });
    const staleLeasedReq = request("stale-leased", async () => result("l", 1, disposeStaleLeased), "visible", {
      kind: "composition",
      compositionPath: "compositions/choice.html",
      contentRevision: 1,
    });
    const untouchedReq = request("untouched", async () => result("k", 1, disposeUntouched), "visible", {
      kind: "composition",
      compositionPath: "compositions/intro.html",
      contentRevision: 0,
    });
    const otherProjReq = request("other-proj", async () => result("o", 1, disposeOtherProject), "visible", {
      projectId: "project-b",
      kind: "composition",
      compositionPath: "compositions/choice.html",
      contentRevision: 0,
    });

    const leaseUnleased = scheduler.acquire(staleUnleasedReq, vi.fn());
    const leaseLeased = scheduler.acquire(staleLeasedReq, vi.fn());
    const leaseUntouched = scheduler.acquire(untouchedReq, vi.fn());
    const leaseOther = scheduler.acquire(otherProjReq, vi.fn());
    await flush();

    leaseUnleased.release();
    leaseUntouched.release();
    leaseOther.release();

    scheduler.invalidateMatching(
      "project-a",
      (req) => req.compositionPath === "compositions/choice.html" && (req.contentRevision ?? 0) < 2,
    );

    expect(disposeStaleUnleased).toHaveBeenCalledTimes(1);
    expect(scheduler.getSnapshot(staleUnleasedReq).status).toBe("idle");
    // Active consumer still displays staleLeased until it switches to the new revision and releases.
    expect(disposeStaleLeased).not.toHaveBeenCalled();
    expect(scheduler.getSnapshot(staleLeasedReq).status).toBe("ready");
    // Untouched compositions and other projects stay cached.
    expect(disposeUntouched).not.toHaveBeenCalled();
    expect(disposeOtherProject).not.toHaveBeenCalled();

    leaseLeased.release();
    expect(disposeStaleLeased).toHaveBeenCalledTimes(1);
    expect(scheduler.getSnapshot(staleLeasedReq).status).toBe("idle");
  });

  it("leaves queued and loading entries uncached when invalidated in flight and disposes them on release", async () => {
    const scheduler = new ThumbnailScheduler(
      resolveTimelineViewportBudgets({ concurrentCompositionFetches: 1 }),
    );
    const loadingDeferred = deferred<ThumbnailLoadedResult>();
    const queuedDeferred = deferred<ThumbnailLoadedResult>();
    const disposeLoading = vi.fn();
    const disposeQueued = vi.fn();

    const loadingReq = request(
      "in-flight-loading",
      () => loadingDeferred.promise,
      "visible",
      {
        kind: "composition",
        compositionPath: "compositions/choice.html",
        contentRevision: 0,
      },
    );
    const queuedReq = request(
      "in-flight-queued",
      () => queuedDeferred.promise,
      "visible",
      {
        kind: "composition",
        compositionPath: "compositions/choice.html",
        contentRevision: 0,
      },
    );

    const loadingLease = scheduler.acquire(loadingReq, vi.fn());
    const queuedLease = scheduler.acquire(queuedReq, vi.fn());
    expect(scheduler.getSnapshot(loadingReq).status).toBe("loading");
    expect(scheduler.getSnapshot(queuedReq).status).toBe("queued");

    // Invalidate while loadingReq is in flight and queuedReq is still queued.
    scheduler.invalidateMatching(
      "project-a",
      (req) => req.compositionPath === "compositions/choice.html" && (req.contentRevision ?? 0) < 1,
    );

    // Late completion of loadingReq delivers to its active lease without entering the LRU cache.
    loadingDeferred.resolve(result("late-loading", 10, disposeLoading));
    await flush();
    expect(scheduler.getSnapshot(loadingReq).status).toBe("ready");
    expect(scheduler.getDiagnostics().cacheEntries).toBe(0);
    expect(disposeLoading).not.toHaveBeenCalled();

    // Releasing the loading lease disposes it immediately rather than caching it.
    loadingLease.release();
    expect(disposeLoading).toHaveBeenCalledTimes(1);
    expect(scheduler.getSnapshot(loadingReq).status).toBe("idle");

    // queuedReq now runs and settles, likewise staying uncached and disposing immediately on release.
    await vi.waitFor(() => expect(scheduler.getSnapshot(queuedReq).status).toBe("loading"));
    queuedDeferred.resolve(result("late-queued", 10, disposeQueued));
    await flush();
    expect(scheduler.getSnapshot(queuedReq).status).toBe("ready");
    expect(scheduler.getDiagnostics().cacheEntries).toBe(0);
    expect(disposeQueued).not.toHaveBeenCalled();

    queuedLease.release();
    expect(disposeQueued).toHaveBeenCalledTimes(1);
    expect(scheduler.getSnapshot(queuedReq).status).toBe("idle");
  });

  it("re-queues failed leased entries in place via retryFailed without waiting for failure TTL", async () => {
    const scheduler = new ThumbnailScheduler();
    let attempt = 0;
    const load = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient capture timeout");
      return result("recovered");
    });
    const req = request("comp-retry", load, "visible", {
      projectId: "project-a",
      kind: "composition",
      compositionPath: "compositions/hero.html",
    });

    const lease = scheduler.acquire(req, vi.fn());
    await vi.waitFor(() => expect(scheduler.getSnapshot(req).status).toBe("error"));
    expect(load).toHaveBeenCalledTimes(1);

    // Non-matching path leaves the entry untouched.
    expect(scheduler.retryFailed("project-a", "compositions/other.html")).toBe(0);
    expect(scheduler.getSnapshot(req).status).toBe("error");

    // Matching path re-queues and recovers immediately.
    expect(scheduler.retryFailed("project-a", "./compositions/hero.html")).toBe(1);
    await vi.waitFor(() =>
      expect(scheduler.getSnapshot(req)).toMatchObject({
        status: "ready",
        value: { url: "recovered" },
      }),
    );
    expect(load).toHaveBeenCalledTimes(2);
    lease.release();
  });

  it("keeps non-gated client-capture jobs out of slots during the opening gate so gated work starts immediately", async () => {
    const scheduler = new ThumbnailScheduler(
      resolveTimelineViewportBudgets({ concurrentClientCompositionCaptures: 3 }),
    );
    const starts: string[] = [];
    const makeCapture = (name: string, gatePriority: boolean) =>
      request(
        name,
        async () => {
          starts.push(name);
          return result(name);
        },
        gatePriority ? "interaction" : "overscan",
        { kind: "composition", concurrencyBucket: "client-capture", gatePriority },
      );

    scheduler.setOpeningGateActive(true);
    const sidebarLeases = [0, 1, 2].map((idx) =>
      scheduler.acquire(makeCapture(`sidebar-${idx}`, false), vi.fn()),
    );
    expect(starts).toEqual([]);
    expect(scheduler.getDiagnostics()).toMatchObject({ queued: 3, active: 0 });

    const gatedReq = makeCapture("timeline-gated", true);
    const gatedLease = scheduler.acquire(gatedReq, vi.fn());
    await vi.waitFor(() => expect(scheduler.getSnapshot(gatedReq).status).toBe("ready"));
    expect(starts).toEqual(["timeline-gated"]);

    scheduler.setOpeningGateActive(false);
    await vi.waitFor(() =>
      expect(starts).toEqual(["timeline-gated", "sidebar-0", "sidebar-1", "sidebar-2"]),
    );
    gatedLease.release();
    for (const lease of sidebarLeases) lease.release();
  });

  it("preempts active non-gated client-capture jobs when the opening gate activates and resumes them after", async () => {
    const scheduler = new ThumbnailScheduler(
      resolveTimelineViewportBudgets({ concurrentClientCompositionCaptures: 1 }),
    );
    const signals: AbortSignal[] = [];
    const nonGated = request(
      "sidebar-early",
      (signal) => {
        signals.push(signal);
        return new Promise<ThumbnailLoadedResult>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          if (signals.length > 1) resolve(result("sidebar-early"));
        });
      },
      "overscan",
      { kind: "composition", concurrencyBucket: "client-capture", gatePriority: false },
    );
    const gated = request("timeline-gated", async () => result("timeline-gated"), "interaction", {
      kind: "composition",
      concurrencyBucket: "client-capture",
      gatePriority: true,
    });

    const nonGatedLease = scheduler.acquire(nonGated, vi.fn());
    expect(scheduler.getSnapshot(nonGated).status).toBe("loading");

    scheduler.setOpeningGateActive(true);
    await flush();
    expect(signals[0]?.aborted).toBe(true);
    expect(scheduler.getSnapshot(nonGated).status).toBe("queued");

    const gatedLease = scheduler.acquire(gated, vi.fn());
    await vi.waitFor(() => expect(scheduler.getSnapshot(gated).status).toBe("ready"));

    scheduler.setOpeningGateActive(false);
    await vi.waitFor(() => expect(scheduler.getSnapshot(nonGated).status).toBe("ready"));
    expect(signals).toHaveLength(2);
    gatedLease.release();
    nonGatedLease.release();
  });
});

describe("createThumbnailKey", () => {
  it("normalizes field order and preserves sentinel zero values", () => {
    expect(createThumbnailKey({ source: "clip a", time: 0, missing: undefined })).toBe(
      createThumbnailKey({ time: 0, source: "clip a" }),
    );
  });

  it("includes the work shape in request identity", () => {
    const poster = request("shared", vi.fn(), "visible", { kind: "video" });
    const strip = { ...poster, rich: true };
    expect(createThumbnailRequestIdentity(poster)).not.toBe(createThumbnailRequestIdentity(strip));
  });
});
