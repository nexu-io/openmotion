import { afterEach, describe, expect, it } from "vitest";
import type { TimelineElement } from "../store/playerStore";
import {
  clearCachedCompositionTimelinesForTest,
  getCachedCompositionTimeline,
  invalidateCachedCompositionTimelines,
  saveCachedCompositionTimeline,
} from "./compositionTimelineCache";

function makeElement(id: string): TimelineElement {
  return {
    id,
    tag: "div",
    label: id,
    start: 0,
    duration: 4,
    track: 0,
  };
}

describe("compositionTimelineCache", () => {
  afterEach(() => {
    clearCachedCompositionTimelinesForTest();
  });

  it("returns saved snapshot when project, composition path, and revision match", () => {
    saveCachedCompositionTimeline({
      projectId: "proj-1",
      compPath: "./compositions/intro.html",
      revisionKey: "file:sha-a|t:0",
      elements: [makeElement("hero"), makeElement("bg")],
      duration: 6.5,
    });

    const hit = getCachedCompositionTimeline("proj-1", "compositions/intro.html", "file:sha-a|t:0");
    expect(hit).not.toBeNull();
    expect(hit?.duration).toBe(6.5);
    expect(hit?.elements.map((e) => e.id)).toEqual(["hero", "bg"]);
  });

  it("invalidates automatically when the composition revision changes", () => {
    saveCachedCompositionTimeline({
      projectId: "proj-1",
      compPath: "index.html",
      revisionKey: "file:sha-v1|t:0",
      elements: [makeElement("scene-1")],
      duration: 12,
    });

    expect(getCachedCompositionTimeline("proj-1", "index.html", "file:sha-v2|t:1")).toBeNull();
    expect(getCachedCompositionTimeline("proj-1", "index.html", "file:sha-v1|t:0")).toBeNull();
  });

  it("ignores empty timelines or non-positive durations", () => {
    saveCachedCompositionTimeline({
      projectId: "proj-1",
      compPath: "index.html",
      revisionKey: "rev:0|t:0",
      elements: [],
      duration: 10,
    });
    saveCachedCompositionTimeline({
      projectId: "proj-1",
      compPath: "index.html",
      revisionKey: "rev:0|t:0",
      elements: [makeElement("a")],
      duration: 0,
    });

    expect(getCachedCompositionTimeline("proj-1", "index.html", "rev:0|t:0")).toBeNull();
  });

  it("evicts least-recently-used snapshots past the 64-entry ceiling and supports project invalidation", () => {
    for (let i = 0; i < 64; i += 1) {
      saveCachedCompositionTimeline({
        projectId: "proj-lru",
        compPath: `compositions/s-${i}.html`,
        revisionKey: "rev:1",
        elements: [makeElement(`el-${i}`)],
        duration: 5,
      });
    }
    // Touch s-0 so s-1 becomes the oldest entry.
    expect(getCachedCompositionTimeline("proj-lru", "compositions/s-0.html", "rev:1")).not.toBeNull();

    saveCachedCompositionTimeline({
      projectId: "proj-lru",
      compPath: "compositions/s-64.html",
      revisionKey: "rev:1",
      elements: [makeElement("el-64")],
      duration: 5,
    });

    expect(getCachedCompositionTimeline("proj-lru", "compositions/s-0.html", "rev:1")).not.toBeNull();
    expect(getCachedCompositionTimeline("proj-lru", "compositions/s-1.html", "rev:1")).toBeNull();

    invalidateCachedCompositionTimelines("proj-lru");
    expect(getCachedCompositionTimeline("proj-lru", "compositions/s-0.html", "rev:1")).toBeNull();
  });
});
