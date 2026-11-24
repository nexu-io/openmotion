import { setBlockParameter } from './composition-variable.ts';
import { clipboardMarkupForFile } from './clipboard-paths.ts';
import { parseSourceDocument, findTargetElement } from '@hyperframes/studio-server/source-mutation';
import { encodeUrlPath } from '@hyperframes/parsers';
import { stampHfIdsInPlace } from '@hyperframes/parsers/hf-ids';
import { applyPatchByTarget, readTagSnippetByTarget } from './source-patcher.ts';
import { applyAssetTrackLayout } from './asset-track-layout.ts';
import { buildTimelineAssetId } from '@hyperframes/core/timeline-asset-id';
import { decodeAuthoredAttribute, scanHtmlOpeningTags } from '@hyperframes/parsers/html-attribute-spans';
import {
  collectHtmlIds,
  buildTimelineAssetInsertHtml,
  fitTimelineAssetGeometry,
  getTimelineAssetKind,
  insertTimelineAssetIntoSource,
  resolveTimelineAssetCompositionSize,
  resolveTimelineAssetSrc,
} from './asset-placement.ts';
import { insertCompositionInMemory } from './insert-composition.ts';
import { pasteTimelineClips, pasteElementHtml, savedClipboardPeers } from './clipboard.ts';
import type { ContentCommand, PasteCommand } from './content-schema.ts';

export * from './content-schema.ts';

export function applyPasteCommand(source: string, command: PasteCommand) {
  if (!Number.isFinite(command.start) || command.start < 0) throw new Error('Invalid paste time.');
  const peers = savedClipboardPeers(source);
  if (command.kind === 'pasteElement') {
    let hfId: string | undefined;
    const payload = { ...command, html: clipboardMarkupForFile(command.html, command.compositionPath) };
    const content = pasteElementHtml(
      source,
      payload,
      command.copyLook,
      (id) => {
        hfId = id;
      },
      command.start,
      peers,
    );
    return { content, ids: [] as string[], hfId };
  }
  const clips = command.clips.map((clip) => ({
    ...clip,
    html: clipboardMarkupForFile(clip.html, command.compositionPath),
  }));
  const pasted = pasteTimelineClips(source, clips, command.start, peers, command.copyLook);
  return { content: extendDuration(pasted.content, pasted.requiredEnd), ids: pasted.ids, hfId: undefined };
}

function extendDuration(source: string, requiredEnd: number): string {
  const root = scanHtmlOpeningTags(source).find((tag) =>
    tag.attributes.some((attr) => attr.name === 'data-composition-id'),
  );
  const attr = root?.attributes.find((attr) => attr.name === 'data-duration');
  const end = Math.round(requiredEnd * 100) / 100;
  return attr?.kind === 'value' && Number(attr.value) < end
    ? source.slice(0, attr.valueStart) + end + source.slice(attr.valueEnd)
    : source;
}

function replaceAsset(source: string, command: Extract<ContentCommand, { kind: 'replaceAsset' }>): string {
  const { document } = parseSourceDocument(source);
  const node = findTargetElement(document, { hfId: command.hfId });
  const kind = getTimelineAssetKind(command.assetPath);
  const tag = kind === 'image' ? 'img' : kind;
  if (
    !node ||
    !['audio', 'img', 'video'].includes(node.localName) ||
    tag !== node.localName ||
    node.closest('[data-timeline-locked]')
  )
    throw new Error('Choose an unlocked clip and same-kind media.');
  const previous = node.getAttribute('src');
  if (!previous) throw new Error('The selected clip has no media source.');
  if (command.expectedAssetPath) {
    const url = new URL(previous, new URL(command.compositionPath, 'https://project.invalid/'));
    if (
      url.origin !== 'https://project.invalid' ||
      decodeURIComponent(url.pathname.slice(1)) !== command.expectedAssetPath
    ) {
      throw new Error('The original media changed.');
    }
  }
  const url = encodeUrlPath(resolveTimelineAssetSrc(command.compositionPath, command.assetPath));
  if (url === previous) return source;
  const target = { hfId: command.hfId };
  return applyPatchByTarget(
    readTagSnippetByTarget(source, target) ? source : stampHfIdsInPlace(source),
    target,
    { type: 'html-attribute', property: 'src', value: url },
  );
}

function placeAsset(source: string, command: Extract<ContentCommand, { kind: 'placeAsset' }>): string {
  const { start, track, canvasPosition, compositionPath } = command;
  if (command.trackLayout?.length) source = applyAssetTrackLayout(source, command.trackLayout);
  const { assetPath, duration, hfId } = command;
  const kind = getTimelineAssetKind(assetPath);
  if (
    !kind ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(hfId) ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    (command.zIndex !== undefined && (!Number.isSafeInteger(command.zIndex) || command.zIndex < 1))
  ) {
    throw new Error('Invalid asset clip.');
  }
  const tags = scanHtmlOpeningTags(source);
  const ids = collectHtmlIds(source, tags);
  let timedElements = 0;
  const root = tags.find((tag) => tag.attributes.some((attr) => attr.name === 'data-composition-id'));
  if (!root || root.attributes.some((attr) => attr.name === 'data-timeline-locked'))
    throw new Error('No editable composition root.');
  for (const tag of tags) {
    for (const attr of tag.attributes) {
      if (attr.kind !== 'value') continue;
      if (attr.name === 'data-hf-id' && decodeAuthoredAttribute(attr.value) === hfId)
        throw new Error('Clip hfId already exists.');
      if (tag !== root && attr.name === 'data-duration') timedElements++;
    }
  }
  const clip = buildTimelineAssetInsertHtml({
    id: buildTimelineAssetId(assetPath, ids),
    hfId,
    assetPath: resolveTimelineAssetSrc(compositionPath, assetPath),
    kind,
    start,
    duration,
    track,
    zIndex: command.zIndex ?? timedElements + 1,
    hasAudio: command.hasAudio,
    geometry: fitTimelineAssetGeometry(null, resolveTimelineAssetCompositionSize(source), canvasPosition),
  });
  return insertTimelineAssetIntoSource(extendDuration(source, start + duration), clip);
}

export function applyContentCommand(
  source: string,
  command: ContentCommand,
  files?: ReadonlyMap<string, string>,
): string {
  if (command.kind === 'pasteClips' || command.kind === 'pasteElement')
    return applyPasteCommand(source, command).content;
  if (command.kind === 'replaceAsset') return replaceAsset(source, command);
  if (command.kind === 'setBlockParameter')
    return setBlockParameter(source, command.key, command.value, command.compositionPath, command.previous);
  const { start, track, canvasPosition, compositionPath } = command;
  if (
    !Number.isFinite(start) ||
    start < 0 ||
    !Number.isSafeInteger(track) ||
    (canvasPosition !== undefined &&
      (!Number.isFinite(canvasPosition?.left) || !Number.isFinite(canvasPosition?.top)))
  ) {
    throw new Error('Invalid timeline placement.');
  }
  if (command.kind === 'insertComposition') {
    const childSource = files?.get(command.sourcePath);
    if (!childSource) throw new Error('Composition source was not found.');
    const result = insertCompositionInMemory({
      parentSource: source,
      childSource,
      targetPath: compositionPath,
      sourcePath: command.sourcePath,
      start,
      desiredTrack: track,
      canvasPosition,
    });
    if (result.ok === false) throw new Error(result.error);
    return result.html;
  }

  return placeAsset(source, command);
}
