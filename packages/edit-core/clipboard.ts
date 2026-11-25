import { buildTimelineAssetId } from '@hyperframes/core/timeline-asset-id';
import { parseHTMLContent } from '@hyperframes/core/compiler/html-document';
import {
  EXCLUDED_TAGS,
  ensureHfIds,
  mintHfId,
  walkCompositionDescendants,
} from '@hyperframes/parsers/hf-ids';
import { deduplicateIds, insertAsSibling, type TimelineClipboardClip } from './clipboard-payload.ts';
import { carryLook, renamedIds } from './clipboard-look.ts';
import { timedTextPaste, openPastedTextTrack, type PlacementPeer } from './text-paste.ts';
import { collectHtmlIds, insertTimelineAssetIntoSource } from './asset-placement.ts';
import { timelineSpansOverlap } from './time-bounds.ts';
export interface PlacedClip {
  track: number;
  start: number;
  duration: number;
}

function tracksOverlap(a: PlacedClip, b: PlacedClip): boolean {
  return (
    a.track === b.track && timelineSpansOverlap(a.start, a.start + a.duration, b.start, b.start + b.duration)
  );
}

/** CapCut: keeps the preferred track if free at the new time, else the next
 *  unused track index. Exported so placement is tested with values directly. */
export function resolveFreeTrack(preferred: PlacedClip, taken: readonly PlacedClip[]): number {
  if (!taken.some((t) => tracksOverlap(preferred, t))) return preferred.track;
  const maxTrack = taken.reduce((max, t) => Math.max(max, t.track), preferred.track);
  return maxTrack + 1;
}

/** Gives a clone's root and every descendant a fresh data-hf-id, clear of `taken`. Minted here,
 *  inside the edit, or the server stamps them on the next preview load, behind undo's back.
 *  DOMParser, not a regex, so a `>` inside an attribute value can't defeat it. */
function remintHfIds(html: string, parser: typeof parseHTMLContent, taken: Set<string>): string {
  const root = parser(html).body.firstElementChild;
  if (!root || ['title', 'meta', 'base', 'link', 'style'].includes(root.localName)) {
    // A tag the HTML parser hoists out of <body> (title/meta/style/base/link)
    // never reaches the walk above — fall back to a direct strip so
    // data-hf-id still can't survive, even though no real clip root is one
    // of these tags today.
    return html.replace(/\sdata-hf-id=("[^"]*"|'[^']*')/g, '');
  }
  const elements = [root];
  walkCompositionDescendants(root, (el) => elements.push(el));
  for (const el of elements) {
    if (EXCLUDED_TAGS.has(el.tagName.toLowerCase())) el.removeAttribute('data-hf-id');
    else el.setAttribute('data-hf-id', mintHfId(el, taken));
  }
  return root.outerHTML;
}

const HF_ID_ATTR_RE = /\bdata-hf-id\s*=\s*["']?([^"'\s>]+)/gi;
const hfIdsInFile = (content: string) =>
  new Set(Array.from(content.matchAll(HF_ID_ATTR_RE), (match) => match[1]));

export function pasteElementHtml(
  content: string,
  payload: { html: string; originSelector?: string; originSelectorIndex?: number },
  fromThisFile = false,
  onInserted?: (hfId: string) => void,
  playhead = 0,
  liveElements: readonly PlacementPeer[] = [],
): string {
  const html = timedTextPaste(
    payload.html,
    content,
    playhead,
    payload.originSelector,
    payload.originSelectorIndex,
  );
  const reminted = remintHfIds(html, parseHTMLContent, hfIdsInFile(ensureHfIds(content)));
  const deduped = deduplicateIds(reminted, collectHtmlIds(content));
  const opened = openPastedTextTrack(content, deduped, liveElements);
  const pastedRoot = parseHTMLContent(deduped).body.firstElementChild;
  const hfId = pastedRoot?.getAttribute('data-hf-id');
  if (hfId) onInserted?.(hfId);
  const result = insertAsSibling(
    opened.source,
    opened.html,
    payload.originSelector,
    payload.originSelectorIndex,
  );
  return fromThisFile ? carryLook(result, renamedIds(reminted, deduped), 0) : result;
}

/** Shared insertion path for paste and duplicate, anchored at the playhead or the selection's end. Returns the
 *  final ids so the caller can select what it placed, and the furthest end any clip lands at so it can grow the
 *  root duration to cover it. `fromThisFile`: the clips came from `content`, so a renamed copy takes its
 *  original's look. */
export function pasteTimelineClips(
  content: string,
  clips: readonly TimelineClipboardClip[],
  anchorTime: number,
  liveElements: readonly PlacementPeer[],
  fromThisFile = false,
): { content: string; ids: string[]; requiredEnd: number } {
  const groupMinStart = Math.min(...clips.map((c) => c.start));
  let existingIds = collectHtmlIds(content);
  const taken: PlacedClip[] = liveElements.map((el) => ({
    track: el.authoredTrack ?? el.track,
    start: el.start,
    duration: el.duration,
  }));
  const ids: string[] = [];
  let result = content;
  let requiredEnd = 0;
  const domParser = parseHTMLContent;
  const takenHfIds = hfIdsInFile(ensureHfIds(content));
  for (const clip of clips) {
    const reminted = remintHfIds(clip.html, domParser, takenHfIds);
    const deduped = deduplicateIds(reminted, existingIds);
    existingIds = existingIds.concat(collectHtmlIds(deduped));
    const newStart = anchorTime + (clip.start - groupMinStart);
    const newTrack = resolveFreeTrack({ track: clip.track, start: newStart, duration: clip.duration }, taken);
    taken.push({ track: newTrack, start: newStart, duration: clip.duration });
    requiredEnd = Math.max(requiredEnd, newStart + clip.duration);

    // DOM-only root text may have no authored window yet. Materialize all
    // three attributes instead of replacing only attributes that already exist.
    const copy = domParser(deduped).body.firstElementChild;
    if (!copy || copy.localName === 'title' || EXCLUDED_TAGS.has(copy.localName)) {
      throw new Error('Cannot paste this item as a timeline clip.');
    }
    // A split keeps the left half's original identity, which may be only an hf-id.
    // Studio selects the inserted row by DOM id across timeline/preview refreshes.
    if (!copy.id) {
      copy.id = buildTimelineAssetId(copy.getAttribute('data-hf-id') || 'clip', existingIds);
      existingIds.push(copy.id);
    }
    copy.classList.add('clip');
    copy.setAttribute('data-start', String(Math.round(newStart * 100) / 100));
    copy.setAttribute('data-duration', String(Math.round(clip.duration * 100) / 100));
    copy.setAttribute('data-track-index', String(newTrack));
    const opened =
      clips.length === 1
        ? openPastedTextTrack(result, copy.outerHTML, liveElements)
        : { source: result, html: copy.outerHTML };
    result = opened.source;
    const withPatched = opened.html;
    result = insertTimelineAssetIntoSource(result, withPatched);
    if (fromThisFile) {
      const rawStart = domParser(reminted).body.firstElementChild?.getAttribute('data-start');
      const authored = rawStart == null ? NaN : Number(rawStart);
      const authoredStart = Number.isFinite(authored) ? authored : clip.start;
      result = carryLook(result, renamedIds(reminted, deduped), newStart - authoredStart);
    }

    ids.push(copy.id);
  }
  return { content: result, ids, requiredEnd };
}

/** Reconstruct occupied authored lanes when the caller has no live player. */
export function savedClipboardPeers(source: string): PlacementPeer[] {
  const document = parseHTMLContent(source);
  const peers: PlacementPeer[] = [];
  walkCompositionDescendants(document, (node) => {
    if (!node.hasAttribute('data-start') || !node.parentElement?.closest('[data-composition-id]')) return;
    const start = Number(node.getAttribute('data-start')),
      duration = Number(node.getAttribute('data-duration'));
    const track = Number(node.getAttribute('data-track-index'));
    if (Number.isFinite(start) && duration > 0 && Number.isFinite(track)) {
      peers.push({ track, start, duration, zIndex: Number((node as HTMLElement).style.zIndex) || 0 });
    }
  });
  return peers;
}
