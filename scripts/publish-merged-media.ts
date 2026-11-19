import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isMain } from '../shared/entry.ts';
import { boundedMediaBody, mediaDigest, type MediaLock } from '../shared/repository-media.ts';
import { lfsPointer } from '../shared/repository-template-catalog.ts';
import { prepareMediaCleanup, publishMedia, commitCleanup, type TreeFile } from './prepare-pr-media.ts';

const repository = 'nexu-io/openmotion';
const sha = /^[a-f0-9]{40}$/;

async function github(route: string, token: string, request: typeof fetch): Promise<any> {
  const response = await request('https://api.github.com/repos/' + repository + '/' + route, {
    headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json' },
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `GitHub GET ${route} failed: HTTP ${response.status}`);
  return response.json();
}

async function readBlob(file: TreeFile, token: string, commit: string, request: typeof fetch): Promise<Buffer> {
  const response = await request(`https://api.github.com/repos/${repository}/git/blobs/${file.sha}`, {
    headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github.raw+json' },
    redirect: 'error', signal: AbortSignal.timeout(120_000),
  });
  assert(response.ok, `GitHub blob unavailable at ${commit}: ${file.path}`);
  const bytes = await boundedMediaBody(response, Math.max(file.size, 1024));
  assert.equal(bytes.length, file.size, `GitHub blob size changed: ${file.path}`);
  return bytes;
}

async function readLfs(lock: MediaLock, token: string, request: typeof fetch): Promise<Buffer> {
  const response = await request(`https://github.com/${repository}.git/info/lfs/objects/batch`, {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from('x-access-token:' + token).toString('base64'), 'content-type': 'application/vnd.git-lfs+json', accept: 'application/vnd.git-lfs+json' },
    body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [{ oid: lock.sha256, size: lock.bytes }] }),
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, 'Cannot resolve merged LFS media');
  const batch: any = await response.json(), action = batch.objects?.[0]?.actions?.download;
  assert(action, 'Merged LFS object is unavailable');
  const url = new URL(action.href);
  assert(url.protocol === 'https:' && /(?:\.githubusercontent\.com|\.amazonaws\.com)$/.test(url.hostname) && !url.username && !url.password, 'Unexpected LFS download origin');
  const bytes = await boundedMediaBody(await request(url, { headers: action.header, redirect: 'error', signal: AbortSignal.timeout(120_000) }), lock.bytes);
  assert.equal(bytes.length, lock.bytes); assert.equal(mediaDigest(bytes), lock.sha256);
  return bytes;
}

async function tree(commit: string, token: string, request: typeof fetch): Promise<TreeFile[]> {
  const result = await github(`git/trees/${commit}?recursive=1`, token, request);
  assert(!result.truncated, 'GitHub tree is truncated; split the merged change');
  return result.tree;
}

async function gitRunner(directory: string, token: string) {
  return async (args: string[], input?: string) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args], {
      cwd: directory, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token).toString('base64') },
    });
    if (input !== undefined) child.stdin.end(input);
    const chunks: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk))); child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)));
    const code = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', value => resolve(value ?? 1)); });
    assert.equal(code, 0, errors.join('') || 'Git operation failed');
    return Buffer.concat(chunks).toString().trim();
  };
}

export async function publishMergedPullRequestMedia(pullNumber: number, mergeSHA: string, baseSHA: string, {
  token = process.env.GITHUB_TOKEN || process.env.OPENMOTION_MEDIA_MAINTAINER_TOKEN,
  endpoint = process.env.MOTION_R2_ENDPOINT || 'https://64ad4569ffd912432d6b86d5656484c4.r2.cloudflarestorage.com',
  bucket = process.env.MOTION_R2_BUCKET || 'open-design-releases',
  request = fetch,
  createGit = gitRunner,
  transfer = publishMedia,
} = {}) {
  assert(Number.isSafeInteger(pullNumber) && pullNumber > 0 && sha.test(mergeSHA) && sha.test(baseSHA), 'Require a merged PR number and full merge/base SHAs');
  assert(token, 'Missing GitHub token');
  const base = await tree(baseSHA, token, request);
  const directory = await mkdtemp(path.join(tmpdir(), 'openmotion-postmerge-media-'));
  try {
    const git = await createGit(directory, token);
    await git(['-c', 'init.templateDir=', 'init', '-q']);
    // Validation diffs against the PR base even in final-tree mode. Fetch it
    // explicitly: a depth-one fetch of main does not include its parent.
    await git(['fetch', '--depth=1', `https://github.com/${repository}.git`, baseSHA]);
    assert.equal(await git(['rev-parse', 'FETCH_HEAD']), baseSHA);
    for (let attempt = 0; attempt < 3; attempt++) {
      const main = await github('git/ref/heads/main', token, request);
      const sourceSHA = main.object?.sha;
      assert(sha.test(sourceSHA || ''), 'Invalid main head');
      const ancestry = await github(`compare/${mergeSHA}...${sourceSHA}`, token, request);
      assert(['ahead', 'identical'].includes(ancestry.status), 'Merged PR is no longer on main');
      const head = await tree(sourceSHA, token, request);
      // Compare the live tree with the PR's pre-merge base, not the last
      // rebased commit's parent. This includes every PR commit and preserves
      // subsequent merges when rerunning a delayed or interrupted cleanup.
      const plan = await prepareMediaCleanup({ head, base, sourceSHA, pullNumber, forcePaths: /^library\/skills\// },
        file => readBlob(file, token!, sourceSHA, request), async (lock, raw) => {
          const bytes = lfsPointer(raw) ? await readLfs(lock, token!, request) : raw;
          await transfer(lock, bytes, { endpoint, bucket });
        });
      if (!plan.media.length) return { pullNumber, mergeSHA, baseSHA, media: 0, cleanup: false, sourceSHA };
      // An intervening merge requires a new plan; never replay stale metadata.
      if ((await github('git/ref/heads/main', token, request)).object?.sha !== sourceSHA) continue;
      await git(['fetch', '--depth=1', `https://github.com/${repository}.git`, sourceSHA]);
      assert.equal(await git(['rev-parse', 'FETCH_HEAD']), sourceSHA);
      const cleanupSHA = await commitCleanup(plan, git, directory, { login: 'github-actions[bot]', id: 41898282 }, baseSHA);
      try {
        await git(['push', `--force-with-lease=refs/heads/main:${sourceSHA}`, `https://github.com/${repository}.git`, `${cleanupSHA}:refs/heads/main`]);
      } catch (error) {
        if ((await github('git/ref/heads/main', token, request)).object?.sha === sourceSHA) throw error;
        continue;
      }
      return { pullNumber, mergeSHA, baseSHA, media: plan.media.length, cleanup: true, sourceSHA: cleanupSHA };
    }
    throw new Error('main kept advancing during cleanup; rerun to replan against its current head');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (isMain(import.meta.url)) {
  const [number, mergeSHA, baseSHA, extra] = process.argv.slice(2);
  assert(!extra, 'Usage: publish-merged-media.ts <PR-number> <merge-sha> <base-sha>');
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  const result = await publishMergedPullRequestMedia(Number(number), mergeSHA, baseSHA);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `source_sha=${result.sourceSHA}\n`);
  console.log(JSON.stringify(result, null, 2));
}
