import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classifyLoadFailure,
  createIncidentId,
  probeConnectivity,
} from '../src/startup-health.ts';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('createIncidentId yields a short reference without look-alike characters', () => {
  assert.equal(createIncidentId(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7])), 'ABCD-EFGH');
  assert.equal(createIncidentId(Uint8Array.from([255, 254, 253, 252, 31, 30, 29, 28])), 'HGFE-A987');
  const seen = new Set();
  for (let index = 0; index < 200; index += 1) {
    const id = createIncidentId();
    assert.match(id, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    seen.add(id);
  }
  assert.equal(seen.size, 200);
});

test('classifyLoadFailure separates timeouts, network failures and everything else', () => {
  assert.deepEqual(classifyLoadFailure('NET_TIMEOUT'), { outcome: 'timeout', network: true });
  assert.deepEqual(classifyLoadFailure('NET_ERR_INTERNET_DISCONNECTED'), {
    outcome: 'network_error',
    network: true,
  });
  assert.deepEqual(classifyLoadFailure('LOAD_FAILED'), { outcome: 'network_error', network: true });
  assert.deepEqual(classifyLoadFailure('RENDERER_CRASHED'), { outcome: 'error', network: false });
  assert.deepEqual(classifyLoadFailure(undefined), { outcome: 'error', network: false });
});

test('probeConnectivity tells an offline machine from an unreachable Studio', async () => {
  const calls = [];
  const reachable = await probeConnectivity('https://releases.example.com/stable.json', async (url, init) => {
    calls.push([url, init.method, init.cache]);
    return { status: 403 };
  });
  // Any HTTP answer, even a refusal, proves the network path works.
  assert.equal(reachable, 'studio_unreachable');
  assert.deepEqual(calls, [['https://releases.example.com/stable.json', 'HEAD', 'no-store']]);

  assert.equal(
    await probeConnectivity('https://releases.example.com/stable.json', async () => {
      throw new TypeError('net::ERR_INTERNET_DISCONNECTED');
    }),
    'offline',
  );

  const startedAt = Date.now();
  const hung = await probeConnectivity(
    'https://releases.example.com/stable.json',
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    30,
  );
  assert.equal(hung, 'offline');
  assert.ok(Date.now() - startedAt < 2_000);
});

test('the retry page shows the reference that the shell reported the failure under', () => {
  const retryHtml = readFileSync(path.join(desktopRoot, 'src', 'retry.html'), 'utf8');
  assert.match(retryHtml, /params\.get\('incident'\)/);
  assert.match(retryHtml, /'Ref: ' \+ info\.incident\.trim\(\)/);

  const main = readFileSync(path.join(desktopRoot, 'src', 'main.ts'), 'utf8');
  const showRetryPage = main.slice(main.indexOf('async function showRetryPage('), main.indexOf('async function showRetryPage(') + 1400);
  // Every caller goes through here, so a failure cannot reach the user unreported or unnumbered.
  assert.match(showRetryPage, /reportLoadFailure\(\{ code: info\.code, detail: info\.detail, incidentId \}\)/);
  assert.match(showRetryPage, /query\.incident = incidentId/);
});
