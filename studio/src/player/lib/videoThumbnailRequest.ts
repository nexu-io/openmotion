import {
  createThumbnailKey,
  thumbnailScheduler,
  type ThumbnailPriority,
  type ThumbnailRequest,
} from "./thumbnailScheduler";
import { decodeVideoThumbnail } from "./thumbnailVideoDecoder";

export interface ReadyVideoFallbackEntry {
  readonly request: ThumbnailRequest;
  readonly sourceStart: number;
  readonly sourceRangeDuration: number;
  readonly frameCount: number;
}

const MAX_READY_VIDEO_FALLBACKS = 64;
const readyVideoFallbacks = new Map<string, ReadyVideoFallbackEntry>();

/**
 * Remember the latest ready video thumbnail request per `(projectId, sessionEpoch, videoSrc)`
 * so a newly mounted split/trimmed clip of the same source renders the parent's overlapping
 * decoded frames immediately (0ms shimmer, 0 extra decodes, 0 server requests).
 */
export function recordReadyVideoThumbnailRequest(
  mediaKey: string,
  entry: ReadyVideoFallbackEntry,
): void {
  const existing = readyVideoFallbacks.get(mediaKey);
  if (
    existing &&
    existing.frameCount > entry.frameCount &&
    thumbnailScheduler.getSnapshot(existing.request).status === "ready"
  ) {
    return;
  }
  if (existing) readyVideoFallbacks.delete(mediaKey);
  readyVideoFallbacks.set(mediaKey, entry);
  while (readyVideoFallbacks.size > MAX_READY_VIDEO_FALLBACKS) {
    const oldest = readyVideoFallbacks.keys().next().value;
    if (!oldest) break;
    readyVideoFallbacks.delete(oldest);
  }
}

/**
 * Return a still-ready cached video request for `mediaKey` if one is resident in
 * `thumbnailScheduler` right now (never triggers a new decode on miss or after invalidation).
 */
export function peekReadyVideoThumbnailRequest(mediaKey: string): ReadyVideoFallbackEntry | null {
  const entry = readyVideoFallbacks.get(mediaKey);
  if (!entry) return null;
  if (thumbnailScheduler.getSnapshot(entry.request).status !== "ready") {
    readyVideoFallbacks.delete(mediaKey);
    return null;
  }
  return entry;
}

/**
 * Slice a parent video's decoded filmstrip URLs to the sub-range covered by a newly split or
 * trimmed child clip so frame 0 already aligns with the child's source window.
 */
export function sliceVideoFallbackUrls(
  urls: readonly string[],
  parentStart: number,
  parentDuration: number,
  childStart: number,
  childDuration: number,
): readonly string[] {
  if (urls.length <= 1 || !Number.isFinite(parentDuration) || parentDuration <= 0) return urls;
  const safeChildStart = Number.isFinite(childStart) ? Math.max(0, childStart) : parentStart;
  const safeChildDur = Number.isFinite(childDuration) && childDuration > 0 ? childDuration : parentDuration;
  const parentEnd = parentStart + parentDuration;
  if (safeChildStart >= parentEnd || safeChildStart + safeChildDur <= parentStart) return [];
  const startFrac = Math.max(0, Math.min(1, (safeChildStart - parentStart) / parentDuration));
  const endFrac = Math.max(
    startFrac,
    Math.min(1, (safeChildStart + safeChildDur - parentStart) / parentDuration),
  );
  const fromIdx = Math.min(urls.length - 1, Math.floor(startFrac * urls.length));
  const toIdx = Math.max(fromIdx + 1, Math.min(urls.length, Math.ceil(endFrac * urls.length)));
  return urls.slice(fromIdx, toIdx);
}

export function createVideoThumbnailRequest(
  props: {
    videoSrc: string;
    sourceStart?: number;
    sourceRangeDuration?: number;
    duration: number;
    projectId: string;
    sessionEpoch: number;
    priority: ThumbnailPriority;
  },
  frameCount: number,
  rich: boolean,
) {
  const {
    videoSrc,
    sourceStart,
    sourceRangeDuration,
    duration,
    projectId,
    sessionEpoch,
    priority,
  } = props;
  return {
    key: createThumbnailKey({
      kind: "video",
      source: videoSrc,
      start: sourceStart,
      duration: sourceRangeDuration ?? duration,
      frames: frameCount,
    }),
    projectId,
    sessionEpoch,
    kind: "video" as const,
    priority,
    rich,
    load: (signal: AbortSignal) =>
      decodeVideoThumbnail(
        {
          source: videoSrc,
          contentVersion: createThumbnailKey({ project: projectId, session: sessionEpoch }),
          sourceStart,
          sourceRangeDuration: sourceRangeDuration ?? duration,
          frameCount,
          fit: "cover",
        },
        signal,
      ),
  };
}
