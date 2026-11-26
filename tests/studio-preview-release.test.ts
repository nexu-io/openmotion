import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mediaDigest } from '../shared/repository-media.ts';
import { previewSources, studioPreviewAssets } from '../scripts/studio-preview-assets.ts';
import { publishStudioPreviews } from '../scripts/publish-studio-previews.ts';

test('preview updates publish the image’s exact hash, reuse objects on retry and preserve earlier releases', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, previewSources), file = path.join(dir, 'hero.mp4');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(root, 'repository-media.json'), JSON.stringify({ schemaVersion: 1, files: [] }));
  const bytes = Buffer.from('first video'), digest = mediaDigest(bytes);
  await writeFile(file, `version https://git-lfs.github.com/spec/v1\noid sha256:${digest}\nsize ${bytes.length}\n`);
  const pointerLock = studioPreviewAssets(root).get('hero.mp4')!.lock;
  const objects = new Map<string, Buffer>();
  let puts = 0;
  const storage = {
    endpoint: 'https://test.r2.cloudflarestorage.com', bucket: 'test-media',
    fetcher: (async (url, init) => {
      const object = objects.get(new URL(String(url)).pathname.slice(1));
      return new Response(init?.method === 'HEAD' || !object ? null : new Uint8Array(object), { status: object ? 200 : 404 });
    }) as typeof fetch,
    run: async (args: string[]) => {
      puts++;
      assert.equal(args[args.indexOf('--if-none-match') + 1], '*');
      objects.set(args[args.indexOf('--key') + 1], await readFile(args[args.indexOf('--body') + 1]));
    },
  };
  await assert.rejects(publishStudioPreviews(root, storage),
    (error: Error) => error.message.startsWith(`Media size mismatch: ${pointerLock.path}`));
  assert.equal(puts, 0, 'an unhydrated LFS pointer must not be uploaded');
  await writeFile(file, bytes);
  assert.deepEqual(studioPreviewAssets(root).get('hero.mp4')!.lock, pointerLock);
  await publishStudioPreviews(root, storage);
  await publishStudioPreviews(root, storage);
  assert.equal(puts, 1);
  await writeFile(file, 'second video');
  await publishStudioPreviews(root, storage);
  const next = studioPreviewAssets(root).get('hero.mp4')!.lock;
  assert.notEqual(next.url, pointerLock.url);
  assert.equal(puts, 2);
  assert.deepEqual(objects.get(new URL(pointerLock.url).pathname.slice(1)), bytes);
  objects.set(new URL(next.url).pathname.slice(1), Buffer.from('broken'));
  await assert.rejects(publishStudioPreviews(root, storage), /size mismatch/i);
});

test('on-demand LFS hydration pulls only missing public objects and skips already-published pointers', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-media-lfs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, previewSources);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(root, 'repository-media.json'), JSON.stringify({ schemaVersion: 1, files: [] }));

  const existingBytes = Buffer.from('already published video');
  const existingDigest = mediaDigest(existingBytes);
  const existingFile = path.join(dir, 'existing.mp4');
  await writeFile(existingFile, `version https://git-lfs.github.com/spec/v1\noid sha256:${existingDigest}\nsize ${existingBytes.length}\n`);

  const missingBytes = Buffer.from('brand new preview video');
  const missingDigest = mediaDigest(missingBytes);
  const missingFile = path.join(dir, 'new-preview.mp4');
  await writeFile(missingFile, `version https://git-lfs.github.com/spec/v1\noid sha256:${missingDigest}\nsize ${missingBytes.length}\n`);

  const locks = studioPreviewAssets(root);
  const objects = new Map<string, Buffer>([
    [new URL(locks.get('existing.mp4')!.lock.url).pathname.slice(1), existingBytes],
  ]);
  let puts = 0;
  const hydratedBatches: string[][] = [];
  const storage = {
    endpoint: 'https://test.r2.cloudflarestorage.com', bucket: 'test-media',
    fetcher: (async (url, init) => {
      const object = objects.get(new URL(String(url)).pathname.slice(1));
      return new Response(init?.method === 'HEAD' || !object ? null : new Uint8Array(object), { status: object ? 200 : 404 });
    }) as typeof fetch,
    run: async (args: string[]) => {
      puts++;
      objects.set(args[args.indexOf('--key') + 1], await readFile(args[args.indexOf('--body') + 1]));
    },
  };

  const hydrateMissingLfs = async (paths: string[]) => {
    hydratedBatches.push(paths);
    for (const rel of paths) {
      if (rel.endsWith('/new-preview.mp4')) await writeFile(missingFile, missingBytes);
    }
  };

  await publishStudioPreviews(root, storage, { hydrateMissingLfs });
  assert.deepEqual(hydratedBatches, [['studio/preview-media/new-preview.mp4']]);
  assert.equal(puts, 1);

  // Subsequent release with both files still unhydrated LFS pointers pulls zero objects from LFS.
  await writeFile(missingFile, `version https://git-lfs.github.com/spec/v1\noid sha256:${missingDigest}\nsize ${missingBytes.length}\n`);
  hydratedBatches.length = 0;
  await publishStudioPreviews(root, storage, { hydrateMissingLfs });
  assert.deepEqual(hydratedBatches, []);
  assert.equal(puts, 1);
});
