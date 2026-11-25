import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './fixtures.ts';
import { gatewayFor } from '../gateway/service.ts';
import { mediaUse } from '../gateway/media-use.ts';
import { uuid } from '../tracking/core.ts';
import { transport } from './http.ts';
import { pluginRoot } from '../hyperframes.ts';

for (const plan of ['free', 'go'] as const) {
  test(`${plan} inspect returns an attributed console link without account intents or opening a browser`, t => fixture(async store => {
    const gateway = gatewayFor(store);
    gateway.options.detect = async () => [];
    t.after(() => gateway.close());
    t.mock.method(gateway.account, 'summary', async () => ({ state: 'signed-in', plan, billingUnavailable: false }));
    // A signed-in production account must still return a credential-free console link.
    await mkdir(gateway.account.home, { recursive: true });
    await writeFile(path.join(store.directory, 'account/session.json'), JSON.stringify({ id: 'test-session' }));
    await writeFile(path.join(gateway.account.home, 'config.json'), JSON.stringify({ profiles: { prod: {
      apiUrl: 'https://amr-api.open-design.ai', user: { id: 'fixture-user' },
      controlKey: 'test-control', controlKeyId: 'test-id', runtimeKey: 'test-runtime',
    } } }));
    t.mock.method(gateway.account, 'mediaModels', async () => []);
    const fetcher = t.mock.fn(async () => Response.json({ intentId: 'must-not-be-exposed' }));
    gateway.account.options.fetcher = fetcher;
    const openCloudUrl = gateway.account.openCloudUrl.bind(gateway.account);
    t.mock.method(gateway.account, 'openCloudUrl', async (...args: Parameters<typeof openCloudUrl>) => {
      assert.equal(args[2], false, 'inspect must never launch a browser');
      return openCloudUrl(...args);
    });
    const checkAttribution = (url: string, entryId: string) => {
      const target = new URL(url), params = target.searchParams;
      assert.equal(target.origin + target.pathname, 'https://open-design.ai/cloud/dashboard');
      assert.deepEqual([...params.keys()].sort(), ['billing', 'od_entry_at', 'od_entry_id', 'od_entry_source', 'od_origin', 'utm_medium', 'utm_source']);
      assert.equal(params.get('billing'), 'plan');
      assert.equal(params.get('od_origin'), 'openmotion');
      assert.equal(params.get('od_entry_source'), 'openmotion_manage_subscription');
      assert.equal(params.get('utm_source'), 'openmotion');
      assert.equal(params.get('utm_medium'), 'agent');
      assert.equal(params.get('od_entry_id'), entryId);
      assert.equal(new Date(params.get('od_entry_at')!).toISOString(), params.get('od_entry_at'));
    };
    const result = await mediaUse(store, { action: 'inspect' });
    assert.ok(result.upgrade);
    assert.match(result.upgrade.entryId, uuid);
    assert.equal(result.upgrade.plan, 'plus');
    assert.match(result.upgrade.instruction, /clickable.*Upgrade to Plus \/ 升级到 Plus.*inspect again after payment.*original request/);
    checkAttribution(result.upgrade.url, result.upgrade.entryId);
    assert.equal(fetcher.mock.callCount(), 0, 'inspect must never request an account intent');
    assert.equal(result.settingsHandoff.arguments.entry, `agent_media_upgrade_${plan}`);
    assert.doesNotMatch(JSON.stringify(result), /test-control|test-runtime|fixture-user/);

    // Re-inspection creates a fresh attribution ID without creating credentials.
    const next = await mediaUse(store, { action: 'inspect' });
    assert.ok(next.upgrade);
    assert.notEqual(next.upgrade.entryId, result.upgrade.entryId);
    checkAttribution(next.upgrade.url, next.upgrade.entryId);
    assert.equal(fetcher.mock.callCount(), 0);
  }));
}

test('included, signed-out, rejected-key and usable alternative routes do not generate upgrade links', t => fixture(async store => {
  const gateway = gatewayFor(store);
  gateway.options.detect = async () => [];
  t.after(() => gateway.close());
  let state = 'signed-out', plan = 'plus';
  t.mock.method(gateway.account, 'summary', async () => ({ state, plan, billingUnavailable: false }));
  const open = t.mock.method(gateway.account, 'openCloudUrl', async () => { throw new Error('Must not generate an upgrade link'); });
  const inspect = async (entry?: string) => {
    const result = await mediaUse(store, { action: 'inspect' });
    assert.equal(Object.hasOwn(result, 'upgrade'), false);
    assert.equal(Object.hasOwn(result, '_upgradeLinkResult'), false);
    assert.deepEqual(result.settingsHandoff, entry === 'agent_media_signed_out'
      ? { tool: 'openmotion_media_use', arguments: { action: 'sign_in' } }
      : { tool: 'openmotion_open_preview', arguments: { target: 'providers', ...(entry ? { entry } : {}) } });
  };
  await inspect('agent_media_signed_out');
  state = 'signed-in';
  await inspect();
  state = 'signed-out';
  await gateway.configureProvider('atlascloud', { apiKey: 'test-key' });
  await gateway.connections.verifyKey('atlascloud', 'test-key', 'rejected');
  await inspect('agent_media_key_rejected');
  state = 'signed-in'; plan = 'go';
  await gateway.connections.verifyKey('atlascloud', 'test-key', 'verified');
  await inspect();
  assert.equal(open.mock.callCount(), 0);
}));

test('upgrade URL exceptions preserve the settings handoff without returning upgrade', t => fixture(async store => {
  const gateway = gatewayFor(store);
  gateway.options.detect = async () => [];
  t.after(() => gateway.close());
  t.mock.method(gateway.account, 'summary', async () => ({ state: 'signed-in', plan: 'go', billingUnavailable: false }));
  t.mock.method(gateway.account, 'openCloudUrl', async () => { throw new Error('private-account-error'); });
  const result = await mediaUse(store, { action: 'inspect' });
  assert.equal(Object.hasOwn(result, 'upgrade'), false);
  assert.deepEqual(result.settingsHandoff.arguments, { target: 'providers', entry: 'agent_media_upgrade_go' });
  assert.deepEqual(result._upgradeLinkResult, { entry_from: 'agent_media_upgrade_go', outcome: 'failure' });
  assert.doesNotMatch(JSON.stringify(result), /private-account-error/);
}));

function clock(start = 0) {
  let time = start;
  return { now: () => time, sleep: async (ms: number) => { time += ms; }, advance: (ms: number) => { time += ms; } };
}

async function signedInCredentials(store: Parameters<typeof gatewayFor>[0]) {
  const account = gatewayFor(store).account;
  await mkdir(account.home, { recursive: true });
  await writeFile(path.join(store.directory, 'account/session.json'), JSON.stringify({ id: 'private-session' }));
  await writeFile(path.join(account.home, 'config.json'), JSON.stringify({ profiles: { prod: {
    apiUrl: 'https://amr-api.open-design.ai', user: { id: 'private-user', email: 'private@example.com' },
    controlKey: 'private-control', controlKeyId: crypto.randomUUID(), runtimeKey: 'private-runtime',
  } } }));
}

const signedIn = (plan = 'plus') => ({ state: 'signed-in' as const, plan, billingUnavailable: false, consoleUrl: 'https://open-design.ai/cloud' });

test('sign_in uses mcp_oauth, waits briefly for the link/code and never returns account details', t => fixture(async store => {
  const gateway = gatewayFor(store), time = clock();
  t.after(() => gateway.close());
  let reads = 0;
  t.mock.method(gateway.account, 'summary', async () => ++reads === 1 ? { state: 'signed-out' } : {
    state: 'authorizing', authorizationUrl: 'https://open-design.ai/activate', userCode: 'ABCD', browserOpened: true,
    user: { email: 'private@example.com' }, controlKey: 'private-control', attempt: { id: 'private-attempt', stages: [] },
  });
  const login = t.mock.method(gateway.account, 'login', async () => ({ state: 'authorizing' }));
  const entryId = crypto.randomUUID();
  const result = await mediaUse(store, { action: 'sign_in', entryId }, undefined, time);
  assert.deepEqual(login.mock.calls[0].arguments, [{ hookId: 'mcp_oauth', entryId }]);
  assert.equal(result.signIn.state, 'authorizing');
  assert.equal(result.signIn.authorizationUrl, 'https://open-design.ai/activate');
  assert.equal(result.signIn.userCode, 'ABCD');
  assert.equal(result.signIn.browserOpened, true);
  assert.equal(result.next.arguments.action, 'wait_sign_in');
  assert.equal(time.now(), 1000);
  assert.doesNotMatch(JSON.stringify(result), /private-|email|controlKey|attempt/);
  assert.match(result.signIn.instruction, /do not ask the user to confirm in chat/);
}));

test('sign_in skips login for an existing session and bounds the initial link wait to eight seconds', t => fixture(async store => {
  const gateway = gatewayFor(store), time = clock();
  t.after(() => gateway.close());
  let summary: any = signedIn(' Plus ');
  t.mock.method(gateway.account, 'summary', async () => summary);
  const login = t.mock.method(gateway.account, 'login', async () => summary);
  assert.equal((await mediaUse(store, { action: 'sign_in' }, undefined, time)).signIn.state, 'ready');
  assert.equal(login.mock.callCount(), 0);
  summary = { state: 'authorizing' };
  const result = await mediaUse(store, { action: 'sign_in' }, undefined, time);
  assert.equal(result.signIn.state, 'authorizing');
  assert.equal(time.now(), 8000);
  time.advance(1000);
  await mediaUse(store, { action: 'sign_in' }, undefined, { ...time, signInWaitMs: 20, pollMs: 5 });
  assert.equal(time.now(), 9020);
}));

test('wait_sign_in bounds authorizing polls, retains the link/code and does not refresh billing while signing in', t => fixture(async store => {
  const gateway = gatewayFor(store), time = clock();
  t.after(() => gateway.close());
  const summary = t.mock.method(gateway.account, 'summary', async () => ({ state: 'authorizing', authorizationUrl: 'https://example.com/activate', userCode: 'ABCD' }));
  const result = await mediaUse(store, { action: 'wait_sign_in' }, undefined, time);
  assert.equal(result.signIn.state, 'authorizing');
  assert.equal(result.signIn.userCode, 'ABCD');
  assert.equal(result.next.arguments.action, 'wait_sign_in');
  assert.equal(time.now(), 50_000);
  assert.ok(summary.mock.calls.every(call => call.arguments[0] !== true));
  await mediaUse(store, { action: 'wait_sign_in', timeoutSeconds: 500 }, undefined, time);
  assert.equal(time.now(), 110_000, 'direct service calls are capped at 60 seconds');
  await assert.rejects(mediaUse(store, { action: 'wait_sign_in', timeoutSeconds: -1 }, undefined, time), /INVALID_ARGUMENT/);
}));

test('wait_sign_in waits for model sync and billing, then returns ready with normalized plan or unavailable billing', t => fixture(async store => {
  const gateway = gatewayFor(store), time = clock();
  t.after(() => gateway.close());
  let value: any = { ...signedIn('Plus'), syncing: true };
  let syncing = true;
  const summary = t.mock.method(gateway.account, 'summary', async (refresh?: boolean) => {
    if (syncing && time.now() >= 2000) { value = signedIn(' Plus '); syncing = false; }
    return value;
  });
  const ready = await mediaUse(store, { action: 'wait_sign_in' }, undefined, time);
  assert.equal(time.now(), 2000);
  assert.equal(ready.signIn.state, 'ready');
  assert.equal(ready.signIn.plan, 'plus');
  assert.equal(ready.signIn.mediaEntitlement, 'included');
  assert.equal(ready.next.arguments.action, 'inspect');
  assert.ok(summary.mock.calls.every(call => call.arguments[0] !== true));
  value = { state: 'signed-in', billingUnavailable: true };
  assert.equal((await mediaUse(store, { action: 'wait_sign_in' }, undefined, time)).signIn.state, 'ready');
  value = { state: 'signed-in', billingUnavailable: false };
  const pending = await mediaUse(store, { action: 'wait_sign_in', timeoutSeconds: 1 }, undefined, clock());
  assert.equal(pending.signIn.state, 'authorizing', 'missing billing must not falsely report ready');
}));

for (const code of ['authorization_expired', 'connector_unavailable'] as const) {
  test(`wait_sign_in reports ${code} without leaking profile data`, t => fixture(async store => {
    const gateway = gatewayFor(store);
    t.after(() => gateway.close());
    t.mock.method(gateway.account, 'summary', async () => ({ state: 'reauth-required', errorCode: code, error: 'Sign-in failed',
      ...(code === 'connector_unavailable' ? { connectorInstall: { command: 'npm install --prefix /tmp/account vela' } } : {}), user: { email: 'private@example.com' } }));
    const result = await mediaUse(store, { action: 'wait_sign_in' }, undefined, clock());
    assert.equal(result.signIn.state, 'failed');
    assert.equal(result.signIn.errorCode, code);
    assert.equal(result.signIn.error, 'Sign-in failed');
    assert.equal(Boolean(result.signIn.connectorInstall), code === 'connector_unavailable');
    assert.doesNotMatch(JSON.stringify(result), /email|private@example/);
    assert.equal(result.next, null);
  }));
}

test('wait_sign_in reports signed_out with a direct sign_in next action when no login is running', t => fixture(async store => {
  const gateway = gatewayFor(store);
  t.after(() => gateway.close());
  t.mock.method(gateway.account, 'summary', async () => ({ state: 'signed-out' }));
  const result = await mediaUse(store, { action: 'wait_sign_in' }, undefined, clock());
  assert.equal(result.signIn.state, 'signed_out');
  assert.deepEqual(result.next, { tool: 'openmotion_media_use', arguments: { action: 'sign_in' } });
}));

for (const plan of ['free', 'go']) {
  test(`${plan} login opens an intent URL once, keeps a credential-free fallback and observes payment`, t => fixture(async store => {
    const gateway = gatewayFor(store), time = clock(), opened: string[] = [], billingTimes: number[] = [];
    t.after(() => gateway.close());
    await signedInCredentials(store);
    let paid = false;
    t.mock.method(gateway.account, 'summary', async (refresh?: boolean) => {
      if (refresh) billingTimes.push(time.now());
      return time.now() < 1000 ? { state: 'authorizing' } : signedIn(paid && refresh ? 'plus' : plan);
    });
    const fetcher = t.mock.fn(async () => Response.json({ intentId: 'browser-only-intent' }));
    gateway.account.options.fetcher = fetcher;
    const options = { ...time, openBrowser: async (url: string) => { opened.push(url); } };
    const result = await mediaUse(store, { action: 'wait_sign_in', timeoutSeconds: 21 }, undefined, options);
    assert.equal(result.signIn.state, 'awaiting_payment');
    assert.equal(result.signIn.upgrade.opened, true);
    assert.equal(result.signIn.upgrade.plan, 'plus');
    assert.match(result.signIn.upgrade.entryId, uuid);
    assert.equal(opened.length, 1);
    assert.match(opened[0], /\/login\?intentId=browser-only-intent/);
    const safe = new URL(result.signIn.upgrade.url);
    assert.equal(safe.pathname, '/cloud/dashboard');
    assert.equal(safe.searchParams.get('od_origin'), 'openmotion');
    assert.equal(safe.searchParams.get('od_entry_source'), 'openmotion_manage_subscription');
    assert.equal(safe.searchParams.get('od_entry_id'), result.signIn.upgrade.entryId);
    assert.equal(safe.searchParams.get('utm_medium'), 'agent');
    assert.doesNotMatch(JSON.stringify(result), /intentId|browser-only-intent|private-|email|controlKey|\/login/);
    assert.equal(result._upgradeLinkResult.entry_from, 'agent_sign_in_upgrade');
    assert.equal(result._upgradeLinkResult.browser_opened, true);
    assert.deepEqual(billingTimes, [1000, 11000]);
    const again = await mediaUse(store, { action: 'wait_sign_in', timeoutSeconds: 1 }, undefined, options);
    assert.equal(opened.length, 1);
    assert.equal(again.signIn.upgrade.entryId, result.signIn.upgrade.entryId);
    assert.equal(Object.hasOwn(again, '_upgradeLinkResult'), false);
    paid = true;
    time.advance(10_000);
    assert.equal((await mediaUse(store, { action: 'wait_sign_in' }, undefined, options)).signIn.state, 'ready');
    assert.equal(opened.length, 1);
    time.advance(30 * 60_000);
    paid = false;
    await mediaUse(store, { action: 'wait_sign_in', timeoutSeconds: 1 }, undefined, options);
    assert.equal(opened.length, 2, 'a later account visit may open again after 30 minutes');
    assert.equal(fetcher.mock.callCount(), 2);
  }));
}

test('open_upgrade always opens explicitly, seeds the wait guard, and returns states when no upgrade is needed', t => fixture(async store => {
  const gateway = gatewayFor(store), time = clock();
  t.after(() => gateway.close());
  let summary: any = signedIn('free');
  t.mock.method(gateway.account, 'summary', async () => summary);
  t.mock.method(gateway.account, 'getControlSession', async () => null);
  const open = t.mock.fn(async () => {});
  const options = { ...time, openBrowser: open };
  const first = await mediaUse(store, { action: 'open_upgrade' }, undefined, options);
  const second = await mediaUse(store, { action: 'open_upgrade' }, undefined, options);
  assert.equal(open.mock.callCount(), 2);
  assert.equal(first.upgrade.opened, true);
  assert.notEqual(first.upgrade.entryId, second.upgrade.entryId);
  assert.doesNotMatch(JSON.stringify(second), /intentId|\/login/);
  await mediaUse(store, { action: 'wait_sign_in', timeoutSeconds: 1 }, undefined, options);
  assert.equal(open.mock.callCount(), 2);
  summary = signedIn('plus');
  assert.equal((await mediaUse(store, { action: 'open_upgrade' }, undefined, options)).state, 'ready');
  summary = { state: 'signed-out' };
  assert.equal((await mediaUse(store, { action: 'open_upgrade' }, undefined, options)).state, 'signed_out');
  assert.equal(open.mock.callCount(), 2);
}));

test('browser launch failure retains the safe checkout link and reports browser_opened=false', t => fixture(async store => {
  const gateway = gatewayFor(store);
  t.after(() => gateway.close());
  t.mock.method(gateway.account, 'summary', async () => signedIn('free'));
  t.mock.method(gateway.account, 'getControlSession', async () => null);
  const result = await mediaUse(store, { action: 'wait_sign_in', timeoutSeconds: 1 }, undefined, {
    ...clock(), openBrowser: async () => { throw new Error('private-browser-error'); },
  });
  assert.equal(result.signIn.upgrade.opened, false);
  assert.equal(result._upgradeLinkResult.browser_opened, false);
  assert.match(result.signIn.instruction, /could not be opened automatically/);
  assert.doesNotMatch(JSON.stringify(result), /private-browser-error/);
}));

test('concurrent waits across shared account workspaces open checkout only once', t => fixture(async firstStore => fixture(async secondStore => {
  const first = gatewayFor(firstStore), second = gatewayFor(secondStore);
  t.after(async () => { await first.close(); await second.close(); });
  const id = crypto.randomUUID(), browser = t.mock.fn(async () => {});
  for (const gateway of [first, second]) {
    t.mock.method(gateway.account, 'summary', async () => signedIn('free'));
    t.mock.method(gateway.account, 'getControlSession', async () => ({ controlKeyId: id }));
  }
  const results = await Promise.all([firstStore, secondStore].map(store => mediaUse(store,
    { action: 'wait_sign_in', timeoutSeconds: 1 }, undefined, { ...clock(), openBrowser: browser })));
  assert.equal(browser.mock.callCount(), 1);
  assert.equal(results.filter(result => result._upgradeLinkResult).length, 1);
  assert.equal(results[0].signIn.upgrade.entryId, results[1].signIn.upgrade.entryId);
})));

test('stdio MCP tracks automatic and explicit checkout only, stripping metadata and all credential URLs', t => fixture(async store => {
  const { rpc } = await import('../mcp.ts');
  const { createTracker } = await import('../tracking/core.ts');
  const { omEvents } = await import('../tracking/events.ts');
  const events: any[] = [];
  const tracking = createTracker({ registry: omEvents, entrypoint: 'mcp', enabled: true, flushIntervalMs: 0,
    send: async batch => { events.push(...batch); return 'accepted'; } });
  store.tracking = tracking;
  const gateway = gatewayFor(store);
  t.after(async () => { await gateway.close(); tracking.close(); });
  t.mock.method(gateway.account, 'summary', async () => signedIn('free'));
  t.mock.method(gateway.account, 'getControlSession', async () => null);
  t.mock.method(gateway.account, 'openCloudUrl', async (_path, _source, launch, attribution) => ({
    url: launch === false ? 'https://open-design.ai/cloud/dashboard?billing=plan&od_entry_id=' + attribution?.entryId
      : 'https://open-design.ai/cloud/login?intentId=private-browser-intent',
    opened: launch !== false,
  }));
  const http = transport(store, { tracking, runtimeRoot: pluginRoot });
  const callPhase1 = async (payload: any) => {
    const response = await http('/motion-api/phase1/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const call = (action: string) => rpc({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call',
    params: { name: 'openmotion_media_use', arguments: { action, timeoutSeconds: 1 } } }, store, undefined, undefined, undefined, { callPhase1 });
  for (const action of ['wait_sign_in', 'wait_sign_in', 'open_upgrade']) {
    const result: any = await call(action);
    assert.equal(result.result.isError, undefined);
    assert.doesNotMatch(JSON.stringify(result), /_upgradeLinkResult|intentId|controlKey|email/);
  }
  await tracking.flush();
  const upgrades = events.filter(event => event.event === 'upgrade_link_result');
  assert.equal(upgrades.length, 2, 'automatic wait emits once and explicit checkout emits again');
  for (const event of upgrades) assert.deepEqual(event.properties, {
    entry_from: 'agent_sign_in_upgrade', entry_id: event.properties.entry_id, outcome: 'success', browser_opened: true,
  });
  // A direct service / WebMCP call does not produce the MCP-only event.
  await callPhase1({ name: 'openmotion_media_use', arguments: { action: 'open_upgrade' } });
  await tracking.flush();
  assert.equal(events.filter(event => event.event === 'upgrade_link_result').length, 2);
}));

test('slow account reads cannot overrun wait_sign_in or open checkout after its deadline', t => fixture(async store => {
  const gateway = gatewayFor(store);
  t.after(() => gateway.close());
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(gateway.account, 'summary', async () => { await delayed; return signedIn('free'); });
  const open = t.mock.method(gateway.account, 'openCloudUrl', async () => { throw new Error('Must not launch after timeout'); });
  const result = await mediaUse(store, { action: 'wait_sign_in', timeoutSeconds: 0.01 });
  assert.equal(result.signIn.state, 'authorizing');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(open.mock.callCount(), 0);
}));

test('a slow account identity lookup cannot launch checkout after wait_sign_in times out', t => fixture(async store => {
  const gateway = gatewayFor(store);
  t.after(() => gateway.close());
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(gateway.account, 'summary', async () => signedIn('free'));
  t.mock.method(gateway.account, 'getControlSession', async () => { await delayed; return null; });
  const open = t.mock.method(gateway.account, 'openCloudUrl', async () => { throw new Error('Must not launch after timeout'); });
  const result = await mediaUse(store, { action: 'wait_sign_in', timeoutSeconds: 0.01 });
  assert.equal(result.signIn.state, 'awaiting_payment');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(open.mock.callCount(), 0);
}));

test('capability discovery forwards the direct signed-out Agent handoff', t => fixture(async store => {
  const gateway = gatewayFor(store);
  t.after(() => gateway.close());
  gateway.options.detect = async () => [];
  t.mock.method(gateway.account, 'summary', async () => ({ state: 'signed-out' }));
  const http = transport(store, { runtimeRoot: pluginRoot });
  for (const action of ['providers', 'list']) {
    const response = await http('/motion-api/phase1/call', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'openmotion_capability_discover', arguments: { action } }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.settingsHandoff, { tool: 'openmotion_media_use', arguments: { action: 'sign_in' } });
  }
}));

for (const plan of ['free', 'go']) {
  test(`waitFor=account accepts ${plan} without checkout, billing refresh or upgrade telemetry`, t => fixture(async store => {
    const gateway = gatewayFor(store), time = clock();
    t.after(() => gateway.close());
    let syncing = true;
    const summary = t.mock.method(gateway.account, 'summary', async () => ({ ...signedIn(plan), syncing: syncing && time.now() < 1000 }));
    const open = t.mock.method(gateway.account, 'openCloudUrl', async () => { throw new Error('Account sign-in must not open checkout'); });
    const result = await mediaUse(store, { action: 'wait_sign_in', waitFor: 'account' }, undefined, time);
    assert.equal(time.now(), 1000, 'account mode still waits for model synchronization');
    assert.equal(result.signIn.state, 'ready');
    assert.equal(result.signIn.plan, plan);
    assert.equal(result.signIn.mediaEntitlement, 'not-included');
    assert.equal(Object.hasOwn(result, '_upgradeLinkResult'), false);
    assert.equal(open.mock.callCount(), 0);
    assert.ok(summary.mock.calls.every(call => call.arguments[0] !== true));
    syncing = false;
    summary.mock.restore();
    t.mock.method(gateway.account, 'summary', async () => ({ state: 'signed-in' }));
    assert.equal((await mediaUse(store, { action: 'wait_sign_in', waitFor: 'account' }, undefined, time)).signIn.state, 'ready', 'account mode does not require billing to be loaded');
  }));
}

test('sign_in and repeated waits preserve an explicit waitFor in the next arguments', t => fixture(async store => {
  const gateway = gatewayFor(store);
  t.after(() => gateway.close());
  let state: any = { state: 'signed-out' };
  t.mock.method(gateway.account, 'summary', async () => state);
  t.mock.method(gateway.account, 'login', async () => ({ state: 'authorizing', authorizationUrl: 'https://example.com/activate' }));
  for (const waitFor of ['account', 'media']) {
    const result = await mediaUse(store, { action: 'sign_in', waitFor }, undefined, clock());
    assert.deepEqual(result.next.arguments, { action: 'wait_sign_in', waitFor });
    const signedOut = await mediaUse(store, { action: 'wait_sign_in', waitFor }, undefined, clock());
    assert.deepEqual(signedOut.next.arguments, { action: 'sign_in', waitFor });
  }
  state = { state: 'authorizing' };
  const pending = await mediaUse(store, { action: 'wait_sign_in', waitFor: 'account', timeoutSeconds: 1 }, undefined, clock());
  assert.deepEqual(pending.next.arguments, { action: 'wait_sign_in', waitFor: 'account' });
  await assert.rejects(mediaUse(store, { action: 'wait_sign_in', waitFor: 'invalid' }, undefined, clock()), /INVALID_ARGUMENT/);
}));

test('an intent that resolves after timeout does not consume the automatic checkout retry', t => fixture(async store => {
  const gateway = gatewayFor(store), opened: string[] = [];
  t.after(() => gateway.close());
  await signedInCredentials(store);
  t.mock.method(gateway.account, 'summary', async () => signedIn('free'));
  let release!: () => void;
  const slowIntent = new Promise<void>(resolve => { release = resolve; });
  let intentStarted!: () => void;
  const started = new Promise<void>(resolve => { intentStarted = resolve; });
  let requests = 0;
  gateway.account.options.fetcher = async () => {
    if (++requests === 1) { intentStarted(); await slowIntent; }
    return Response.json({ intentId: 'browser-only-intent' });
  };
  const openBrowser = async (url: string) => { opened.push(url); };
  const firstCall = mediaUse(store, { action: 'wait_sign_in', timeoutSeconds: 0.1 }, undefined, { openBrowser });
  await started;
  const first = await firstCall;
  assert.equal(opened.length, 0);
  assert.equal(Object.hasOwn(first, '_upgradeLinkResult'), false);
  // Retry while the first intent is still pending; completion must evict the skipped reservation.
  const retry = mediaUse(store, { action: 'wait_sign_in', timeoutSeconds: 1 }, undefined, { ...clock(Date.now()), openBrowser });
  release();
  const second = await retry;
  assert.equal(opened.length, 1);
  assert.equal(requests, 2);
  assert.equal(second.signIn.upgrade.opened, true);
  assert.equal(second._upgradeLinkResult.browser_opened, true);
  assert.doesNotMatch(JSON.stringify(second), /intentId|browser-only-intent/);
}));

for (const planAfterTimeout of ['free', 'plus']) {
  test(`a later ${planAfterTimeout} wait claims a completed checkout result once after the creator timed out`, t => fixture(async store => {
    const gateway = gatewayFor(store), opened: string[] = [];
    t.after(() => gateway.close());
    await signedInCredentials(store);
    let plan = 'free';
    t.mock.method(gateway.account, 'summary', async () => signedIn(plan));
    gateway.account.options.fetcher = async () => Response.json({ intentId: 'browser-only-intent' });
    let release!: () => void, didOpen!: () => void;
    const launchPending = new Promise<void>(resolve => { release = resolve; });
    const launched = new Promise<void>(resolve => { didOpen = resolve; });
    const openBrowser = async (url: string) => { opened.push(url); didOpen(); await launchPending; };
    const firstCall = mediaUse(store, { action: 'wait_sign_in', timeoutSeconds: 0.1 }, undefined, { openBrowser });
    await launched;
    const first = await firstCall;
    assert.equal(Object.hasOwn(first, '_upgradeLinkResult'), false);
    assert.equal(opened.length, 1);
    plan = planAfterTimeout;
    release();
    const options = { ...clock(Date.now()), openBrowser };
    const second = await mediaUse(store, { action: 'wait_sign_in', timeoutSeconds: 1 }, undefined, options);
    assert.equal(second._upgradeLinkResult?.entry_from, 'agent_sign_in_upgrade');
    assert.equal(second._upgradeLinkResult?.browser_opened, true);
    const third = await mediaUse(store, { action: 'wait_sign_in', timeoutSeconds: 1 }, undefined, options);
    assert.equal(Object.hasOwn(third, '_upgradeLinkResult'), false);
    assert.equal(opened.length, 1);
  }));
}
