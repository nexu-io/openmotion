import { computeStackingPatches } from './timeline-stacking.ts';
import { resolveCssStackingContextId } from '@hyperframes/core/runtime/stacking-context';
import type { ClipStacking } from './timeline-schema.ts';
import { unlinkSelectedMembers } from './element-deletion.ts';
import { furthestClipEndFromDocument, isTimelineIgnoredElement, syncContentEnd } from './content-duration.ts';
import { resolveReferencedStart, resolveReferencedDuration } from '@hyperframes/parsers/reference-resolver';
import { isUntimedRootText } from './text-tag.ts';
import { mediaAssetIdentity } from './media-asset-identity.ts';
import { planSpeedChanges } from './clip-speed.ts';
import { resolveAllTrackGaps, resolveTrackGapAt, resolveCloseGapShifts } from './timeline-gaps.ts';
import { detachAudioInSource, mergeAudioInSource, pickDetachedAudioTrack } from './media-links.ts';
import {
  findSyncPartner,
  moveIntoSyncStart,
  slipIntoSyncMediaStart,
  readLinkTiming,
  mintLinkId,
} from '@hyperframes/core/media-link';
import { parseSourceDocument, removeElementsFromHtml } from '@hyperframes/studio-server/source-mutation';
import {
  retimeClipTweensInScript,
  syncPositionHoldsBeforeKeyframes,
  type ClipTweenRetime,
} from '@hyperframes/parsers/gsap-writer-acorn';
import { walkCompositionDescendants } from '@hyperframes/parsers/hf-ids';
import { extractGsapScriptBlock } from './gsap-block.ts';
import { assertSafeElementDeletion } from './delete-dependencies.ts';
import { applyAtomicCutsToHtml } from './split.ts';
import type { TimelineCommand } from './timeline-schema.ts';
export type { TimelineCommand } from './timeline-schema.ts';

const labels = {
  moveClips: 'Move timeline clips',
  trimClips: 'Resize timeline clips',
  splitClips: 'Split timeline clips',
  deleteClips: 'Delete timeline clips',
  linkClips: 'Link clips',
  unlinkClips: 'Unlink clips',
  setClipSpeed: 'Edit speed',
  detachAudio: 'Detach audio',
  mergeAudio: 'Merge audio back into video',
  moveIntoSync: 'Move into Sync',
  slipIntoSync: 'Slip into Sync',
  setClipState: 'Change clip state',
  closeTrackGaps: 'Close track gaps',
};
export const timelineCommandLabel = (command: TimelineCommand) => labels[command.kind];

function number(value: unknown, name: string, minimum = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum)
    throw new Error('Invalid ' + name);
  return value;
}
const round = (value: number) => Math.round(value * 10000) / 10000;
function isUntimedRootClip(el: Element, root: Element | null): boolean {
  if (!root || el === root || el.hasAttribute('data-duration') || el.hasAttribute('data-end')) {
    return false;
  }
  if (el.parentElement?.closest('[data-composition-id]') !== root) return false;
  if (isTimelineIgnoredElement(el)) return false;
  const timedParent = el.parentElement?.closest('[data-start]');
  return !timedParent || timedParent === root;
}

function timing(el: Element) {
  const cache = new Map();
  const start = resolveReferencedStart(el.ownerDocument, el, cache, new Set());
  const root = el.closest('[data-composition-id]');
  const authoredDuration = resolveReferencedDuration(el.ownerDocument, el, cache, new Set());
  const implicit =
    authoredDuration == null && (isUntimedRootText(el, root) || isUntimedRootClip(el, root));
  const rootDuration =
    implicit && root
      ? (resolveReferencedDuration(el.ownerDocument, root, cache, new Set()) ??
        furthestClipEndFromDocument(el.ownerDocument))
      : null;
  const duration =
    implicit && rootDuration != null ? Math.max(0, rootDuration - start) : authoredDuration;
  return { start, duration: number(duration, 'clip duration', Number.MIN_VALUE), implicit };
}
function mediaIdentity(el: Element) {
  return mediaAssetIdentity({
    src: el.getAttribute('src') || el.querySelector('source')?.getAttribute('src'),
  });
}

function requireUnlocked(el: Element) {
  if (el.closest('[data-timeline-locked]')) throw new Error('Unlock the affected clip before editing.');
}

function openTimelineSource(source: string, command: TimelineCommand) {
  const { document, wrappedFragment } = parseSourceDocument(source);
  const all: Element[] = [];
  walkCompositionDescendants(document, (el) => {
    all.push(el);
  });
  const root = all.find((el) => el.hasAttribute('data-composition-id'));
  if (!root) throw new Error('Missing composition root.');
  const clips = all.filter(
    (el) =>
      el !== root &&
      !isTimelineIgnoredElement(el) &&
      el.parentElement?.closest('[data-composition-id]') === root,
  );
  // Untagged tracks use their index among the runtime's clip candidates, including the composition host.
  const trackByElement = new Map(
    all
      .filter((el) =>
        el.matches('[data-start], [data-track-index], [data-composition-id], video, audio, img'),
      )
      .map((el, index) => {
        const authored = Number.parseInt(
          el.getAttribute('data-track-index') ?? el.getAttribute('data-track') ?? '',
          10,
        );
        return [el, Number.isFinite(authored) ? authored : index] as const;
      }),
  );
  const byId = new Map<string, Element>();
  for (const el of clips) {
    const id = el.getAttribute('data-hf-id');
    if (!id) continue;
    if (byId.has(id)) throw new Error('Duplicate clip ID: ' + id);
    byId.set(id, el);
  }
  function target(id: string) {
    const el = byId.get(id);
    if (!el) throw new Error('Missing clip: ' + id);
    // The track header stays usable while locked: mute, visibility and the lock toggle
    // do not change the protected clip's content, position or duration.
    if (command.kind !== 'setClipState') requireUnlocked(el);
    return el;
  }
  const original = wrappedFragment ? document.body.innerHTML : document.toString();
  const serialize = () => {
    const after = wrappedFragment ? document.body.innerHTML : document.toString();
    return after === original ? source : after;
  };
  return { source, all, clips, original, root, target, trackByElement, serialize };
}

type TimelineSource = ReturnType<typeof openTimelineSource>;
type MediaCommand = Extract<TimelineCommand, { hfId: string } | { videoId: string }>;

function applyMediaCommand(ctx: TimelineSource, command: MediaCommand) {
  const { target, clips, original, serialize } = ctx;
  if (command.kind === 'setClipSpeed') {
    const self = target(command.hfId);
    const group = self.getAttribute('data-link');
    const members = new Set([command.hfId]);
    const rows = clips
      .filter((el) => el.hasAttribute('data-start') && el.hasAttribute('data-duration'))
      .map((el) => {
        const id = el.getAttribute('data-hf-id')!;
        if (command.includeLinked && group && el.getAttribute('data-link') === group) members.add(id);
        return {
          element: { id, tag: el.localName, track: ctx.trackByElement.get(el) ?? 0 },
          target: { hfId: id },
          ...timing(el),
          rate: number(Number(el.getAttribute('data-playback-rate') ?? 1), 'playback rate', Number.MIN_VALUE),
          locked: !!el.closest('[data-timeline-locked]'),
          mainCandidate:
            el.localName !== 'audio' &&
            !['text', 'caption'].includes(el.getAttribute('data-timeline-role') ?? '') &&
            !/^(?:transcript|text)-[a-f0-9-]{36}-/.test(el.id),
        };
      });
    const tracks = rows.filter((row) => row.mainCandidate).map((row) => row.element.track);
    const plan = planSpeedChanges(
      rows,
      members,
      tracks.length ? Math.max(...tracks) : null,
      command.rate,
      !!command.ripple,
      !!command.linkage,
    );
    return syncContentEnd(plan.apply(original));
  }
  if (command.kind === 'detachAudio') {
    const el = target(command.hfId);
    if (el.localName !== 'video' || el.hasAttribute('muted') || el.getAttribute('data-has-audio') === 'false')
      throw new Error('Select a video with attached audio.');
    const laneMembers = clips
      .filter((c) => c.hasAttribute('data-duration'))
      .map((c) => ({ tag: c.localName, track: ctx.trackByElement.get(c) ?? 0, ...timing(c) }));
    const result = detachAudioInSource(original, {
      target: { hfId: command.hfId },
      videoId: el.id || null,
      track: pickDetachedAudioTrack(laneMembers, timing(el)),
    });
    if (!result) throw new Error('Could not detach audio.');
    return result.html;
  }
  if (command.kind === 'mergeAudio') {
    const video = target(command.videoId),
      audio = target(command.audioId);
    const sameGroup =
      !!video.getAttribute('data-link') &&
      video.getAttribute('data-link') === audio.getAttribute('data-link');
    const videoTime = readLinkTiming(video),
      audioTime = readLinkTiming(audio);
    const aligned = (Object.keys(videoTime) as Array<keyof typeof videoTime>).every(
      (key) => Math.abs(videoTime[key] - audioTime[key]) < 0.001,
    );
    if (
      video.localName !== 'video' ||
      audio.localName !== 'audio' ||
      !video.hasAttribute('muted') ||
      !mediaIdentity(video) ||
      mediaIdentity(video) !== mediaIdentity(audio) ||
      video.hasAttribute('data-hidden') !== audio.hasAttribute('data-hidden') ||
      (!sameGroup && !aligned)
    )
      throw new Error('Select matching video and audio.');
    const merged = mergeAudioInSource(original, {
      videoTarget: { hfId: command.videoId },
      audioTarget: { hfId: command.audioId },
    });
    if (merged === null) throw new Error('Could not merge audio.');
    return merged;
  }
  const el = target(command.hfId);
  const partner = findSyncPartner(el);
  if (!partner) throw new Error('Missing sync partner.');
  const field =
    command.kind === 'moveIntoSync'
      ? 'data-start'
      : el.hasAttribute('data-playback-start')
        ? 'data-playback-start'
        : 'data-media-start';
  const compute = command.kind === 'moveIntoSync' ? moveIntoSyncStart : slipIntoSyncMediaStart;
  const value = compute(readLinkTiming(el), readLinkTiming(partner));
  if (value === null) throw new Error('Clips cannot be synchronized at their current rates and positions.');
  el.setAttribute(field, String(round(value)));
  return command.kind === 'moveIntoSync' ? syncContentEnd(serialize()) : serialize();
}

function applySelectionCommand(
  ctx: TimelineSource,
  command: Extract<TimelineCommand, { hfIds: string[] }>,
  onSkippedSelectors?: (selectors: string[]) => void,
) {
  const { source, target, clips, all, serialize } = ctx;
  if (command.hfIds.length === 0 || new Set(command.hfIds).size !== command.hfIds.length)
    throw new Error('Choose distinct clips.');
  if (command.kind === 'splitClips') {
    const cuts = command.hfIds.map((id) => {
      const el = target(id);
      if (el.localName === 'canvas') {
        throw new Error('Canvas layers cannot be split directly. Split the parent composition instead.');
      }
      const innerMedia =
        el.hasAttribute('data-start') || el.hasAttribute('data-duration')
          ? null
          : el.querySelector('video[data-start],audio[data-start]');
      const timed = innerMedia ?? el;
      const measured = command.measured?.find((row) => row.hfId === id);
      const resolved = resolveReferencedDuration(timed.ownerDocument, timed, new Map(), new Set());
      const { start, duration } =
        resolved == null && measured
          ? {
              start: number(measured.start, 'clip start'),
              duration: number(measured.duration, 'clip duration', Number.MIN_VALUE),
            }
          : timing(timed);
      const at = measured?.at ?? command.at;
      if (!Number.isFinite(at) || at <= start || at >= start + duration)
        throw new Error('Cut inside each selected clip.');
      return {
        target: { hfId: id },
        splitTime: at,
        elementStart: start,
        elementDuration: duration,
        track: timed.hasAttribute('data-track-index')
          ? Number(timed.getAttribute('data-track-index'))
          : measured?.track,
      };
    });
    const result = applyAtomicCutsToHtml(source, cuts);
    if (result.splitCount !== cuts.length) throw new Error('Could not split all selected clips.');
    onSkippedSelectors?.(result.skippedSelectors);
    return result.after;
  }
  const selected = command.hfIds.map(target);
  if (command.kind === 'setClipState') {
    const attr =
      command.state === 'locked'
        ? 'data-timeline-locked'
        : command.state === 'muted'
          ? 'muted'
          : 'data-hidden';
    for (const el of selected) {
      if (command.enabled) el.setAttribute(attr, '');
      else el.removeAttribute(attr);
    }
    return serialize();
  }
  if (command.kind === 'linkClips') {
    const isLinked = selected.some((el) => el.hasAttribute('data-link'));
    const tags = new Set(selected.map((el) => el.localName));
    if (selected.length !== 2 || !tags.has('audio') || !tags.has('video') || isLinked)
      throw new Error('Select one unlinked video and one unlinked audio clip.');
    const link = mintLinkId(
      all.flatMap((el) => [
        el.id,
        el.getAttribute('data-link') ?? '',
        el.getAttribute('data-sync-origin') ?? '',
      ]),
    );
    const src = mediaIdentity(selected[0]!);
    const sharedMedia = !!src && mediaIdentity(selected[1]!) === src;
    for (const el of selected) {
      el.setAttribute('data-link', link);
      if (sharedMedia) el.setAttribute('data-sync-origin', link);
    }
  } else {
    unlinkSelectedMembers(clips, selected);
  }
  if (command.kind === 'deleteClips') {
    const targets = command.hfIds.map((hfId) => ({ hfId }));
    assertSafeElementDeletion(source, targets);
    let after = removeElementsFromHtml(serialize(), targets);
    if (command.rippleMembers && command.rippleTrack === undefined) {
      throw new Error('Choose an authored track for ripple deletion.');
    }
    if (command.rippleTrack !== undefined) {
      const members = command.rippleMembers ? new Set(command.rippleMembers) : undefined;
      const onTrack = (el: Element) =>
        ctx.trackByElement.get(el) === command.rippleTrack &&
        (!members || members.has(el.getAttribute('data-hf-id')!));
      const removed = selected.filter(onTrack).map(timing);
      const shifts = clips
        .filter((el) => onTrack(el) && !selected.includes(el))
        .flatMap((el) => {
          const { start } = timing(el);
          const width = removed.reduce((sum, clip) => sum + (clip.start < start ? clip.duration : 0), 0);
          return width ? [{ el, start: Math.max(0, round(start - width)) }] : [];
        });
      if (shifts.length && shifts.every(({ el }) => !el.closest('[data-timeline-locked]'))) {
        after = applyTimelineCommand(after, {
          kind: 'moveClips',
          changes: shifts.map(({ el, start }) => ({ hfId: el.getAttribute('data-hf-id')!, start })),
        });
      }
    }
    return syncContentEnd(after);
  }
  return serialize();
}

function closeTrackGaps(ctx: TimelineSource, command: Extract<TimelineCommand, { kind: 'closeTrackGaps' }>) {
  const { source, clips } = ctx;
  const lane = clips
    .filter((el) => ctx.trackByElement.get(el) === command.track)
    .map((el) => ({ id: el.getAttribute('data-hf-id')!, ...timing(el) }));
  const gap = command.at === undefined ? null : resolveTrackGapAt(lane, command.at);
  const shifts =
    command.at === undefined ? resolveAllTrackGaps(lane) : gap ? resolveCloseGapShifts(lane, gap) : [];
  const changes = shifts.map((shift) => ({ hfId: shift.key, start: shift.newStart }));
  return changes.length ? applyTimelineCommand(source, { kind: 'moveClips', changes }) : source;
}

/** Timing and its associated paint order are serialized from the same document. */
function applyClipStacking(ctx: TimelineSource, stacking: ClipStacking) {
  let ranks: { hfId: string; zIndex: number; makeRelative?: boolean }[];
  if ('ranks' in stacking) {
    ranks = stacking.ranks;
  } else {
    ctx.target(stacking.hfId);
    const rows = ctx.clips.flatMap((el, domIndex) => {
      if (!el.hasAttribute('data-start') && !el.hasAttribute('data-end')) return [];
      const duration = resolveReferencedDuration(el.ownerDocument, el, new Map(), new Set());
      if (!duration) return [];
      return [
        {
          key: el.getAttribute('data-hf-id')!,
          start: timing(el).start,
          duration,
          track: Number(el.getAttribute('data-track-index') ?? ctx.trackByElement.get(el) ?? 0),
          zIndex: Number.parseInt((el as HTMLElement).style?.getPropertyValue('z-index') ?? '', 10) || 0,
          domIndex,
          isAudio: el.localName === 'audio',
          // A source-only parser has no CSS cascade. Siblings share a paint scope;
          // crossing wrappers must use the computed ranks supplied by a mounted preview.
          stackingContextId: typeof el.ownerDocument.defaultView?.getComputedStyle === 'function'
            ? resolveCssStackingContextId(el)
            : el.parentElement?.getAttribute('data-hf-id'),
        },
      ];
    });
    ranks = computeStackingPatches(rows, [stacking.hfId], stacking.direction).map((p) => ({
      hfId: p.key,
      zIndex: p.zIndex,
    }));
  }
  for (const { hfId, zIndex, makeRelative } of ranks) {
    if (!Number.isSafeInteger(zIndex)) throw new Error('Invalid layer order.');
    const el = ctx.target(hfId) as HTMLElement;
    if (el.localName === 'audio') throw new Error('Audio clips have no paint order.');
    el.style.setProperty('z-index', String(zIndex));
    if (
      makeRelative ||
      el.style.position === 'static' ||
      (makeRelative === undefined &&
        !el.style.position &&
        !el.ownerDocument.querySelector('style, link[rel~="stylesheet"]'))
    )
      el.style.setProperty('position', 'relative');
  }
}

function applyTimingCommand(ctx: TimelineSource, command: Extract<TimelineCommand, { changes: unknown }>) {
  const { source, clips, target, root, serialize } = ctx;
  if (
    (!command.changes.length && !(command.kind === 'moveClips' && command.stacking)) ||
    new Set(command.changes.map((c) => c.hfId)).size !== command.changes.length
  )
    throw new Error('Choose distinct clips.');
  if (command.includeLinked) {
    const changes = [...command.changes];
    const seen = new Set(changes.map((change) => change.hfId));
    for (const change of command.changes) {
      const el = target(change.hfId);
      const group = el.getAttribute('data-link');
      if (!group) continue;
      const base = timing(el);
      for (const partner of clips.filter((c) => c.getAttribute('data-link') === group)) {
        const id = partner.getAttribute('data-hf-id');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const old = timing(partner);
        const start = old.start + change.start - base.start;
        changes.push(
          'duration' in change
            ? { hfId: id, start, duration: old.duration + change.duration - base.duration }
            : { hfId: id, start },
        );
      }
    }
    if (command.kind === 'trimClips')
      return applyTimelineCommand(source, {
        kind: 'trimClips',
        changes: changes.filter((change) => 'duration' in change),
      });
    return applyTimelineCommand(source, { kind: 'moveClips', changes, stacking: command.stacking });
  }
  const retimes: ClipTweenRetime[] = [];
  let maxEnd = 0;
  for (const change of command.changes) {
    const el = target(change.hfId);
    const old = timing(el);
    const start = number(change.start, 'clip start');
    const delta = start - old.start;
    const duration =
      'duration' in change ? number(change.duration, 'duration', Number.MIN_VALUE) : old.duration;
    const targetSelector = el.id ? '#' + el.id : '[data-hf-id=' + JSON.stringify(change.hfId) + ']';
    if (delta || old.implicit) el.setAttribute('data-start', String(start));
    if (old.implicit) el.setAttribute('data-duration', String(duration));
    if ('duration' in change) {
      if (duration !== old.duration) el.setAttribute('data-duration', String(duration));
      const attr =
        el.hasAttribute('data-playback-start') || el.hasAttribute('data-composition-src')
          ? 'data-playback-start'
          : 'data-media-start';
      if (
        ['audio', 'video'].includes(el.localName) ||
        el.hasAttribute(attr) ||
        el.hasAttribute('data-composition-src')
      ) {
        const rate = number(
          Number(el.getAttribute('data-playback-rate') ?? 1),
          'playback rate',
          Number.MIN_VALUE,
        );
        const offset = change.playbackStart ?? Math.max(0, Number(el.getAttribute(attr) ?? 0) + delta * rate);
        if (delta || change.playbackStart !== undefined)
          el.setAttribute(attr, String(round(number(offset, 'media offset'))));
      }
      if (delta || duration !== old.duration)
        retimes.push({
          kind: 'scale',
          targetSelector,
          oldStart: old.start,
          oldDuration: old.duration,
          newStart: start,
          newDuration: duration,
        });
    } else {
      if (change.track !== undefined) {
        if (!Number.isSafeInteger(change.track)) throw new Error('Invalid track index.');
        el.setAttribute('data-track-index', String(change.track));
      }
      if (change.clearAudioGroup) el.removeAttribute('data-audio-group');
      if (delta) retimes.push({ kind: 'shift', targetSelector, delta });
    }
    if (el.hasAttribute('data-end') && (delta || old.duration !== duration))
      el.setAttribute('data-end', String(round(start + duration)));
    maxEnd = Math.max(maxEnd, start + duration);
  }
  if (command.kind === 'moveClips' && command.stacking) applyClipStacking(ctx, command.stacking);
  if (maxEnd > Number(root.getAttribute('data-duration')))
    root.setAttribute('data-duration', String(round(maxEnd)));
  const edited = serialize();
  const after = command.kind === 'trimClips' && edited !== source ? syncContentEnd(edited) : edited;
  if (!retimes.length || !/<script\b/i.test(source)) return after;
  const block = extractGsapScriptBlock(after);
  if (!block) return after;
  const shifted = retimeClipTweensInScript(block.scriptText, retimes, block.root).script;
  const script = syncPositionHoldsBeforeKeyframes(shifted, block.scriptText);
  if (script === block.scriptText) return after;
  return block.replaceScript(script);
}

export function applyTimelineCommand(
  source: string,
  command: TimelineCommand,
  onSkippedSelectors?: (selectors: string[]) => void,
): string {
  const ctx = openTimelineSource(source, command);
  if ('hfIds' in command) return applySelectionCommand(ctx, command, onSkippedSelectors);
  if ('changes' in command) return applyTimingCommand(ctx, command);
  if (command.kind === 'closeTrackGaps') return closeTrackGaps(ctx, command);
  return applyMediaCommand(ctx, command);
}
