import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { candidateFixture } from './release-fixture.mjs';
import { runFile } from '../scripts/runtime-assets.mjs';
import { candidateWorkflow, repository, releaseInputs, findCandidate, downloadCandidate, verifyDownloaded, recordAuthorization, publishNpm } from '../.github/scripts/motion-release.mjs';

test('publication requires a safe accepted build ID; unique legacy recovery stays compatible', async t => {
  const f = await candidateFixture(t, 'main', { version: '0.1.0' });
  assert.equal(releaseInputs(f.env).candidateRunId, '123');
  for (const id of [undefined, '', '0', '-1', '01', '1.5', '../123', '123?x=y', '123\n', ' 123', '9007199254740992', 123]) {
    assert.throws(() => releaseInputs({ ...f.env, MOTION_CANDIDATE_RUN_ID: id }), /build run ID/);
  }
  assert.equal(releaseInputs({ ...f.env, MOTION_RELEASE_ACTION: 'archive-only', MOTION_CANDIDATE_RUN_ID: '' }).candidateRunId, undefined);
  await assert.rejects(recordAuthorization(f.directory, { ...f.inputs, candidateRunId: '124' }, async () => { throw Error('must not request authorization'); }, f.env), /selection differs/);
  await assert.rejects(recordAuthorization(f.directory, { ...f.inputs, candidateRunId: '124' }, async () => { throw Error('must not request authorization'); }, { ...f.env, MOTION_CANDIDATE_RUN_ID: '124' }), /accepted build run ID/);
});

test('selected build lookup never falls back on a missing, expired, ambiguous or foreign artifact', async () => {
  const artifact = { id: 456, name: 'motion-candidate-0.1.0', expired: false, workflow_run: { id: 123 } };
  const lookup = artifacts => async url => {
    assert.equal(new URL(url).pathname, `/repos/${repository}/actions/runs/123/artifacts`);
    return Response.json({ total_count: artifacts.length, artifacts });
  };
  assert.equal((await findCandidate('0.1.0', lookup([artifact]), '123')).id, 456);
  for (const artifacts of [[], [{ ...artifact, expired: true }], [{ ...artifact, name: 'motion-candidate-0.1.1' }], [artifact, { ...artifact, id: 457 }], [{ ...artifact, workflow_run: { id: 124 } }]]) {
    await assert.rejects(findCandidate('0.1.0', lookup(artifacts), '123'));
  }
  await assert.rejects(findCandidate('0.1.0', async () => Response.json({ total_count: 101, artifacts: [artifact] }), '123'), /incomplete/);
  for (const id of ['0', '../123', '9007199254740992']) await assert.rejects(findCandidate('0.1.0', async () => { throw Error('must not fetch'); }, id), /safe integer/);
});

test('two 0.1.0 candidates keep distinct bytes and publication consumes the selected accepted build', async t => {
  const accepted = await candidateFixture(t, 'main', { version: '0.1.0', runId: 123 });
  const newer = await candidateFixture(t, 'main', { version: '0.1.0', runId: 124, skills: ['openmotion-new-feature'] });
  assert.notEqual(accepted.candidate.tgzSHA256, newer.candidate.tgzSHA256);
  const entries = new Map();
  for (const f of [accepted, newer]) {
    const zip = path.join(f.work, 'candidate.zip');
    await runFile('zip', ['-j', zip, ...['candidate.json', ...Object.keys(f.candidate.files)].map(name => path.join(f.directory, name))]);
    const bytes = await readFile(zip), id = f.candidate.workflow.runId;
    entries.set(String(id), { f, bytes, artifact: { id: id + 1000, name: 'motion-candidate-0.1.0', expired: false, workflow_run: { id },
      digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), size_in_bytes: bytes.length } });
  }
  const fetcher = async (url, options) => {
    const parsed = new URL(url), route = parsed.pathname;
    if (parsed.hostname === 'signed.example.invalid') {
      assert.equal(options.headers, undefined, 'Never forward GitHub credentials to artifact storage');
      return new Response(entries.get(route.slice(1)).bytes);
    }
    if (route.endsWith('/actions/artifacts')) return Response.json({ total_count: 2, artifacts: [...entries.values()].map(x => x.artifact) });
    const match = route.match(/\/actions\/runs\/(123|124)(\/artifacts)?$/);
    if (match) {
      const entry = entries.get(match[1]);
      if (match[2]) return Response.json({ total_count: 1, artifacts: [entry.artifact] });
      return Response.json({ id: Number(match[1]), run_attempt: 1, event: 'workflow_dispatch', head_branch: 'main', head_sha: entry.f.candidate.workflow.sha,
        head_repository: { full_name: repository }, path: candidateWorkflow, status: 'completed', conclusion: 'success' });
    }
    const entry = [...entries.entries()].find(([, x]) => route.endsWith(`/artifacts/${x.artifact.id}/zip`));
    assert(entry, 'Unexpected API route');
    return new Response(null, { status: 302, headers: { location: `https://signed.example.invalid/${entry[0]}` } });
  };
  await assert.rejects(downloadCandidate('0.1.0', path.join(accepted.work, 'ambiguous'), undefined, fetcher), /found 2/);
  const directory = path.join(accepted.work, 'selected');
  const chosen = await downloadCandidate('0.1.0', directory, accepted.candidate.tgzSHA256, fetcher, '123');
  assert.equal(chosen.workflow.runId, 123); assert.equal(chosen.tgzSHA256, accepted.candidate.tgzSHA256);
  const chosenNewer = await downloadCandidate('0.1.0', path.join(newer.work, 'selected'), newer.candidate.tgzSHA256, fetcher, '124');
  assert.equal(chosenNewer.workflow.runId, 124); assert.equal(chosenNewer.tgzSHA256, newer.candidate.tgzSHA256);
  await verifyDownloaded(directory, chosen.tgzSHA256, '0.1.0', '123');
  await assert.rejects(verifyDownloaded(directory, chosen.tgzSHA256, '0.1.0', '124'), /accepted build run ID/);
  await assert.rejects(downloadCandidate('0.1.0', path.join(accepted.work, 'wrong-hash'), accepted.candidate.tgzSHA256, fetcher, '124'));
  for (const patch of [{ conclusion: 'failure' }, { status: 'in_progress' }, { path: '.github/workflows/other.yml' }, { head_repository: { full_name: 'foreign/repo' } }, { head_branch: 'codex/unreviewed' }]) {
    await assert.rejects(downloadCandidate('0.1.0', path.join(accepted.work, 'untrusted'), undefined, async (url, options) => {
      const response = await fetcher(url, options);
      return String(url).endsWith('/runs/123') ? Response.json({ ...await response.json(), ...patch }) : response;
    }, '123'));
  }
  let writes = 0;
  await assert.rejects(publishNpm(accepted.directory, accepted.inputs, { env: accepted.env,
    fetcher: async () => Response.json({ versions: { '0.1.0': { dist: { integrity: newer.candidate.integrity } } }, 'dist-tags': {} }),
    run: async () => { writes++; },
  }), /different bytes/);
  assert.equal(writes, 0, 'Selecting a new build must never overwrite an already published npm version');
});
