import type { TimelineElement } from "../store/playerStore";
import { sameSourceFile } from "./timelineAuthoredTrack";
import { canMoveTimelineElement } from "./timelineAuthoredMoveTarget";
import { resolveGroupMovers, groupMoveFloor } from "./timelineMultiDragPreview";
import { heldAudioShiftRange, linkedMembersOf } from "./audioClipLink";
import { isLinkedSelectionOn } from "../../utils/linkedClipPreferences";
import { timelineSpansOverlap, timelineTimesTouch } from "./timelineTimeBounds";
import { classifyZone } from "./timelineZones";
import { toAuthoredStart, savedClipEdges } from "../store/timelineElement";
import { collisionLane } from "./timelineCollisionIndex";

const keyOf = (element: TimelineElement) => element.key ?? element.id;
const savedStart = (el: TimelineElement, time: number) => savedClipEdges(el, time).start;
const after = (el: TimelineElement, time: number) =>
  time + (Math.ceil(toAuthoredStart(el, time) * 100 - 1e-6) / 100 - toAuthoredStart(el, time));

/** Insert between neighbours without requiring an empty clip-sized gap. */
export function previewClipInsert(
  elements: TimelineElement[], grabbed: TimelineElement, moving: ReadonlySet<string>,
  track: number, rawStart: number, pointerTime: number,
  linkedSelection = true,
): { start: number; insertion: ReadonlyMap<string, number> } | null {
  if (!canMoveTimelineElement(grabbed)) return null;
  const lane = collisionLane(elements, track).filter(el => !moving.has(keyOf(el)));
  const rightIndex = lane.findIndex((right, index) => index > 0 &&
    pointerTime >= lane[index - 1].start + lane[index - 1].duration / 2 &&
    pointerTime <= right.start + right.duration / 2);
  if (rightIndex < 1 || !lane.some(el => timelineSpansOverlap(rawStart, rawStart + grabbed.duration, el.start, el.start + el.duration))) return null;
  if (lane.some((el, index) =>
    !sameSourceFile(el, grabbed) || classifyZone(el) !== classifyZone(grabbed) ||
    el.expandedHostKey !== grabbed.expandedHostKey || el.timelineLocked ||
    (index > 0 && timelineSpansOverlap(lane[index - 1].start, lane[index - 1].start + lane[index - 1].duration, el.start, el.start + el.duration))
  )) return null;
  const movers = elements.filter(el => moving.has(keyOf(el)));
  const block = [grabbed, ...movers.filter(el => keyOf(el) !== keyOf(grabbed) && el.track === track)];
  const blockStart = Math.min(...block.map(el => el.start));
  const blockEnd = Math.max(...block.map(el => el.start + el.duration));
  const leftEnd = lane[rightIndex - 1].start + lane[rightIndex - 1].duration;
  if (lane[rightIndex].start - leftEnd >= blockEnd - blockStart - 0.001) return null;
  const boundary = after(grabbed, leftEnd);
  const delta = boundary - blockStart;
  const shift = heldAudioShiftRange(movers, elements, moving);
  const start = savedStart(grabbed, grabbed.start + delta);
  if (start < groupMoveFloor(grabbed, movers) || delta < shift.min || delta > shift.max) return null;
  const insertion = new Map(movers.map(el => [keyOf(el), savedStart(el, el.start + delta)]));
  const windows = block.map(el => savedClipEdges(el, el.start + delta)).sort((a, b) => a.start - b.start);
  let end = leftEnd;
  for (const window of windows) {
    if (window.start < end && !timelineTimesTouch(window.start, end)) return null;
    end = Math.max(end, window.end);
  }
  const pushes: { peer: TimelineElement; delta: number }[] = [];
  for (let index = rightIndex; index < lane.length; index++) {
    const peer = lane[index];
    const next = after(peer, end);
    if (next - peer.start <= 0.001) break;
    pushes.push({ peer, delta: next - peer.start });
    end = next + peer.duration;
  }
  if (pushes.length === 0) return null;
  const following = pushes.map(({ peer }) => peer);
  // Resolve linkage once, rather than rescanning the whole timeline for every pushed clip.
  const passengers = resolveGroupMovers(elements, new Set(following.map(keyOf)), keyOf(following[0])) ?? following;
  const byHost = new Map(following.map(el => [keyOf(el), [el]]));
  const links = new Map<string, TimelineElement[]>();
  for (const el of elements) {
    if (!el.link) continue;
    const members = links.get(el.link) ?? [];
    members.push(el); links.set(el.link, members);
  }
  for (const el of passengers) {
    if (byHost.has(keyOf(el))) continue;
    let low = 0, high = following.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (following[mid].start <= el.start) low = mid + 1;
      else high = mid;
    }
    const host = following[low - 1];
    if (host && el.start < host.start + host.duration) byHost.get(keyOf(host))!.push(el);
  }
  for (const { peer, delta: push } of pushes) {
    const passengers = [...new Set([...byHost.get(keyOf(peer))!,
      ...linkedMembersOf(peer, links.get(peer.link ?? "") ?? [peer], linkedSelection && isLinkedSelectionOn())])];
    const keys = new Set(passengers.map(keyOf));
    const bounds = heldAudioShiftRange(passengers, elements, keys);
    if (push < bounds.min || push > bounds.max || passengers.some(el => !canMoveTimelineElement(el) ||
      (el !== peer && el.track === track) || el.start + push < groupMoveFloor(el, [el]))) return null;
    for (const el of passengers) {
      const key = keyOf(el);
      const start = savedStart(el, el.start + push);
      if (moving.has(key) || (insertion.has(key) && insertion.get(key) !== start)) return null;
      insertion.set(key, start);
    }
  }
  return { start, insertion };
}
