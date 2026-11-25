import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isMain } from '../shared/entry.ts';
import { maxMediaBytes } from '../shared/repository-media.ts';
import { lfsPointer } from '../shared/repository-template-catalog.ts';
import { publishMedia } from './prepare-pr-media.ts';
import { previewSources, studioPreviewAssets } from './studio-preview-assets.ts';

const run = promisify(execFile);
// Original committed source bytes for the pre-LFS cover library, retained in main's history.
const posters = '008e46e896a72f4e5bd743fe1c4a5752240d2e8f';
const animations = '242dbd99d41e349ea43c3d8d48a1e06f6cece81a';
const lfsPullBatchSize = 40;

export type PublishStudioPreviewOptions = {
  /** Hydrate only unhydrated Git LFS pointers whose public CDN object is missing (HTTP 404). */
  hydrateMissingLfs?: boolean | ((paths: string[]) => Promise<void>);
};

async function pullMissingLfsSources(root: string, relativePaths: string[]) {
  for (let index = 0; index < relativePaths.length; index += lfsPullBatchSize) {
    const batch = relativePaths.slice(index, index + lfsPullBatchSize);
    await run('git', ['lfs', 'pull', `--include=${batch.join(',')}`, '--exclude='], { cwd: root });
  }
}

export async function publishStudioPreviews(
  root: string,
  storage: Parameters<typeof publishMedia>[2],
  options: PublishStudioPreviewOptions = {},
) {
  const assets = [...studioPreviewAssets(root).values()];
  const unique = new Map(assets.map(asset => [asset.lock.url, asset]));

  if (options.hydrateMissingLfs) {
    const fetcher = storage.fetcher ?? fetch;
    const unhydrated: { url: string; relativePath: string }[] = [];
    for (const { lock, source } of unique.values()) {
      if (!source) continue;
      const raw = await readFile(source);
      if (lfsPointer(raw)) {
        unhydrated.push({ url: lock.url, relativePath: path.posix.join(previewSources, path.basename(source)) });
      }
    }
    if (unhydrated.length) {
      const missing: string[] = [];
      const queue = unhydrated.values();
      await Promise.all(Array.from({ length: Math.min(8, unhydrated.length) }, async () => {
        for (const item of queue) {
          const response = await fetcher(item.url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(30_000) });
          if (response.status === 404) missing.push(item.relativePath);
        }
      }));
      if (missing.length) {
        missing.sort();
        if (typeof options.hydrateMissingLfs === 'function') await options.hydrateMissingLfs(missing);
        else await pullMissingLfsSources(root, missing);
      }
    }
  }

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
  console.log(await publishStudioPreviews(process.cwd(), { endpoint, bucket }, { hydrateMissingLfs: true }));
}
