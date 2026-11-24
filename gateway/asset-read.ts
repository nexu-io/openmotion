import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { execute, pluginRoot } from '../hyperframes.ts';
import { verificationBinaries } from '../scripts/verify-export.ts';
import type { AssetReadBatchItem, AssetReadResult, AssetReference } from '../shared/asset-library.ts';
import type { AssetLibrary } from './asset-library.ts';
import { probeLibraryMedia } from './asset-probe.ts';

const maxPreviewBytes = 4 * 1024 * 1024, maxReadBytes = 8 * 1024 * 1024;
const defaultMaxEdge = 1024, minMaxEdge = 128, maxBatchItems = 12;

type ReadInput = {
  assetId?: string;
  versionId?: string;
  items?: AssetReference[];
  timestamps?: number[];
  start?: number;
  duration?: number;
  maxEdge?: number;
};

function parseMaxEdge(value: unknown, modality: string): number {
  if (value === undefined) return defaultMaxEdge;
  if (modality === 'audio') throw new Error('INVALID_ARGUMENT: maxEdge is image/video-only');
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minMaxEdge || value > defaultMaxEdge) {
    throw new Error(`INVALID_ARGUMENT: maxEdge must be an integer between ${minMaxEdge} and ${defaultMaxEdge}`);
  }
  return value;
}

async function readImageContactSheet(library: AssetLibrary, items: AssetReference[], rawMaxEdge: unknown): Promise<AssetReadResult> {
  if (!Array.isArray(items) || !items.length || items.length > maxBatchItems) {
    throw new Error(`INVALID_ARGUMENT: items must select 1–${maxBatchItems} pinned image versions`);
  }
  const sheetMaxEdge = parseMaxEdge(rawMaxEdge, 'image');
  const preparedFiles: string[] = [];
  let directory: string | undefined;
  try {
    const resolved: { assetName: string; assetId: string; versionId: string; file: string; width?: number; height?: number; mimeType: string; bytes: number }[] = [];
    for (const ref of items) {
      if (!ref || typeof ref !== 'object' || !ref.assetId || !ref.versionId) {
        throw new Error('INVALID_ARGUMENT: each batch read item requires assetId and versionId');
      }
      const { asset, version, filename } = await library.resolve(ref, true);
      if (asset.modality !== 'image') {
        throw new Error('INVALID_ARGUMENT: batch contact-sheet read supports image assets only');
      }
      const prepared = await library.prepare(filename);
      preparedFiles.push(prepared.file);
      if (prepared.sha256 !== version.sha256 || prepared.bytes !== version.bytes || prepared.media.modality !== 'image') {
        throw new Error('ASSET_CONTENT_CHANGED: bytes no longer match the pinned version');
      }
      resolved.push({
        assetName: asset.name,
        assetId: asset.id,
        versionId: version.id,
        file: prepared.file,
        width: version.width ?? prepared.media.width,
        height: version.height ?? prepared.media.height,
        mimeType: version.mimeType,
        bytes: version.bytes,
      });
    }
    directory = await mkdtemp(path.join(path.dirname(preparedFiles[0]), 'read-sheet-'));
    const cols = Math.ceil(Math.sqrt(resolved.length));
    const rows = Math.ceil(resolved.length / cols);
    const gridMax = Math.max(cols, rows);
    const pad = 4, margin = 4;
    // Keep the full composited sheet (including padding and margins) strictly within sheetMaxEdge for all 1..12 item grids.
    const cell = Math.max(1, Math.floor((sheetMaxEdge - margin * 2 - pad * (gridMax - 1)) / gridMax));

    const args: string[] = ['-v', 'error', '-nostdin'];
    const filters: string[] = [];
    for (const [i, entry] of resolved.entries()) {
      args.push('-i', entry.file);
      // Composite onto a neutral mid-gray matte so transparent cutouts vs solid boxes stay distinct in one glance.
      filters.push(
        `color=c=0x8c8c94:s=${cell}x${cell}:r=1:d=1[bg${i}]`,
        `[${i}:v]format=rgba,scale=w=${cell}:h=${cell}:force_original_aspect_ratio=decrease[fg${i}]`,
        `[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2:shortest=1,setpts=PTS-STARTPTS[c${i}]`,
      );
    }
    if (resolved.length === 1) {
      filters.push(`[c0]pad=${cell + margin * 2}:${cell + margin * 2}:${margin}:${margin}:color=0x26262a[out]`);
    } else {
      const inputs = resolved.map((_, i) => `[c${i}]`).join('');
      filters.push(`${inputs}concat=n=${resolved.length}:v=1:a=0,tile=${cols}x${rows}:padding=${pad}:margin=${margin}:color=0x26262a[out]`);
    }
    const output = path.join(directory, 'sheet.png');
    args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', '-fs', String(maxPreviewBytes), '-y', output);
    const command = await execute(verificationBinaries().ffmpeg, args, pluginRoot, 30_000);
    if (command.code) throw new Error('ASSET_READ_FAILED: contact sheet preview could not be rendered');
    const info = await stat(output).catch(() => null);
    if (!info?.isFile() || !info.size || info.size > maxPreviewBytes) {
      throw new Error('ASSET_READ_LIMIT: contact sheet exceeds the byte limit; pass a smaller maxEdge or fewer items');
    }
    const media = await probeLibraryMedia(output);
    if (media.mimeType !== 'image/png') throw new Error('ASSET_READ_FAILED: unexpected preview format');
    const batchItems: AssetReadBatchItem[] = resolved.map((entry, idx) => ({
      index: idx + 1,
      assetId: entry.assetId,
      versionId: entry.versionId,
      name: entry.assetName,
      modality: 'image',
      ...(entry.width ? { width: entry.width } : {}),
      ...(entry.height ? { height: entry.height } : {}),
      mimeType: entry.mimeType,
      bytes: entry.bytes,
    }));
    const legend = batchItems.map(item => `[${item.index}] ${item.name} (${item.assetId}/${item.versionId}${item.width && item.height ? `, ${item.width}x${item.height}` : ''})`).join(' | ');
    return {
      modality: 'image',
      items: batchItems,
      grid: { cols, rows, cellSize: cell },
      previews: [{ mimeType: media.mimeType, bytes: info.size, width: media.width, height: media.height }],
      content: [
        { type: 'text', text: `Contact sheet (${cols}x${rows}, row-major, ${batchItems.length} images, neutral gray matte shows transparent alpha): ${legend}` },
        { type: 'image', mimeType: media.mimeType, data: (await readFile(output)).toString('base64') },
      ],
    };
  } finally {
    await Promise.all(preparedFiles.map(file => rm(file, { force: true }).catch(() => {})));
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function readLibraryAsset(library: AssetLibrary, input: ReadInput): Promise<AssetReadResult> {
  if (input.items !== undefined) {
    if (input.assetId || input.versionId || input.timestamps !== undefined || input.start !== undefined || input.duration !== undefined) {
      throw new Error('INVALID_ARGUMENT: batch read items cannot be combined with assetId, versionId, timestamps, start or duration');
    }
    return readImageContactSheet(library, input.items, input.maxEdge);
  }
  if (!input.assetId || !input.versionId) throw new Error('INVALID_ARGUMENT: read requires assetId and versionId (or image items)');
  const { asset, version, filename } = await library.resolve({ assetId: input.assetId, versionId: input.versionId }, true);
  if (input.timestamps !== undefined && (asset.modality !== 'video' || !Array.isArray(input.timestamps) || !input.timestamps.length || input.timestamps.length > 4
    || input.timestamps.some(time => !Number.isFinite(time) || time < 0 || version.duration !== undefined && time >= version.duration))) throw new Error('INVALID_ARGUMENT: timestamps must select at most four available video frames');
  if ((input.start !== undefined || input.duration !== undefined) && asset.modality !== 'audio') throw new Error('INVALID_ARGUMENT: start and duration are audio-only');
  const maxEdge = parseMaxEdge(input.maxEdge, asset.modality);
  const start = input.start ?? 0, duration = input.duration ?? 10;
  if (asset.modality === 'audio' && (!Number.isFinite(start) || start < 0 || version.duration !== undefined && start >= version.duration
    || !Number.isFinite(duration) || duration < 0.1 || duration > 15)) throw new Error('INVALID_ARGUMENT: audio start must be available and duration must be 0.1–15 seconds');
  // Snapshot once so hashing and every preview decode use the same bytes even during external writes.
  const prepared = await library.prepare(filename);
  let directory: string | undefined;
  try {
    if (prepared.sha256 !== version.sha256 || prepared.bytes !== version.bytes || prepared.media.modality !== asset.modality) throw new Error('ASSET_CONTENT_CHANGED: bytes no longer match the pinned version');
    directory = await mkdtemp(path.join(path.dirname(prepared.file), 'read-'));
    const times = asset.modality === 'video' ? input.timestamps ?? [0] : [0];
    const result: AssetReadResult = { assetId: asset.id, versionId: version.id, modality: asset.modality, version, previews: [], content: [] };
    let total = 0;
    for (const [index, timestamp] of times.entries()) {
      const audio = asset.modality === 'audio', output = path.join(directory, `${index}.${audio ? 'wav' : 'png'}`);
      const command = await execute(verificationBinaries().ffmpeg, ['-v', 'error', '-nostdin', '-ss', String(audio ? start : timestamp), '-i', prepared.file,
        ...(audio ? ['-map', '0:a:0', '-t', String(duration), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le']
          : ['-map', '0:V:0', '-frames:v', '1', '-vf', `scale=w='min(${maxEdge},iw)':h='min(${maxEdge},ih)':force_original_aspect_ratio=decrease`]),
        '-fs', String(maxPreviewBytes), '-y', output], pluginRoot, 30_000);
      if (command.code) throw new Error('ASSET_READ_FAILED: media preview could not be decoded');
      const info = await stat(output).catch(() => null);
      if (!info?.isFile() || !info.size || info.size > maxPreviewBytes || (total += info.size) > maxReadBytes) throw new Error('ASSET_READ_LIMIT: preview exceeds the byte limit; use fewer video frames or smaller source media');
      const media = await probeLibraryMedia(output);
      if (media.mimeType !== (audio ? 'audio/wav' : 'image/png')) throw new Error('ASSET_READ_FAILED: unexpected preview format');
      result.previews.push({ mimeType: media.mimeType, bytes: info.size, ...(audio ? { start, duration: media.duration } : { width: media.width, height: media.height }),
        ...(asset.modality === 'video' ? { timestamp } : {}) });
      result.content.push({ type: 'text', text: `${asset.id}/${version.id}: ${audio ? `audio from ${start}s (${media.duration}s); playback/listening depends on host support` : asset.modality === 'video' ? `video frame requested at ${timestamp}s (codec seeking may quantize the frame)` : 'image preview'}` },
        { type: audio ? 'audio' : 'image', mimeType: media.mimeType, data: (await readFile(output)).toString('base64') });
    }
    return result;
  } finally {
    await rm(prepared.file, { force: true });
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
