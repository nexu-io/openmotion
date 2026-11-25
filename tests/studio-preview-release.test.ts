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
