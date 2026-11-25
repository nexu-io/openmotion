import type { parseDocument as parseMarkup } from 'htmlparser2';
import type * as HtmlParser from '@hyperframes/parsers/html-attribute-spans';
import { placeTranscriptSegments, timedSegment, parseTranscriptSubtitles, type TranscriptDocument, type TranscriptPlacement, type TranscriptSegment } from '../../shared/transcript.ts';
import { captionArtwork, captionSettings, type CaptionSettings } from '../../shared/caption-style.ts';

export type CaptionPlacement = TranscriptPlacement;
export type CaptionTrack = { id: string; kind: 'text' | 'caption'; track: number; label: string; cueCount: number; settings: CaptionSettings; locked: boolean };
export type CaptionSourceCommand = 'caption_add' | 'caption_update' | 'caption_toggle';
export interface CaptionSourceOptions {
  segments?: TranscriptSegment[];
  subtitles?: string;
  timelineStart?: number;
  textKind?: 'text' | 'caption';
  captionSettings?: Partial<CaptionSettings>;
  visible?: boolean;
  remove?: boolean;
}

export function createCaptionSourceOperations({ decodeAuthoredAttribute, scanHtmlOpeningTags }: typeof HtmlParser, parseDocument: typeof parseMarkup) {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const number = (value: number) => String(Math.round(value * 1000) / 1000);
  type Tag = ReturnType<typeof scanHtmlOpeningTags>[number];
  const value = (tag: Tag, name: string) => { const attr = tag.attributes.find(a => a.name === name); return attr?.kind === 'value' ? decodeAuthoredAttribute(attr.value) : undefined; };
  const trackId = (tag: Tag) => value(tag, 'data-caption-track') ?? value(tag, 'id')?.match(/^(?:transcript|text)-([a-f0-9-]{36})-/)?.[1];
  const trackKind = (tag: Tag) => value(tag, 'data-timeline-role') === 'text' || value(tag, 'id')?.startsWith('text-') ? 'text' : 'caption';
  const styleText = (style: Record<string, string>) => Object.entries(style).map(([key, value]) => `${key}:${value}`).join(';');
  const baseSize = (tags: Tag[]) => { const root = tags.find(tag => value(tag, 'data-composition-id')); return Math.round(Math.min((Number(root && value(root, 'data-width')) || 1920) * 0.055, (Number(root && value(root, 'data-height')) || 1080) * 0.045)); };
  function compositionScope(html: string) {
    const document = parseDocument(html, { withStartIndices: true, withEndIndices: true });
    type Node = (typeof document.children)[number];
    const owned = new Set<number>();
    const markers = new Map<string, number[]>();
    let found = false;
    function visit(node: Node, inside: boolean) {
      const at = node.startIndex;
      if (inside && node.type === 'comment' && at != null) {
        const marker = html.slice(at, (node.endIndex ?? at) + 1);
        if (marker.startsWith('<!-- openmotion-transcript:')) markers.set(marker, [...(markers.get(marker) ?? []), at]);
      }
      if (node.type !== 'tag') return;
      if (['head', 'svg', 'math'].includes(node.name)) return;
      const composition = Object.hasOwn(node.attribs, 'data-composition-id');
      if (composition && !inside) {
        if (found) return;
        if (!node.attribs['data-composition-id']?.trim() || Object.hasOwn(node.attribs, 'data-composition-src') ||
            !['div', 'main', 'section', 'article'].includes(node.name)) throw new Error('Choose a native HTML composition container');
        const end = node.endIndex;
        const close = end == null ? '' : html.slice(html.lastIndexOf('</', end), end + 1);
        if (end == null || end >= html.length || !new RegExp(`^</${node.name}\\s*>$`, 'i').test(close)) {
          throw new Error('Choose a native HTML composition with a closing tag');
        }
        found = true;
      }
      if ((inside || composition) && at != null) owned.add(at);
      // A child host is a layer in the parent; its tracks and markers belong to the child.
      if (composition && inside) return;
      for (const child of node.children) visit(child, inside || composition);
    }
    for (const node of document.children) visit(node, false);
    return { tags: scanHtmlOpeningTags(html).filter(tag => owned.has(tag.start)), markers };
  }
  function captionBlock(scope: ReturnType<typeof compositionScope>, id: string) {
    const begin = `<!-- openmotion-transcript:${id}:start -->`, end = `<!-- openmotion-transcript:${id}:end -->`;
    const starts = scope.markers.get(begin) ?? [], ends = scope.markers.get(end) ?? [];
    if (!starts.length && !ends.length) return null;
    const start = starts[0]!, last = ends[0]!;
    if (starts.length !== 1 || ends.length !== 1 || start >= last ||
        scope.tags.some(tag => tag.start > start && tag.start < last && value(tag, 'data-composition-id') !== undefined)) {
      throw new Error('Caption markers changed; restore the caption layer before replacing it');
    }
    return { start, end: last + end.length };
  }
  function settingsFor(tag: Tag): CaptionSettings {
    const text = trackKind(tag) === 'text';
    return captionSettings({ preset: (value(tag, 'data-caption-preset') || (text ? 'clean' : 'bar')) as CaptionSettings['preset'], position: (value(tag, 'data-caption-position') || (text ? 'center' : 'bottom')) as CaptionSettings['position'], scale: Number(value(tag, 'data-caption-scale') || 1), pacing: (value(tag, 'data-caption-pacing') || 'sentence') as CaptionSettings['pacing'], visible: !tag.attributes.some(a => a.name === 'data-hidden') });
  }
  function settingsAttributes(settings: CaptionSettings) { return `data-caption-preset="${settings.preset}" data-caption-position="${settings.position}" data-caption-scale="${settings.scale}" data-caption-pacing="${settings.pacing}"${settings.visible ? '' : ' data-hidden'}`; }
  function captionTracks(html: string, tags = compositionScope(html).tags): CaptionTrack[] {
    const found = new Map<string, CaptionTrack>();
    for (const tag of tags) {
      const id = trackId(tag); if (!id) continue;
      const empty = value(tag, 'data-timeline-role') === 'caption-empty';
      const previous = found.get(id), settings = settingsFor(tag), locked = tag.attributes.some(a => a.name === 'data-timeline-locked');
      if (previous) { previous.cueCount += empty ? 0 : 1; previous.settings.visible ||= settings.visible; previous.locked ||= locked; }
      else found.set(id, { id, kind: trackKind(tag), track: Number(value(tag, 'data-track-index') || 0), label: value(tag, 'data-caption-label') || (trackKind(tag) === 'text' ? 'Text' : 'Captions'), cueCount: empty ? 0 : 1, settings, locked });
    }
    return [...found.values()].sort((a, b) => a.track - b.track);
  }

  /** Change appearance in place: preserve authored cue timing, text, IDs and track keys. */
  function updateCaptionTrackSource(html: string, id: string, patch: Partial<CaptionSettings>, remove = false) {
    const scope = compositionScope(html), tags = scope.tags, selected = tags.filter(tag => trackId(tag) === id);
    if (!selected.length) throw new Error('Caption track no longer exists');
    if (selected.some(tag => tag.attributes.some(a => a.name === 'data-timeline-locked'))) throw new Error('Unlock the caption track before changing it');
    if (remove) {
      const block = captionBlock(scope, id);
      if (!block || selected.some(tag => tag.start < block.start || tag.end > block.end)) throw new Error('Caption markers changed; remove individual clips in the timeline');
      return { content: html.slice(0, block.start) + html.slice(block.end), count: selected.length };
    }
    for (const tag of [...selected].reverse()) {
      const previous = settingsFor(tag), settings = captionSettings({ ...previous, ...patch });
      if (settings.pacing !== previous.pacing) throw new Error('Regenerate captions from the transcript to change pacing');
      let opening = html.slice(tag.start, tag.end);
      const properties = Object.fromEntries((value(tag, 'style') || '').split(';').filter(Boolean).map(entry => { const i = entry.indexOf(':'); return [entry.slice(0, i).trim(), entry.slice(i + 1).trim()]; }));
      if (patch.preset !== undefined || patch.scale !== undefined || patch.position !== undefined) Object.assign(properties, captionArtwork(settings, baseSize(tags)));
      const names = new Set(['style', 'data-caption-preset', 'data-caption-position', 'data-caption-scale', 'data-caption-pacing', 'data-hidden']);
      for (const attr of [...tag.attributes].reverse()) if (names.has(attr.name)) opening = opening.slice(0, attr.start - tag.start) + opening.slice(attr.end - tag.start);
      opening = opening.replace(/\s*>$/, ` style="${escape(styleText(properties))}" ${settingsAttributes(settings)}>`);
      html = html.slice(0, tag.start) + opening + html.slice(tag.end);
    }
    return { content: html, count: selected.length };
  }

  /** Original native caption authoring. Visual values describe video artwork, never application UI. */
  function transcriptCaptionSource(html: string, doc: TranscriptDocument, placement: CaptionPlacement, options?: Partial<CaptionSettings>) {
    const mapped = placeTranscriptSegments(doc, placement);
    return timedTextSource(html, doc.id, (doc.language && doc.language !== 'auto' ? doc.language : undefined) || doc.source.path.split('/').pop() || 'Captions', mapped, options);
  }

  /** Manual text and imported subtitles are timeline-native; no media or ASR is required. */
  function manualCaptionSource(html: string, id: string, input: { segments?: TranscriptSegment[]; subtitles?: string; timelineStart?: number; textKind?: 'text' | 'caption'; captionSettings?: Partial<CaptionSettings> }) {
    if (Boolean(input.segments) === (typeof input.subtitles === 'string')) throw new Error('Supply either segments or SRT/VTT subtitles');
    const offset = input.timelineStart ?? 0;
    const segments = input.segments ?? parseTranscriptSubtitles(input.subtitles!);
    if (!Number.isFinite(offset) || offset < 0 || !segments.length) throw new Error('Supply valid text and timing');
    const ids = new Set<string>();
    for (const segment of segments) {
      if (!/^[\w-]{1,100}$/.test(segment.id) || ids.has(segment.id) || !segment.text.trim() || !timedSegment(segment) || segment.start < 0 || segment.end <= segment.start || segment.end + offset > 86400) throw new Error('Supply valid, uniquely identified text cues and timing');
      ids.add(segment.id);
    }
    const kind = input.textKind || 'caption';
    if (kind !== 'text' && kind !== 'caption') throw new Error('Choose text or caption');
    return timedTextSource(html, id, kind === 'text' ? 'Text' : 'Captions', segments.map(segment => ({ ...segment, start: segment.start! + offset, end: segment.end! + offset, words: undefined })), { ...(kind === 'text' ? { preset: 'clean' as const, position: 'center' as const } : {}), ...input.captionSettings, pacing: 'sentence' }, kind);
  }

  function timedTextSource(html: string, id: string, label: string, mapped: TranscriptSegment[], options?: Partial<CaptionSettings>, kind: 'text' | 'caption' = 'caption') {
    const doc = { id };
    const scope = compositionScope(html);
    const existing = captionTracks(html, scope.tags);
    const previous = existing.find(track => track.id === doc.id) ?? (kind === 'caption' ? existing.find(track => track.kind === 'caption' && track.cueCount === 0 && !track.locked) : undefined);
    if (previous?.locked) throw new Error('Unlock the caption track before changing it');
    const settings = captionSettings({ ...previous?.settings, ...options });
    const begin = `<!-- openmotion-transcript:${doc.id}:start -->`, end = `<!-- openmotion-transcript:${doc.id}:end -->`;
    const blockToReplace = captionBlock(scope, previous?.id ?? doc.id);
    if (previous && !blockToReplace) throw new Error('Caption markers changed; restore the caption layer before replacing it');
    if (blockToReplace) html = html.slice(0, blockToReplace.start) + html.slice(blockToReplace.end);
    // Overlay tracks sit above existing video and audio. Appending below video
    // would make a title the magnetic main track in the editor's lane topology.
    if (!previous) {
      for (const tag of [...(blockToReplace ? compositionScope(html).tags : scope.tags)].reverse()) {
        const trackAttr = tag.attributes.find(attr => attr.name === 'data-track-index');
        const isClip = (value(tag, 'class') || '').split(/\s+/).includes('clip');
        if (!trackAttr && !isClip) continue;
        if (tag.attributes.some(attr => attr.name === 'data-timeline-locked')) throw new Error('Unlock tracks before adding a new text or caption track');
        if (trackAttr?.kind === 'value') {
          const next = Number(decodeAuthoredAttribute(trackAttr.value)) + 1;
          if (!Number.isFinite(next)) throw new Error('Invalid authored track index');
          html = html.slice(0, trackAttr.valueStart) + number(next) + html.slice(trackAttr.valueEnd);
        } else if (!trackAttr) {
          const insert = html[tag.end - 2] === '/' ? tag.end - 2 : tag.end - 1;
          html = html.slice(0, insert) + ' data-track-index="1"' + html.slice(insert);
        } else throw new Error('Invalid authored track index');
      }
    }
    const tags = compositionScope(html).tags, root = tags[0];
    if (!root || !root.closed) throw new Error('Choose a native HTML composition container');
    const attr = (name: string) => root.attributes.find(attr => attr.name === name);
    const duration = attr('data-duration');
    if (!duration || duration.kind !== 'value' || !Number.isFinite(Number(duration.value))) throw new Error('Composition requires an explicit duration');
    const track = previous?.track ?? 0;
    const overlayZ = Math.max(99, ...tags.map(tag => Number(value(tag, 'style')?.match(/(?:^|;)\s*z-index\s*:\s*(-?\d+)/)?.[1]) || 0)) + 1;
    const width = attr('data-width'), height = attr('data-height');
    const h = height?.kind === 'value' && Number(height.value) > 0 ? Number(height.value) : 1080;
    const w = width?.kind === 'value' && Number(width.value) > 0 ? Number(width.value) : 1920;
    const fontSize = Math.round(Math.min(w * 0.055, h * 0.045));
    let count = 0, requiredEnd = Number(duration.value);
    const styled = mapped.filter(timedSegment).flatMap(segment => {
      if (settings.pacing === 'sentence') return [{ ...segment, html: escape(segment.text) }];
      if (!segment.words?.length) throw new Error('Word highlighting requires real word timestamps');
      const words = segment.words;
      if (words.some((word, i) => i > 0 && word.start < words[i - 1].end)) throw new Error('Word highlighting requires ordered, non-overlapping word timestamps');
      // Keep the exact transcript punctuation and spaces; do not rebuild it from tokens.
      let cursor = 0;
      const spans = words.map(word => { const start = segment.text.indexOf(word.text.trim(), cursor); if (start < 0) throw new Error('Word timestamps do not match the edited text'); const end = start + word.text.trim().length; cursor = end; return { start, end }; });
      return words.map((word, i) => ({ ...segment, id: `${segment.id}-word-${i}`, start: i === 0 ? segment.start : word.start, end: words[i + 1]?.start ?? segment.end,
        html: escape(segment.text.slice(0, spans[i].start)) + `<span style="color:var(--caption-highlight)">${escape(segment.text.slice(spans[i].start, spans[i].end))}</span>` + escape(segment.text.slice(spans[i].end)) }));
    });
    // Round both edges, not start and length: adjacent cues must still meet after rounding.
    const edge = (value: number) => Math.round(value * 1000) / 1000;
    const cues = styled.map(segment => ({ ...segment, start: edge(segment.start), end: edge(segment.end) })).filter(segment => segment.end > segment.start).map(segment => {
      const start = segment.start, length = segment.end - segment.start;
      requiredEnd = Math.max(requiredEnd, segment.end); count++;
      return `<div id="${kind === 'text' ? 'text' : 'transcript'}-${doc.id}-${segment.id}" data-hf-id="${kind === 'text' ? 'txt' : 'tr'}-${doc.id}-${segment.id}" class="clip" data-label="${escape(segment.text.slice(0, 200))}" data-timeline-role="${kind}" data-caption-track="${doc.id}" data-caption-label="${escape(label)}" ${settingsAttributes(settings)} data-start="${number(start)}" data-duration="${number(length)}" data-track-index="${track}" style="position:absolute;box-sizing:border-box;z-index:${overlayZ};${styleText(captionArtwork(settings, fontSize))}">${segment.html}</div>`;
    });
    if (!count) throw new Error('No transcript cues overlap this source range');
    const block = `\n${begin}\n${cues.join('\n')}\n${end}\n`;
    // Work from right to left to preserve the scanner's original source offsets.
    html = html.slice(0, root.end) + block + html.slice(root.end);
    html = html.slice(0, duration.valueStart) + number(requiredEnd) + html.slice(duration.valueEnd);
    return { content: html, count };
  }
  /** An invisible native row marker reserves a real editable lane without inventing a subtitle cue. */
  function toggleCaptionSource(html: string, id: string, visible: boolean) {
    const tracks = captionTracks(html).filter(track => track.kind === 'caption');
    if (tracks.some(track => track.locked && track.settings.visible !== visible)) throw new Error('Unlock the caption track before changing it');
    if (!tracks.length && visible) {
      const created = timedTextSource(html, id, 'Captions', [{ id: 'empty', text: '', start: 0, end: 0.01 }], { visible });
      const marker = compositionScope(created.content).tags.find(tag => value(tag, 'id') === `transcript-${id}-empty`)!;
      const overlayZ = value(marker, 'style')?.match(/z-index:(\d+)/)?.[1];
      const opening = created.content.slice(marker.start, marker.end).replace('data-timeline-role="caption"', 'data-timeline-role="caption-empty"').replace('data-label=""', 'data-label="Captions"').replace(/style="[^"]*"/, `style="position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;clip-path:inset(100%);z-index:${overlayZ}"`);
      return { content: created.content.slice(0, marker.start) + opening + created.content.slice(marker.end), count: 0, trackId: id };
    }
    for (const track of tracks) if (track.settings.visible !== visible) html = updateCaptionTrackSource(html, track.id, { visible }).content;
    return { content: html, count: tracks.reduce((sum, track) => sum + track.cueCount, 0), trackId: tracks[0]?.id };
  }
  function editCaptionSource(html: string, command: CaptionSourceCommand, id: string, options: CaptionSourceOptions) {
    if (command === 'caption_toggle') return toggleCaptionSource(html, id, Boolean(options.visible));
    if (command === 'caption_update') {
      return { ...updateCaptionTrackSource(html, id, options.captionSettings ?? {}, options.remove === true), trackId: id };
    }
    return { ...manualCaptionSource(html, id, { ...options, textKind: options.textKind === 'text' ? 'text' : 'caption' }), trackId: id };
  }
  return { captionTracks, updateCaptionTrackSource, transcriptCaptionSource, manualCaptionSource, toggleCaptionSource, editCaptionSource };
}
