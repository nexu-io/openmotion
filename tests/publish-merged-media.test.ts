import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishMergedPullRequestMedia } from '../scripts/publish-merged-media.ts';
import { mediaDigest, type MediaLock } from '../shared/repository-media.ts';

function git(directory: string, args: string[], input?: string): Buffer {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, input });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmotion-merged-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source'), remote = path.join(directory, 'remote.git');
  await mkdir(source);
  git(source, ['init', '-q', '-b', 'main']);
  git(source, ['config', 'user.name', 'Fixture']);
  git(source, ['config', 'user.email', 'fixture@example.invalid']);
  git(directory, ['init', '-q', '--bare', remote]);
  const commit = async (files: Record<string, string>) => {
    for (const [name, value] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(source, name)), { recursive: true });
      await writeFile(path.join(source, name), value);
    }
    git(source, ['add', '.']);
    git(source, ['commit', '-qm', 'Fixture commit']);
    git(source, ['push', '-q', remote, 'HEAD:refs/heads/main']);
    return git(source, ['rev-parse', 'HEAD']).toString().trim();
  };
  const prefix = 'library/templates/catalog/motion-fixture/';
  const template = { [prefix + 'source/motion.md']: '# Fixture\n', [prefix + 'source/preview.html']: '<p>Fixture</p>' };
  const baseSHA = await commit({ 'README.md': '# Base\n', ...template,
    'library/templates/catalog/catalog.json': JSON.stringify({ schemaVersion: 1, publication: { locales: ['en'], defaultLocale: 'en' }, templateIds: ['motion-fixture'] }),
    [prefix + 'template.json']: JSON.stringify({ templateId: 'motion-fixture', entry: { templateId: 'motion-fixture', original: { templateName: 'Fixture' }, files: [] }, locales: { en: {} } }),
    [prefix + 'TEMPLATE.md']: '# Fixture\n',
    [prefix + 'source/manifest.json']: JSON.stringify({ files: Object.entries(template).map(([name, content]) => ({ path: name.slice((prefix + 'source/').length), bytes: Buffer.byteLength(content), sha256: mediaDigest(Buffer.from(content)) })) }),
  });
  const mediaPath = 'docs/readme/merged.mp4';
  // A two-commit rebase merge must include media from the first commit.
  await commit({ [mediaPath]: 'reviewed media', 'README.md': '# Reference\n[Film](docs/readme/merged.mp4)\n' });
  const mergeSHA = await commit({ 'second-commit.txt': 'Rebased PR commit\n' });
  const main = () => git(remote, ['rev-parse', 'refs/heads/main']).toString().trim();
  const requests: string[] = [], uploads: MediaLock[] = [], pushes: string[][] = [];
  let beforePush: (() => Promise<void>) | undefined;
  const options = {
    token: 'installation-token',
    request: (async (input: any, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      // Installation tokens cannot query /user. Reject any unexpected endpoint.
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer installation-token');
      const route = url.replace('https://api.github.com/repos/nexu-io/openmotion/', '');
      if (route === 'git/ref/heads/main') return Response.json({ object: { sha: main() } });
      if (route.startsWith('compare/')) {
        const [base, head] = route.slice('compare/'.length).split('...');
        git(remote, ['merge-base', '--is-ancestor', base, head]);
        return Response.json({ status: base === head ? 'identical' : 'ahead' });
      }
      if (route.startsWith('git/trees/')) {
        const commit = route.slice('git/trees/'.length).split('?')[0];
        const tree = git(remote, ['ls-tree', '-rlz', commit]).toString().split('\0').filter(Boolean).map(line => {
          const [metadata, name] = line.split('\t'), [mode, type, sha, size] = metadata.trim().split(/\s+/);
          return { path: name, mode, type, sha, size: Number(size) };
        });
        return Response.json({ tree, truncated: false });
      }
      if (route.startsWith('git/blobs/')) return new Response(new Uint8Array(git(remote, ['cat-file', 'blob', route.slice('git/blobs/'.length)])));
      assert.fail('Unsupported installation-token request: ' + url);
    }) as typeof fetch,
    transfer: async (lock: MediaLock, bytes: Buffer) => {
      assert.equal(mediaDigest(bytes), lock.sha256);
      assert.equal(bytes.length, lock.bytes);
      uploads.push(lock);
    },
    createGit: async (cwd: string) => async (args: string[], input?: string) => {
      const localArgs = args.map(arg => arg === 'https://github.com/nexu-io/openmotion.git' ? 'file://' + remote : arg);
      if (args.includes('commit-tree')) {
        // Exercise real final-index validation from a fresh shallow repository.
        git(cwd, ['cat-file', '-e', baseSHA + '^{commit}']);
        assert(args.includes('user.name=github-actions[bot]'));
      }
      if (args[0] === 'push') {
        pushes.push(args);
        await beforePush?.();
        beforePush = undefined;
      }
      return git(cwd, localArgs, input).toString().trim();
    },
  };
  return { baseSHA, mergeSHA, remote, mediaPath, main, commit, options, uploads, pushes, requests,
    beforePush: (callback: () => Promise<void>) => { beforePush = callback; } };
}

test('an installation token cleans a fresh shallow clone after a multi-commit rebase merge', async t => {
  const f = await fixture(t);
  const result = await publishMergedPullRequestMedia(42, f.mergeSHA, f.baseSHA, f.options);
  assert.equal(result.cleanup, true);
  assert.equal(result.media, 1);
  assert.equal(result.sourceSHA, f.main());
  assert.equal(git(f.remote, ['rev-parse', f.main() + '^']).toString().trim(), f.mergeSHA);
  const tree = git(f.remote, ['ls-tree', '-r', '--name-only', f.main()]).toString();
  assert(!tree.split('\n').includes(f.mediaPath));
  assert(tree.includes('second-commit.txt'));
  assert(git(f.remote, ['show', f.main() + ':README.md']).toString().includes(f.uploads[0].url));
  assert.match(git(f.remote, ['show', '-s', '--format=%an <%ae>', f.main()]).toString(), /github-actions\[bot\]/);
  assert(f.requests.every(url => !url.endsWith('/user')));
  assert(f.pushes[0].includes(`--force-with-lease=refs/heads/main:${f.mergeSHA}`));
});

for (const timing of ['before rerun', 'during upload', 'during push']) test(`cleanup preserves intervening commits when main advances ${timing}`, async t => {
  const f = await fixture(t);
  let advancedSHA: string | undefined;
  const advance = async () => { advancedSHA = await f.commit({ 'intervening.txt': 'Preserve this later merge\n' }); };
  if (timing === 'before rerun') await advance();
  if (timing === 'during upload') {
    const transfer = f.options.transfer;
    f.options.transfer = async (lock, bytes) => {
      await transfer(lock, bytes);
      if (!advancedSHA) await advance();
    };
  }
  if (timing === 'during push') f.beforePush(advance);
  const result = await publishMergedPullRequestMedia(42, f.mergeSHA, f.baseSHA, f.options);
  assert.equal(result.cleanup, true);
  assert.equal(result.sourceSHA, f.main());
  assert.equal(git(f.remote, ['rev-parse', f.main() + '^']).toString().trim(), advancedSHA);
  assert.equal(git(f.remote, ['show', f.main() + ':intervening.txt']).toString(), 'Preserve this later merge\n');
  assert.equal(f.uploads.length, timing === 'before rerun' ? 1 : 2);
  // A repeated run reuses the sanitized tree without writing another commit.
  const again = await publishMergedPullRequestMedia(42, f.mergeSHA, f.baseSHA, f.options);
  assert.equal(again.cleanup, false);
  assert.equal(again.sourceSHA, result.sourceSHA);
});

test('upload or permission failures leave main unchanged and cannot publish a success SHA', async t => {
  const f = await fixture(t);
  await assert.rejects(publishMergedPullRequestMedia(42, f.mergeSHA, f.baseSHA, { ...f.options,
    transfer: async () => { throw Error('R2 unavailable'); },
  }), /R2 unavailable/);
  assert.equal(f.main(), f.mergeSHA);
  assert.equal(f.pushes.length, 0);
  await assert.rejects(publishMergedPullRequestMedia(42, f.mergeSHA, f.baseSHA, { ...f.options,
    createGit: async cwd => {
      const run = await f.options.createGit(cwd);
      return async (args, input) => {
        if (args[0] === 'push') throw Error('Write permission denied');
        return run(args, input);
      };
    },
  }), /Write permission denied/);
  assert.equal(f.main(), f.mergeSHA);
});

test('catalog publication is a reusable dependent job pinned to successful cleanup output', async () => {
  const cleanup = await readFile(new URL('../.github/workflows/publish-merged-media.yml', import.meta.url), 'utf8');
  const catalog = await readFile(new URL('../.github/workflows/publish-template-catalog.yml', import.meta.url), 'utf8');
  assert.match(cleanup, /BASE_SHA: \$\{\{ github.event.pull_request.base.sha \}\}/);
  assert.match(cleanup, /catalog:\n\s+needs: publish\n\s+uses: .\/\.github\/workflows\/publish-template-catalog.yml/);
  assert.match(cleanup, /source_sha: \$\{\{ needs.publish.outputs.source_sha \}\}/);
  assert.match(catalog, /workflow_call:/);
  assert.doesNotMatch(catalog, /^\s+(?:push|workflow_dispatch):/m);
  assert.match(catalog, /ref: \$\{\{ inputs.source_sha \}\}/);
  assert.match(catalog, /ref: \$\{\{ github.workflow_sha \}\}/);
  assert.match(catalog, /GITHUB_SHA: \$\{\{ inputs.source_sha \}\}/);
  assert.match(catalog, /node "\$GITHUB_WORKSPACE\/\.github\/scripts\/publish-template-catalog.mjs" main/);
});
