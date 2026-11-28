import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkSourceUpdate } from '../scripts/check-source-update.mjs';

test('a clean official checkout gives update guidance once per day without moving HEAD', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'motion-update-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'Initial checkout');
  git('remote', 'add', 'origin', 'https://github.com/nexu-io/openmotion.git');
  const head = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', head);
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ status: 'ahead' }); };
  const now = Date.now();
  assert.match(await checkSourceUpdate({ cwd, fetcher, now }), /git pull --ff-only/);
  assert.equal(await checkSourceUpdate({ cwd, fetcher, now: now + 1 }), undefined);
  await writeFile(join(cwd, 'work-in-progress'), 'local edits');
  assert.equal(await checkSourceUpdate({ cwd, fetcher, now: now + 86_400_000 }), undefined);
  assert.equal(calls, 1);
  assert.equal(git('rev-parse', 'HEAD'), head);
});
