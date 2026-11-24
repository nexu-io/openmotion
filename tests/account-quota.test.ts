import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OpenDesignAccount } from '../gateway/account.ts';
import { productionApi } from '../gateway/opendesign.ts';

const profile = { apiUrl: productionApi, user: { id: 'quota-user' }, controlKey: 'quota-control', controlKeyId: 'quota-key', runtimeKey: 'quota-runtime' };
const personal = { workspaceId: 'personal', workspaceType: 'personal', role: 'owner' };
const resetsAt = '2026-11-25T12:00:00Z';
const window = (kind: '5h' | '7d' = '5h', remainingCredits = '80', limitCredits = '100') => ({ kind, remainingCredits, limitCredits, windowStart: null, resetsAt });
const snapshot = (workspaceId = 'personal', windows: unknown = [window()]) => ({ schemaVersion: 1, workspaceId, designPlanWindows: windows });

async function setup(t: TestContext, apiUrl = productionApi) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motion-account-quota-'));
  const account = new OpenDesignAccount(directory, { run: async () => '{}' });
  t.after(async () => { account.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(account.root, path.join(directory, 'account'));
  await mkdir(account.home, { recursive: true });
  await writeFile(path.join(account.root, 'session.json'), JSON.stringify({ id: 'quota-session' }));
  const saveProfile = (changes = {}) => writeFile(path.join(account.home, 'config.json'), JSON.stringify({ profiles: { prod: { ...profile, apiUrl, ...changes } } }));
  await saveProfile();
  const requests: { url: string; init: RequestInit }[] = [];
  const responses = {
    workspaces: () => Response.json({ items: [personal] }),
    snapshot: () => Response.json(snapshot()),
    billing: () => Response.json({ membershipTier: 'pro', balanceUsd: '12.34', totalAvailableCreditsUsd: '56.78' }),
  };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === productionApi + '/api/v1/billing/summary') return responses.billing();
    if (url === productionApi + '/api/v1/workspaces') return responses.workspaces();
    if (url.includes('/billing/snapshot?')) return responses.snapshot();
    throw new Error('Unexpected request: ' + url);
  });
  return { account, responses, requests, saveProfile };
}

function assertBilling(summary: Awaited<ReturnType<OpenDesignAccount['summary']>>) {
  assert.equal(summary.state, 'signed-in');
  assert.equal(summary.billingUnavailable, false);
  assert.equal(summary.billingError, undefined);
  assert.equal(summary.plan, 'pro');
  assert.equal(summary.balance, '56.78');
}

test('default workspace wins and quota uses the tightest rounded window', async t => {
  const { account, responses, requests } = await setup(t);
  responses.workspaces = () => Response.json({ items: [personal, { workspaceId: 'team/default', workspaceType: 'team', role: 'member', isDefault: true }] });
  responses.snapshot = () => Response.json(snapshot('team/default', [window('5h', '90'), window('7d', '2', '3')]));
  const timeouts: number[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeouts.push(ms); return timeout(ms); });
  const summary = await account.summary(true);
  assertBilling(summary);
  assert.deepEqual(summary.quota, { kind: '7d', remainingPercent: 67, resetsAt });
  assert.equal(requests.at(-1)?.url, productionApi + '/api/v1/workspaces/team%2Fdefault/billing/snapshot?workspaceId=team%2Fdefault');
  assert.equal(requests.length, 3);
  for (const { init } of requests) {
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer quota-control');
    assert.equal(init.redirect, 'error');
    assert(init.signal instanceof AbortSignal);
  }
  assert.deepEqual(timeouts, [15_000, 15_000]);
  summary.quota!.remainingPercent = 0;
  assert.equal((await account.summary()).quota?.remainingPercent, 67);
  assert.equal(requests.length, 3, 'ordinary summaries reuse cached quota');
});

test('without a default workspace, use the first personal owner', async t => {
  const { account, responses, requests } = await setup(t);
  responses.workspaces = () => Response.json({ items: [
    { workspaceId: 'viewer', workspaceType: 'personal', role: 'viewer' },
    { workspaceId: 'team', workspaceType: 'team', role: 'owner' },
    { ...personal, isDefault: 'true' },
    { ...personal, workspaceId: 'later-owner' },
  ] });
  assert.deepEqual((await account.summary(true)).quota, { kind: '5h', remainingPercent: 80, resetsAt });
  assert(requests.some(({ url }) => url.endsWith('/personal/billing/snapshot?workspaceId=personal')));
});

test('quota rounding stays exact for half ties and credits beyond Number precision', async t => {
  const { account, responses } = await setup(t);
  for (const [remaining, limit, percent] of [
    ['99', '200', 50], ['989999999999999999', '2000000000000000000', 49], ['0', '100', 0], ['100', '100', 100],
  ] as const) {
    responses.snapshot = () => Response.json(snapshot('personal', [{ ...window('5h', remaining, limit), resetsAt: null }]));
    assert.deepEqual((await account.summary(true)).quota, { kind: '5h', remainingPercent: percent, resetsAt: null });
  }
  responses.snapshot = () => Response.json(snapshot('personal', [window('7d', '90'), window('5h', '10')]));
  assert.equal((await account.summary(true)).quota?.kind, '5h');
});

test('quota read failures do not affect billing or authentication', async t => {
  const cases: [string, (state: Awaited<ReturnType<typeof setup>>) => void][] = [
    ['snapshot 500', ({ responses }) => { responses.snapshot = () => new Response(null, { status: 500 }); }],
    ['snapshot 401', ({ responses }) => { responses.snapshot = () => new Response(null, { status: 401 }); }],
    ['network error', ({ responses }) => { responses.snapshot = () => { throw new TypeError('offline'); }; }],
    ['timeout', ({ responses }) => { responses.snapshot = () => { throw new DOMException('timeout', 'TimeoutError'); }; }],
    ['snapshot invalid JSON', ({ responses }) => { responses.snapshot = () => new Response('{'); }],
    ['workspaces 500', ({ responses }) => { responses.workspaces = () => new Response(null, { status: 500 }); }],
    ['workspaces 401', ({ responses }) => { responses.workspaces = () => new Response(null, { status: 401 }); }],
    ['workspaces 403', ({ responses }) => { responses.workspaces = () => new Response(null, { status: 403 }); }],
    ['workspaces invalid JSON', ({ responses }) => { responses.workspaces = () => new Response('{'); }],
    ['no eligible workspace', ({ responses }) => { responses.workspaces = () => Response.json({ items: [{ workspaceId: 'team', workspaceType: 'team', role: 'owner' }] }); }],
    ['empty workspaces', ({ responses }) => { responses.workspaces = () => Response.json({ items: [] }); }],
    ['invalid workspace ID', ({ responses }) => { responses.workspaces = () => Response.json({ items: [{ ...personal, workspaceId: null }] }); }],
  ];
  for (const [name, configure] of cases) await t.test(name, async t => {
    const state = await setup(t);
    configure(state);
    const summary = await state.account.summary(true);
    assertBilling(summary);
    assert.equal(Object.hasOwn(summary, 'quota'), false);
    if (name.includes('workspace')) assert.equal(state.requests.length, 2, 'do not request a snapshot without a usable workspace list');
  });
});

test('any malformed snapshot or window discards the entire quota', async t => {
  const valid = window();
  const cases: [string, unknown][] = [
    ['schema version', { ...snapshot(), schemaVersion: 2 }],
    ['workspace mismatch', snapshot('other')],
    ['missing windows', { schemaVersion: 1, workspaceId: 'personal' }],
    ['non-array windows', snapshot('personal', {})],
    ['empty windows', snapshot('personal', [])],
    ...[
      null, { ...valid, kind: '1d' }, { ...valid, remainingCredits: 80 }, { ...valid, remainingCredits: '01' },
      { ...valid, remainingCredits: '-1' }, { ...valid, remainingCredits: '1.5' }, { ...valid, limitCredits: '0' },
      { ...valid, limitCredits: '01' }, { ...valid, limitCredits: 100 }, { ...valid, remainingCredits: '101' },
      { ...valid, resetsAt: 123 }, { ...valid, resetsAt: '2026-02-29T00:00:00Z' },
      { ...valid, windowStart: undefined }, { ...valid, windowStart: 'invalid' },
    ].map((bad, index): [string, unknown] => ['invalid window ' + index, snapshot('personal', [window('7d'), bad])]),
    ['duplicate kind', snapshot('personal', [valid, valid])],
  ];
  for (const [name, payload] of cases) await t.test(name, async t => {
    const { account, responses } = await setup(t);
    responses.snapshot = () => Response.json(payload);
    const summary = await account.summary(true);
    assertBilling(summary);
    assert.equal(Object.hasOwn(summary, 'quota'), false);
  });
});

test('a failed refresh clears previously cached quota only', async t => {
  const { account, responses } = await setup(t);
  assert((await account.summary(true)).quota);
  responses.snapshot = () => new Response(null, { status: 500 });
  const summary = await account.summary(true);
  assertBilling(summary);
  assert.equal(summary.quota, undefined);
  assert.equal((await account.summary()).quota, undefined);
});

test('non-production environments never request workspaces or snapshots', async t => {
  const { account, requests } = await setup(t, 'https://amr-api.example.test');
  account.options.run = async args => {
    assert.deepEqual(args, ['billing', 'summary', '--format', 'json']);
    return JSON.stringify({ membershipTier: 'pro', totalAvailableCreditsUsd: '56.78' });
  };
  const summary = await account.summary(true);
  assertBilling(summary);
  assert.equal(summary.quota, undefined);
  assert.deepEqual(requests, []);
});

test('quota is scoped to the control key and cleared on sign-out', async t => {
  const { account, saveProfile } = await setup(t);
  assert((await account.summary(true)).quota);
  await saveProfile({ controlKeyId: 'other-key', controlKey: 'other-control' });
  assert.equal((await account.summary()).quota, undefined);
  assert((await account.summary(true)).quota);
  assert.equal((await account.logout()).quota, undefined);
  const signedOut = await account.summary(true);
  assert.equal(signedOut.state, 'signed-out');
  assert.equal(Object.hasOwn(signedOut, 'quota'), false);
  await saveProfile();
  await writeFile(path.join(account.root, 'session.json'), JSON.stringify({ id: 'new-session' }));
  assert.equal((await account.summary()).quota, undefined, 'sign-out cleared the old cache');
});

test('late quota responses cannot overwrite a newer refresh or sign-out', async t => {
  const { account, responses } = await setup(t);
  const stale = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const original = responses.snapshot;
  let first = true;
  // Fetch mocks may also return a pending response, just like the real transport.
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/billing/summary')) return responses.billing();
    if (url.endsWith('/workspaces')) return responses.workspaces();
    if (first) { first = false; started.resolve(); return stale.promise; }
    return original();
  });
  const pending = account.summary(true);
  await started.promise;
  assert.equal((await account.summary(true)).quota?.remainingPercent, 80);
  stale.resolve(Response.json(snapshot('personal', [window('5h', '1')])));
  assert.equal((await pending).quota?.remainingPercent, 80);
  assert.equal((await account.summary()).quota?.remainingPercent, 80);

  const late = Promise.withResolvers<Response>();
  const requested = Promise.withResolvers<void>();
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/billing/summary')) return responses.billing();
    if (url.endsWith('/workspaces')) return responses.workspaces();
    requested.resolve(); return late.promise;
  });
  const signingOut = account.summary(true);
  await requested.promise;
  await account.logout();
  late.resolve(Response.json(snapshot()));
  assert.equal((await signingOut).state, 'signed-out');
  assert.equal((await account.summary()).quota, undefined);
});
