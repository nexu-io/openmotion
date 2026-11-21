import { buildProjectApiPath } from "../../utils/projectRouting";
import { studioApiFetch } from "../../utils/studioApiFetch";
import { resolvePreviewRelative } from "../../utils/previewRelativePath";
import { waitForMediaDerived } from "../../utils/mediaDerivedBus";
import type { TimelineElement } from "../store/timelineElement";
import { clipSourcePeak, isPeakMap, type ClipSourceWindow, type PeakMap } from "./clipPeakRuns";
import { authoredSrcPath, encodePreviewPath, resolveMediaPreviewUrl } from "./thumbnailUtils";

const peakMapRequests = new Map<string, Promise<PeakMap | null>>();

async function fetchPeakMapWithRetry(url: string): Promise<PeakMap | null> {
  let delayMs = 500;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const res = await studioApiFetch(url);
    if (res.status === 202) {
      const pendingBody = (await res.json().catch(() => null)) as { sha256?: string } | null;
      const expectedSha = typeof pendingBody?.sha256 === "string" ? pendingBody.sha256 : undefined;
      const sseEvent = await waitForMediaDerived(
        (evt) => evt.kind === "waveform" && (!expectedSha || evt.sha256 === expectedSha),
        delayMs,
      ).catch(() => null);
      if (sseEvent?.status === "failed") return null;
      delayMs = Math.min(4000, Math.round(delayMs * 1.6));
      continue;
    }
    if (!res.ok) return null;
    const body: unknown = await res.json().catch(() => null);
    if (typeof body === "object" && body !== null && (body as { pending?: unknown }).pending === true) {
      await waitForMediaDerived((evt) => evt.kind === "waveform", delayMs).catch(() => null);
      delayMs = Math.min(4000, Math.round(delayMs * 1.6));
      continue;
    }
    return isPeakMap(body) ? body : null;
  }
  return null;
}

/** One fetch per peak-map URL per session; transient `202 pending` retries instead of poisoning cache with null. */
export function loadPeakMap(url: string): Promise<PeakMap | null> {
  const pending = peakMapRequests.get(url);
  if (pending) return pending;
  const request = fetchPeakMapWithRetry(url)
    .catch(() => null)
    .then((result) => {
      // Never permanently cache null so a later retry after background extraction succeeds.
      if (result === null && peakMapRequests.get(url) === request) {
        peakMapRequests.delete(url);
      }
      return result;
    });
  peakMapRequests.set(url, request);
  return request;
}

/** The studio-server `/peaks/*` URL for a clip's project media, or undefined for outside media. */
export function clipPeaksUrl(src: string | undefined, projectId: string): string | undefined {
  const origin = window.location.origin;
  const relative = resolvePreviewRelative(
    resolveMediaPreviewUrl(authoredSrcPath(src ?? ""), projectId, origin),
    projectId,
    origin,
  );
  return relative
    ? buildProjectApiPath(projectId, `/peaks/${encodePreviewPath(relative)}`)
    : undefined;
}

export function clipSourceWindow(el: TimelineElement): ClipSourceWindow {
  return { mediaStart: el.playbackStart ?? 0, sourceSpan: el.duration * (el.playbackRate ?? 1) };
}

/** The clip's source peak, linear, over the part it plays; null when it cannot be measured. */
export async function measureClipSourcePeak(
  el: TimelineElement,
  projectId: string,
): Promise<number | null> {
  const url = clipPeaksUrl(el.src, projectId);
  const map = url ? await loadPeakMap(url) : null;
  return map ? clipSourcePeak(map, clipSourceWindow(el)) : null;
}
