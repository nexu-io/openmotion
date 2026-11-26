import { parseAuthoredTimeline } from "./authoredTimeline";
import type { RestoreFiles } from "../../utils/gsapUndoRestore";
import { displayAuthoredTimelineLanes } from "../components/timelineZones";
import { usePlayerStore, type TimelineElement } from "../store/playerStore";
import { getTimelineElementIdentity } from "./timelineDOM";
import { savedClipEdges } from "../store/timelineElement";

const IDENTITY_FIELDS = new Set(["id", "key", "hfId", "selector", "selectorIndex", "sourceFile", "track", "authoredTrack"]);

function changedFields(current: TimelineElement, before: TimelineElement, after: TimelineElement, guard: boolean): TimelineElement {
  let next = current;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof TimelineElement>) {
    if (IDENTITY_FIELDS.has(key) || JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    if (guard && JSON.stringify(current[key]) !== JSON.stringify(before[key]) &&
        !(key === "start" && savedClipEdges(current, current.start).start === before.start)) continue;
    if (next === current) next = { ...current };
    Object.assign(next, { [key]: after[key] });
  }
  if (before.track !== after.track && (!guard || (current.authoredTrack ?? current.track) === before.track)) next = { ...next, authoredTrack: after.track };
  return next;
}

type HistoryGuard = false | "fields" | "predict";

/** Confirmed file history is the timeline's truth, even when a structural edit
 * needs a new preview. Apply only the source delta; preserve runtime metadata,
 * dynamically generated clips and clips owned by other files until rediscovery. */
export function syncHistoryTimelineFromFiles(activePath: string | null, files: RestoreFiles | undefined, guard: HistoryGuard = false, removedRows?: TimelineElement[]): boolean {
  const path = activePath ?? "index.html";
  const file = files?.[path];
  if (!file) return false;
  const state = usePlayerStore.getState();
  const before = parseAuthoredTimeline(file.previous, path, state.timelineProjectId, state.duration);
  const after = parseAuthoredTimeline(file.restored, path, state.timelineProjectId, state.duration);
  if (!before || !after) return false;
  const structural = before.byKey.size !== after.byKey.size || before.elements.some(row => !after.byKey.has(getTimelineElementIdentity(row)));
  // Extending a split's left half alone would overlap the right half. Verify the
  // complete structural transition before publishing any fields or display lanes.
  if (guard && structural && (guard === "fields" || !matchesStructuralBase(before, after, state.elements, state.duration))) return false;
  // A refused projection can restore the removed runtime row with its metadata.
  for (const row of removedRows ?? []) {
    const key = getTimelineElementIdentity(row);
    if (!before.byKey.has(key) && after.byKey.has(key)) after.byKey.set(key, row);
  }
  return applyAuthoredTimeline(before, after, false, !!guard);
}

type AuthoredTimeline = NonNullable<ReturnType<typeof parseAuthoredTimeline>>;

// These values can change through timeline gestures. Runtime labels, resolved URLs,
// source lengths and computed text styling can legitimately differ from the file.
function matchesAuthoredRow(row: TimelineElement, previous: TimelineElement) {
  return !!row.sourceFile && !!(previous.domId || previous.hfId) && row.domId === previous.domId &&
    row.hfId === previous.hfId && row.tag === previous.tag && row.start === previous.start && row.duration === previous.duration &&
    (row.authoredTrack ?? row.track) === (previous.authoredTrack ?? previous.track) &&
    (!row.text || row.text.value === previous.text?.value) && !!row.hidden === !!previous.hidden &&
    !!row.timelineLocked === !!previous.timelineLocked && !!row.muted === !!previous.muted &&
    (row.playbackStart ?? 0) === (previous.playbackStart ?? 0) && (row.playbackRate ?? 1) === (previous.playbackRate ?? 1) &&
    (row.volume ?? 1) === (previous.volume ?? 1) &&
    row.fxChain === previous.fxChain && row.automation === previous.automation &&
    (row.fadeIn ?? 0) === (previous.fadeIn ?? 0) && (row.fadeOut ?? 0) === (previous.fadeOut ?? 0);
}

function matchesStructuralBase(before: AuthoredTimeline, after: AuthoredTimeline, rows: TimelineElement[], duration: number) {
  if (before.duration !== after.duration && duration !== before.duration) return false;
  const current = new Map(rows.map(row => [getTimelineElementIdentity(row), row]));
  if (current.size !== rows.length) return false;
  for (const [key, row] of after.byKey) {
    if (!before.byKey.has(key) && (current.has(key) || !(row.domId || row.hfId))) return false;
  }
  for (const [key, previous] of before.byKey) {
    const restored = after.byKey.get(key);
    if (restored && JSON.stringify(previous) === JSON.stringify(restored)) continue;
    const row = current.get(key);
    if (!row || !matchesAuthoredRow(row, previous)) return false;
    if (restored && JSON.stringify(changedFields(row, previous, restored, true)) !==
        JSON.stringify(changedFields(row, previous, restored, false))) return false;
  }
  return true;
}

function applySourceTiming(element: TimelineElement, source: TimelineElement): TimelineElement {
  if (element.start === source.start && element.duration === source.duration &&
      (element.authoredTrack ?? element.track) === source.track && element.playbackStart === source.playbackStart) {
    return element;
  }
  return { ...element, start: source.start, duration: source.duration,
    playbackStart: source.playbackStart, authoredTrack: source.track };
}

/** Only remove rows owned by the previous authored source. The runtime may
 * also have discovered rows generated by scripts or owned by another file. */
export function applyAuthoredTimeline(before: AuthoredTimeline | null, after: AuthoredTimeline, refreshTiming = false, guard = false): boolean {
  const state = usePlayerStore.getState();
  let changed = false;
  const existing = new Set(state.elements.map(getTimelineElementIdentity));
  const elements = state.elements.flatMap(element => {
    const key = getTimelineElementIdentity(element);
    const previous = before?.byKey.get(key);
    const restored = after.byKey.get(key);
    if (!restored) {
      if (!previous) return [element];
      changed = true;
      return [];
    }
    const patched = previous ? changedFields(element, previous, restored, guard) : element;
    const timed = refreshTiming ? applySourceTiming(patched, restored) : patched;
    // A peer may restamp an unversioned clip after undo. Its stable source + DOM
    // key still addresses the same row, but the next edit needs the new hf-id.
    const identityChanged = refreshTiming || previous?.hfId !== restored.hfId || Boolean(timed.hfId);
    const next = !guard && identityChanged && restored.hfId && timed.hfId !== restored.hfId &&
      timed.domId && timed.domId === restored.domId && timed.tag === restored.tag
      ? {...timed, hfId: restored.hfId} : timed;
    changed ||= next !== element;
    return [next];
  });
  for (const [key, element] of after.byKey) {
    if (!existing.has(key) && (!before?.byKey.has(key) || !guard && (refreshTiming || !state.elements.length))) { elements.push(element); changed = true; }
  }
  const durationChanged = (!guard || state.duration === before?.duration) && (refreshTiming || before?.duration !== after.duration) && after.duration !== state.duration;
  if (changed || durationChanged || !state.timelineSourceProjected) usePlayerStore.setState({
    timelineSourceProjected: true,
    ...(changed ? { elements: displayAuthoredTimelineLanes(elements) } : {}),
    ...(durationChanged ? { duration: after.duration } : {}),
  });
  return changed || durationChanged;
}
