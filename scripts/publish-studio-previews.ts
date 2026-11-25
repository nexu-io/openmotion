import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { isMain } from '../shared/entry.ts';
import { maxMediaBytes } from '../shared/repository-media.ts';
import { publishMedia } from './prepare-pr-media.ts';
import { studioPreviewAssets } from './studio-preview-assets.ts';

const run = promisify(execFile);
// Original committed source bytes for the pre-LFS cover library, retained in main's history.
const posters = '008e46e896a72f4e5bd743fe1c4a5752240d2e8f';
const animations = '242dbd99d41e349ea43c3d8d48a1e06f6cece81a';

export async function publishStudioPreviews(root: string, storage: Parameters<typeof publishMedia>[2]) {
  const assets = [...studioPreviewAssets(root).values()];
  const unique = new Map(assets.map(asset => [asset.lock.url, asset]));
  const pending = unique.values();
  let archivesReady: Promise<unknown> | undefined;
  function ensureArchives() {
    // Only one fetch may update .git/shallow, even when both snapshot types are missing.
    return archivesReady ??= Promise.all([posters, animations].map(revision =>
      run('git', ['cat-file', '-e', `${revision}^{commit}`], { cwd: root })
    )).catch(() => run('git', ['fetch', '--no-tags', '--depth=1', 'origin', posters, animations], { cwd: root }));
  }
  async function worker() {
    for (const { lock, source } of pending) {
      await publishMedia(lock, async () => {
        if (source) return readFile(source);
        const revision = lock.path.endsWith('.webp') ? posters : animations;
        await ensureArchives();
        const { stdout } = await run('git', ['show', `${revision}:${lock.path}`], { cwd: root, encoding: 'buffer', maxBuffer: maxMediaBytes });
        return stdout;
      }, storage);
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, unique.size) }, worker));
  return { previews: assets.length, verifiedObjects: unique.size };
}

if (isMain(import.meta.url)) {
  const endpoint = process.env.MOTION_R2_ENDPOINT, bucket = process.env.MOTION_R2_BUCKET;
  assert(endpoint && bucket, 'Configure the release media R2 endpoint and bucket');
  console.log(await publishStudioPreviews(process.cwd(), { endpoint, bucket }));
}
