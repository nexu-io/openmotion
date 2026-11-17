import { stat } from 'node:fs/promises';
import path from 'node:path';
import { execute, pluginRoot } from '../hyperframes.ts';
import { verificationBinaries } from '../scripts/verify-export.ts';
import { requireNativeRuntime } from '../scripts/npm-runtime.mjs';
import { MAX_ASSET_BYTES } from '../shared/asset-limits.ts';
import type { Modality } from '../shared/gateway.ts';

/** Check local saving prerequisites before a generation can incur model usage. */
export async function requireLibraryMediaRuntime() {
  await requireNativeRuntime(pluginRoot, 'media');
  const binaries = verificationBinaries();
  for (const [name, binary] of Object.entries(binaries)) {
    try {
      const result = await execute(binary, ['-version'], pluginRoot, 5000);
      if (result.code) throw new Error('Media tool failed to start');
    } catch {
      throw new Error(`ASSET_MEDIA_RUNTIME_NOT_READY: ${name} is unavailable. Prepare this installation's media components, or configure HYPERFRAMES_FFMPEG_PATH and HYPERFRAMES_FFPROBE_PATH for a source checkout, then restart the service. No model request was made by this check.`);
    }
  }
  return binaries;
}

/** Inspect and decode local media before accepting it into the reusable library. */
export async function probeLibraryMedia(file: string) {
  const info = await stat(file);
  if (!info.isFile() || !info.size || info.size > MAX_ASSET_BYTES) throw new Error('Asset must be a file of at most 500 MB');
  await requireNativeRuntime(pluginRoot, 'media');
  const binaries = verificationBinaries();
  const result = await execute(binaries.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], path.dirname(file), 60_000);
  if (result.code) throw new Error('This file is not readable image, video or audio media');
  const media = JSON.parse(result.stdout);
  const stream = media.streams?.find((s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic) ?? media.streams?.find((s: any) => s.codec_type === 'audio');
  if (!stream) throw new Error('Unsupported media type');
  const images: Record<string, [string, string]> = { png: ['image/png', 'png'], mjpeg: ['image/jpeg', 'jpg'], webp: ['image/webp', 'webp'], gif: ['image/gif', 'gif'], av1: ['image/avif', 'avif'] };
  const format = String(media.format?.format_name ?? '');
  const image = /image2|_pipe|^gif$|^avif$/.test(format) ? images[stream.codec_name] : undefined;
  const kind = image ?? (stream.codec_type === 'video' && format.includes('mov') ? ['video/mp4', 'mp4']
    : stream.codec_type === 'video' && /webm|matroska/.test(format) ? ['video/webm', 'webm']
    : stream.codec_type === 'audio' ? ({ wav: ['audio/wav', 'wav'], mp3: ['audio/mpeg', 'mp3'], ogg: ['audio/ogg', 'ogg'], flac: ['audio/flac', 'flac'], aac: ['audio/aac', 'aac'] } as Record<string, string[]>)[format]
      ?? (format.includes('mov') ? ['audio/mp4', 'm4a'] : /webm|matroska/.test(format) ? ['audio/webm', 'webm'] : undefined) : undefined);
  if (!kind || stream.codec_type === 'video' && !(stream.width > 0 && stream.height > 0)) throw new Error('Unsupported media type');
  const decoded = await execute(binaries.ffmpeg, ['-v', 'error', '-xerror', '-err_detect', 'explode', '-i', file, '-map', `0:${stream.index}`, stream.codec_type === 'video' ? '-frames:v' : '-frames:a', '1', '-f', 'null', '-'], path.dirname(file), 60_000);
  if (decoded.code) throw new Error('The media file could not be decoded');
  return { modality: kind[0].split('/')[0] as Modality, mimeType: kind[0], extension: kind[1], bytes: info.size,
    ...(stream.width ? { width: stream.width, height: stream.height } : {}), ...(!image && Number(media.format?.duration) > 0 ? { duration: Number(media.format.duration) } : {}) };
}
