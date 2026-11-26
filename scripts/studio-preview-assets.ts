import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { lfsPointer } from '../shared/repository-template-catalog.ts';
import { maxMediaBytes, mediaDigest, mediaKey, mediaOrigin, skillPreviewMedia, validateMediaManifest, type MediaLock } from '../shared/repository-media.ts';

export const previewSources = 'studio/preview-media';
const legacyDirectory = 'studio/src/motion/skill-covers/';

/** The image build can use LFS pointers. Publishing checks the actual bytes before uploading. */
export function studioPreviewAssets(root: string) {
  const manifest = validateMediaManifest(JSON.parse(readFileSync(path.join(root, 'repository-media.json'), 'utf8')));
  const assets = new Map<string, { lock: MediaLock; source?: string }>();
  for (const lock of manifest.files) {
    if (skillPreviewMedia.test(lock.path)) assets.set(path.basename(lock.path), { lock });
  }
  const directory = path.join(root, previewSources);
  if (!existsSync(directory)) return assets;
  assert(lstatSync(directory).isDirectory(), 'Expected a regular Studio preview source directory');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = entry.name, logicalPath = legacyDirectory + name;
    assert(entry.isFile() && skillPreviewMedia.test(logicalPath), `Unsupported Studio preview source: ${name}`);
    const source = path.join(directory, name);
    assert(lstatSync(source).size <= maxMediaBytes, `Preview exceeds size limit: ${name}`);
    const data = readFileSync(source);
    const pointer = lfsPointer(data);
    assert(pointer || !data.subarray(0, 42).toString().startsWith('version https://git-lfs.github.com/'), `Malformed LFS pointer: ${name}`);
    const bytes = pointer?.bytes ?? data.length, sha256 = pointer?.sha256 ?? mediaDigest(data);
    assert(bytes > 0 && bytes <= maxMediaBytes, `Invalid preview size: ${name}`);
    assets.set(name, { source, lock: { path: logicalPath, sha256, bytes, url: `${mediaOrigin}/${mediaKey(sha256, name)}` } });
  }
  return assets;
}
