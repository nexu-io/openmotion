import test from 'node:test';
import { mediaBytes } from './media-fixtures.ts';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './fixtures.ts';
import { gatewayFor, ModelGateway } from '../gateway/service.ts';
import { ProviderConnections, connectionBaseUrl } from '../gateway/connections.ts';
import { AccountRequestError, OpenDesignAccount, type SignInRecord } from '../gateway/account.ts';
import { createTracker, validProperties } from '../tracking/core.ts';
import { createPosthogSender } from '../tracking/node.ts';
import { omEvents } from '../tracking/events.ts';
import { providerDirectory, setDefaultModel } from '../gateway/settings.ts';
import { mediaUse } from '../gateway/media-use.ts';
import { AssetLibrary } from '../gateway/asset-library.ts';
import { Phase1Service } from '../phase1.ts';
import { pluginRoot } from '../hyperframes.ts';
import type { Fetcher } from '../gateway/network.ts';
import { providerRegistry, mediaProviders, registeredProvider } from '../shared/provider-registry.ts';
import { providerAdapters } from '../gateway/providers.ts';
import { transport } from './http.ts';
import { callTool } from '../mcp.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
const binary = fileURLToPath(new URL('./fixtures/account-cli.mjs', import.meta.url));
async function until(check: () => Promise<boolean>) { for (let n = 0; n < 500; n++) { if (await check()) return; await delay(20); } throw new Error('Fixture timed out'); }
async function finish(store: any, id: string) { const g = gatewayFor(store); await g.tick(); await Promise.all([...g.active.values()].map(task => task.done)); return g.getJob(id); }
async function signIn(account: OpenDesignAccount) {
  await account.login(); await until(async () => Boolean((await account.summary()).authorizationUrl));
  await writeFile(path.join(account.home, 'authorize'), 'yes');
  await until(async () => (await account.summary()).state === 'signed-in');
}

test('one registry supplies the settings directory and every dedicated media adapter', () => fixture(async store => {
  const gateway = gatewayFor(store); gateway.options.detect = async () => [];
  assert.equal(new Set(providerRegistry.map(provider => provider.id)).size, providerRegistry.length);
  assert.deepEqual(Object.keys(providerAdapters).sort(), [...mediaProviders].sort());
  const directory = await providerDirectory(gateway);
  assert.deepEqual(directory.providers.map(provider => provider.id).sort(), providerRegistry.map(provider => provider.id).sort());
  for (const provider of directory.providers) {
    const definition = registeredProvider(provider.id)!;
    assert.equal(provider.label, definition.label);
    assert.equal(provider.baseUrlEditable, definition.baseUrlEditable);
    assert.equal(provider.website, definition.website);
    if (definition.integration === 'media') assert.equal(provider.docs, `/motion-api/models/providers/${provider.id}/reference`);
  }
  await gateway.close();
}));

test('legacy files retain credentials, models and defaults across shared HTTP, MCP and configuration writes', () => fixture(async store => {
  const gateway = gatewayFor(store); gateway.options.detect = async () => [];
  const root = gateway.root, custom = 'custom-existing';
  const model = { id: 'openai:picture', provider: 'openai', modelId: 'picture', label: 'Saved picture', kind: 'image', enabled: true, source: 'custom' };
  const files = {
    'config.json': { version: 1, providers: { codex: { enabled: false }, fal: { enabled: true, verification: 'verified', keyHash: createHash('sha256').update('legacy-fal-key').digest('hex'), checkedAt: 123 }, opendesign: { baseUrl: 'https://cloud.example', enabled: true } },
      routes: { image: 'openai:picture' }, customModels: [{ id: 'fal:saved-model', provider: 'fal', modelId: 'saved-model', label: 'Saved media', modality: 'video', mode: 'text-to-video', source: 'custom' }] },
    'secrets.json': { fal: 'legacy-fal-key', opendesign: 'legacy-cloud-key' },
    'connections.json': { providers: { openai: { enabled: true }, [custom]: { custom: true, label: 'Saved endpoint', protocol: 'openai', baseUrl: 'https://saved.example/v1', enabled: true, revision: 'saved-revision' } },
      models: [model, { id: custom + ':language', provider: custom, modelId: 'language', label: 'Saved language', kind: 'text', enabled: true, source: 'custom' }],
      defaults: { text: custom + ':language' }, modelOverrides: { 'fal:saved-model': { group: 'Saved group', defaults: { duration: 5 } } } },
    'connection-secrets.json': { openai: 'legacy-openai-key', [custom]: 'legacy-custom-key' },
  };
  await mkdir(root, { recursive: true });
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, file), JSON.stringify(content), { mode: 0o600 });
  const before = await Promise.all(Object.keys(files).map(file => readFile(path.join(root, file), 'utf8')));
  const previous = process.env.FAL_KEY; process.env.FAL_KEY = 'environment-fal-key';
  try {
    const request = transport(store), directory = await (await request('/motion-api/settings/providers')).json();
    assert.equal(directory.defaults.image, model.id); assert.equal(directory.defaults.text, custom + ':language');
    assert.equal(directory.models.find((row: any) => row.id === 'fal:saved-model').group, 'Saved group');
    assert.equal(directory.providers.find((row: any) => row.id === 'opendesign').baseUrl, 'https://cloud.example');
    assert.equal((await gateway.status()).providers.find(provider => provider.id === 'fal')!.verification, 'verified');
    assert.equal(await gateway.connections.credential('fal'), 'legacy-fal-key');
    assert.equal(await gateway.connections.credential(custom), 'legacy-custom-key');
    assert.equal(await gateway.connections.identity(custom), 'saved-revision');
    assert.deepEqual(await Promise.all(Object.keys(files).map(file => readFile(path.join(root, file), 'utf8'))), before, 'Reading old configuration must not rewrite it');
    assert.doesNotMatch(JSON.stringify(directory), /legacy-.*-key|environment-fal-key/);
    const publicFields = new Set(['id', 'label', 'protocol', 'baseUrl', 'kinds', 'category', 'website', 'docs', 'group', 'region', 'setupRequired', 'baseUrlEditable', 'configured', 'enabled', 'available', 'custom', 'credentialSource', 'reason']);
    for (const provider of [...directory.providers, ...await gateway.connections.list()]) {
      assert.deepEqual(Object.keys(provider).filter(key => !publicFields.has(key)), [], `${provider.id} must contain only public connection fields`);
    }

    const update = await request('/motion-api/settings/providers/fal', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'replacement-fal-key' }) });
    assert.equal(update.status, 200); assert.doesNotMatch(await update.text(), /replacement-fal-key/);
    assert.equal(await gateway.connections.credential('fal'), 'replacement-fal-key');
    assert.equal((await gateway.status()).providers.find(provider => provider.id === 'fal')!.verification, 'unverified');
    await callTool('openmotion_configure_provider', { provider: 'openai', apiKey: 'replacement-openai-key' }, store);
    assert.equal(await gateway.connections.credential('openai'), 'replacement-openai-key');
    const cleared = await request('/motion-api/models/providers/fal', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: null }) });
    assert.equal(cleared.status, 200);
    assert.equal((await gateway.status()).providers.find(provider => provider.id === 'fal')!.credentialSource, 'environment');
    assert.equal(await gateway.connections.credential('fal'), 'environment-fal-key');
    await gateway.connections.setDefault('image', model.id);
    await gateway.connections.setDefault('text', custom + ':language');
    const restarted = new ModelGateway(store, { detect: async () => [] });
    assert.equal((await restarted.status()).routes.image, model.id);
    assert.deepEqual(await restarted.connections.defaults(), { image: model.id, text: custom + ':language' });
    assert.equal((await restarted.config()).customModels[0].id, 'fal:saved-model');
    assert.equal(await restarted.connections.credential('opendesign'), 'legacy-cloud-key');
    assert.equal(await restarted.connections.credential(custom), 'legacy-custom-key');
    assert.equal((await stat(path.join(root, 'secrets.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(root, 'connection-secrets.json'))).mode & 0o777, 0o600);
    await assert.rejects(restarted.connections.configure('codex', { apiKey: 'must-not-save' }), /own local login/);
    await assert.rejects(restarted.connections.configure('account', { apiKey: 'must-not-save' }), /account sign-in/);
    await assert.rejects(restarted.connections.configure('fal', { baseUrl: 'https://other.example' }), /built-in API origin/);
    await restarted.close();
  } finally {
    if (previous === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = previous;
    await gateway.close();
  }
}));

test('a queued legacy media job uses its existing credential and adapter after restart', () => fixture(async store => {
  const root = path.join(store.directory, 'model-gateway'), id = randomUUID();
  await mkdir(path.join(root, 'jobs'), { recursive: true });
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ version: 1, providers: { fal: { enabled: true } }, routes: {}, customModels: [] }));
  await writeFile(path.join(root, 'secrets.json'), JSON.stringify({ fal: 'queued-legacy-key' }));
  await writeFile(path.join(root, 'jobs', id + '.json'), JSON.stringify({ id, projectId: store.projectId, state: 'queued', modality: 'image', prompt: 'saved request',
    model: { id: 'fal:fal-ai/flux/schnell', provider: 'fal', modelId: 'fal-ai/flux/schnell', label: 'FLUX Schnell', modality: 'image', mode: 'text-to-image', source: 'builtin' },
    parameters: {}, requestHash: 'existing-hash', createdAt: 1, updatedAt: 1, phase: 'queued', assets: [] }));
  let submissions = 0;
  const gateway = new ModelGateway(store, { detect: async () => [], pollMs: 1, download: async () => png, fetcher: async (url, init = {}) => {
    assert.equal(new Headers(init.headers).get('Authorization'), 'Key queued-legacy-key');
    if (init.method === 'POST') { submissions++; return Response.json({ request_id: 'existing-task', status_url: 'https://queue.fal.run/task/status', response_url: 'https://queue.fal.run/task/result' }); }
    return Response.json(String(url).endsWith('status') ? { status: 'COMPLETED' } : { images: [{ url: 'https://cdn.example/image.png' }] });
  } });
  try {
    await gateway.tick(); await Promise.all([...gateway.active.values()].map(task => task.done));
    const job = await gateway.getJob(id);
    assert.equal(job.state, 'completed', job.error); assert.equal(submissions, 1);
    assert.deepEqual(await readFile(path.join(store.projectDirectory, job.assets[0].path)), png);
    await gateway.tick(); assert.equal(submissions, 1);
  } finally { await gateway.close(); }
}));

test('provider registry is searchable configuration; custom keys stay private and media routes execute once', () => fixture(async store => {
  const gateway = gatewayFor(store); gateway.options.detect = async () => [];
  let submissions = 0;
  const fetcher: Fetcher = async (url, init = {}) => {
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer synthetic-custom-key');
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'language' }, { id: 'picture', architecture: { output_modalities: ['image'] } }] });
    assert.equal(String(url), 'https://provider.example/prefix/v1/images/generations');
    assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(String(init.body)), { model: 'picture', prompt: 'cup' });
    submissions++; return Response.json({ data: [{ b64_json: png.toString('base64') }] });
  };
  gateway.options.fetcher = fetcher; gateway.connections = new ProviderConnections(store, fetcher);
  const id = await gateway.connections.configure(null, { label: 'My provider', protocol: 'openai', baseUrl: 'https://provider.example/prefix/v1/', apiKey: 'synthetic-custom-key' });
  await gateway.connections.sync(id);
  const directory = await providerDirectory(gateway);
  assert(directory.providers.length >= 70); assert.equal(directory.models.find(m => m.id === id + ':picture')?.kind, 'image');
  assert.doesNotMatch(JSON.stringify(directory), /synthetic-custom-key/);
  assert.equal((await stat(path.join(gateway.root, 'connection-secrets.json'))).mode & 0o777, 0o600);
  await setDefaultModel(gateway, 'image', id + ':picture');
  assert.equal((await providerDirectory(gateway)).defaults.image, id + ':picture');
  const guide = await mediaUse(store, { action: 'reference', provider: id }); assert.match(guide.content, /images\/generations/);
  const args = { action: 'generate', provider: id, model: 'picture', projectId: store.projectId, modality: 'image', prompt: 'cup', requestId: 'only-once' };
  const first = await mediaUse(store, args); const completed = await finish(store, first.job.id);
  assert.equal(completed.state, 'completed', completed.error); assert.equal(submissions, 1);
  assert.deepEqual(await readFile(path.join(store.projectDirectory, completed.assets[0].path)), png);
  assert.equal((await mediaUse(store, args)).job.id, first.job.id);
  await assert.rejects(gateway.connections.configure(id, { baseUrl: 'https://different.example/v1' }), /API key again/);
  const queued = await gateway.submit({ model: id + ':picture', modality: 'image', prompt: 'pending' });
  await gateway.connections.configure(id, { apiKey: 'replacement-key' });
  assert.match((await finish(store, queued.id)).error!, /configuration changed/); assert.equal(submissions, 1);
  await gateway.connections.updateModel(id + ':picture', false);
  await assert.rejects(setDefaultModel(gateway, 'image', id + ':picture'), /enabled model/);
  await gateway.connections.remove(id);
  assert(!(await gateway.connections.list()).some(provider => provider.id === id));
  assert(!JSON.parse(await readFile(path.join(gateway.root, 'connection-secrets.json'), 'utf8'))[id]);
  await gateway.close();
}));

for (const protocol of ['anthropic', 'google']) test(`${protocol} catalogue uses correct auth/pagination and keeps manual models`, () => fixture(async store => {
  let page = 0;
  const connections = new ProviderConnections(store, async (url, init) => {
    page++; const headers = new Headers(init?.headers);
    assert.equal(headers.get(protocol === 'google' ? 'x-goog-api-key' : 'x-api-key'), 'synthetic-key'); assert.equal(headers.get('Authorization'), null);
    if (page === 2) assert.match(String(url), protocol === 'google' ? /pageToken=next/ : /after_id=next/);
    return Response.json(protocol === 'google' ? { models: [{ name: 'models/model-' + page, displayName: 'Model ' + page }], ...(page === 1 ? { nextPageToken: 'next' } : {}) }
      : { data: [{ id: 'model-' + page }], has_more: page === 1, last_id: 'next' });
  });
  const id = await connections.configure(null, { label: 'API', protocol, baseUrl: 'https://models.example/v1', apiKey: 'synthetic-key' });
  await connections.saveModel(id, { modelId: 'manual', label: 'Manual', kind: 'text' });
  await connections.sync(id); assert.equal(page, 2); assert.equal((await connections.models()).length, 3);
}));

test('unsafe custom endpoints and failed catalogue sync cannot leak keys or erase configured models', () => fixture(async store => {
  for (const url of ['http://public.example/v1', 'https://127.0.0.1/v1', 'https://10.0.0.1/v1', 'https://user:secret@public.example/v1', 'https://public.example/v1?key=secret']) assert.throws(() => connectionBaseUrl(url));
  const connections = new ProviderConnections(store, async () => Response.json({ error: 'synthetic-secret' }, { status: 401 }));
  const id = await connections.configure(null, { label: 'API', protocol: 'openai', baseUrl: 'https://models.example/v1', apiKey: 'synthetic-secret' });
  await connections.saveModel(id, { modelId: 'manual', label: 'Manual', kind: 'image' });
  await assert.rejects(connections.sync(id), error => { assert.doesNotMatch(String(error), /synthetic-secret/); return true; });
  assert.equal((await connections.models()).length, 1);
}));

test('account device authorization, billing, remote models and all media outputs use the same isolated session', t => fixture(async store => {
  await chmod(binary, 0o755);
  const gateway = gatewayFor(store); gateway.options.detect = async () => [];
  const account = gateway.account = new OpenDesignAccount(store.directory, { binary, pollMs: 1 });
  t.after(() => gateway.close());
  await mkdir(account.home, { recursive: true });
  await Promise.all((['video', 'audio'] as const).map(async kind => writeFile(path.join(account.home, `fixture-${kind}`), await mediaBytes(kind))));
  assert.equal((await account.summary()).state, 'signed-out');
  await signIn(account);
  const summary = await account.summary(true);
  assert.equal(summary.plan, 'pro'); assert.equal(summary.balance, '12.50'); assert.doesNotMatch(JSON.stringify(summary), /synthetic-private/);
  assert.equal(summary.errorCode, undefined); assert.equal(summary.attempt?.receipt, 'accepted'); assert.equal(summary.attempt?.exitCode, 0);
  assert.deepEqual(summary.attempt?.stages, ['attempt_started:started', 'device_auth_create_result:success', 'activation_ready:success', 'browser_open_result:success',
    'device_authorization_result:success', 'token_exchange_result:success', 'credential_persist_result:success']);
  assert.equal((await stat(path.join(account.home, 'config.json'))).mode & 0o777, 0o600);
  const directory = await providerDirectory(gateway);
  assert(directory.providers.find(p => p.id === 'account')?.available); assert.equal(directory.models.find(m => m.modelId === 'disabled-one')?.enabled, false);
  assert.equal(directory.models.find(m => m.modelId === 'fixture-audio')?.kind, 'audio'); assert.equal(directory.models.find(m => m.modelId === 'fixture-music')?.mode, 'text-to-audio');
  for (const kind of ['image', 'video', 'audio'] as const) {
    const args = { action: 'generate', provider: 'account', model: `fixture-${kind}`, projectId: store.projectId, modality: kind, prompt: 'hello', parameters: kind === 'audio' ? { voice: 'test-voice' } : {}, requestId: 'account-' + kind };
    const queued = await mediaUse(store, args); const completed = await finish(store, queued.job.id);
    assert.equal(completed.state, 'completed', completed.error); assert.match(completed.remoteId!, /fixture-task-/);
    assert.equal((await mediaUse(store, args)).job.id, queued.job.id);
  }
  assert.equal(JSON.parse(await readFile(path.join(account.home, 'submissions.json'), 'utf8')).length, 3);
  await writeFile(path.join(account.home, 'fixture-mode'), 'billing-failure');
  assert.equal((await account.summary(true)).billingUnavailable, true);
  const queued = await gateway.submit({ model: 'account:fixture-image', modality: 'image', prompt: 'pending' });
  await account.logout(); assert.equal((await account.summary()).state, 'signed-out');
  assert.equal((await account.models()).length, 0);
  assert.equal((await finish(store, queued.id)).state, 'failed');
  assert.equal(JSON.parse(await readFile(path.join(account.home, 'submissions.json'), 'utf8')).length, 3);
  await gateway.close();
}));

test('account music, default-voice speech and one-image editing run the matching connector commands', t => fixture(async store => {
  await chmod(binary, 0o755);
  const gateway = gatewayFor(store); gateway.options.detect = async () => [];
  const account = gateway.account = new OpenDesignAccount(store.directory, { binary, pollMs: 1 });
  t.after(() => gateway.close());
  await signIn(account); await account.models(true);
  await writeFile(path.join(account.home, 'fixture-audio'), await mediaBytes('audio'));
  const models = (await providerDirectory(gateway)).models;
  const api = new Phase1Service(store, pluginRoot, { origin: () => 'http://localhost:4173', nativeUrl: () => undefined,
    openProject: async () => {}, mutation: async task => task(), cancel: async () => {} });
  assert.equal(models.find(m => m.modelId === 'fixture-image')?.supportsImageReference, true);
  assert.equal(models.find(m => m.modelId === 'fixture-image-basic')?.supportsImageReference, undefined);
  const submissions = async () => JSON.parse(await readFile(path.join(account.home, 'submissions.json'), 'utf8')) as string[][];

  const music = { action: 'generate', provider: 'account', model: 'fixture-music', projectId: store.projectId, modality: 'audio', mode: 'text-to-audio', prompt: 'calm piano', parameters: { duration: 12 }, requestId: 'account-music' };
  const queuedMusic = await mediaUse(store, music);
  assert.equal((await finish(store, queuedMusic.job.id)).state, 'completed');
  assert.deepEqual((await submissions()).at(-1)?.slice(0, 2), ['audio', 'music']);
  assert.deepEqual((await submissions()).at(-1)?.slice(-4), ['--no-wait', '--json', '--duration', '12']);
  await assert.rejects(mediaUse(store, { ...music, parameters: { duration: 1.5 }, requestId: 'account-music-fraction' }), /Invalid Duration/);
  // A speech-only parameter fails the music job locally, before any connector submission.
  const voiced = await mediaUse(store, { ...music, parameters: { voice: 'narrator' }, requestId: 'account-music-voice' });
  assert.equal((await finish(store, voiced.job.id)).state, 'failed');
  // A caller mode cannot switch an account model to another connector command.
  await assert.rejects(mediaUse(store, { ...music, mode: 'text-to-speech', parameters: { voice: 'narrator' }, requestId: 'account-music-as-speech' }), /does not match the selected account model/);
  assert.equal((await submissions()).length, 1);

  await writeFile(path.join(store.projectDirectoryFor(store.projectId), 'cup.png'), png);
  const editInputProject = { action: 'generate', provider: 'account', model: 'fixture-image', projectId: store.projectId, modality: 'image', prompt: 'make it blue', referenceAsset: 'cup.png', requestId: 'account-project-edit' };
  await assert.rejects(api.call('openmotion_media_use', { ...editInputProject, model: 'fixture-image-basic' }), /does not support reference image editing/);
  await assert.rejects(api.call('openmotion_media_use', { ...editInputProject, referenceAsset: '../cup.png' }));
  const { job: edit } = await api.call('openmotion_media_use', editInputProject);
  await writeFile(path.join(store.projectDirectoryFor(store.projectId), 'cup.png'), 'changed after queueing');
  assert.deepEqual(await readFile(path.join(gateway.root, 'work', edit.id, 'reference.png')), png);
  assert.equal((await api.call('openmotion_media_use', editInputProject)).job.id, edit.id);
  const edited = await finish(store, edit.id);
  assert.equal(edited.state, 'completed', edited.error); assert.equal(edited.reference?.path, 'cup.png');
  const call = (await submissions()).at(-1)!;
  assert.deepEqual(call.slice(0, 2), ['image', 'edit']);
  assert.match(call[call.indexOf('--image') + 1], /reference\.png$/);
  assert.equal((await submissions()).length, 2);

  // The public asset tool edits a pinned library version through the same connector command.
  const source = path.join(store.directory, 'cup-source.png'); await writeFile(source, png);
  const cup = await new AssetLibrary(store).importFile(source, { requestId: 'account-cup', name: 'Cup' });
  const reference = { assetId: cup.id, versionId: cup.currentVersionId };
  const editInput = { action: 'generate', requestId: 'account-library-edit', model: 'account:fixture-image', modality: 'image', mode: 'text-to-image', prompt: 'make it blue', assetId: cup.id, parentVersionId: cup.currentVersionId, references: [reference] };
  const queued = await api.call('openmotion_assets_use', editInput);
  assert.equal((await api.call('openmotion_assets', editInput)).job.id, queued.job.id, 'Compatibility replay must not submit another account edit');
  await finish(store, queued.job.id);
  const status = await api.call('openmotion_assets_use', { action: 'status', jobId: queued.job.id });
  assert.equal(status.job.state, 'completed', status.job.error);
  const versions = (await new AssetLibrary(store).get(cup.id)).versions;
  assert.equal(versions.length, 2); assert.deepEqual(versions[1].references, [reference]);
  const libraryCall = (await submissions()).at(-1)!;
  assert.deepEqual(libraryCall.slice(0, 2), ['image', 'edit']);
  assert.match(libraryCall[libraryCall.indexOf('--image') + 1], /reference\.png$/);
  assert.equal((await submissions()).length, 3, 'The replay submits no additional paid operation');

  // A checked account speech model falls back to its first voice when the caller names none.
  const speech = await mediaUse(store, { ...music, model: 'elevenlabs-v3', mode: 'text-to-speech', prompt: 'Welcome', parameters: {}, requestId: 'account-default-voice' });
  assert.equal((await finish(store, speech.job.id)).state, 'completed');
  assert.deepEqual((await submissions()).at(-1)?.slice(-2), ['--voice', '21m00Tcm4TlvDq8ikWAM']);
}));

test('account media failures report the service reason without connector output', t => fixture(async store => {
  await chmod(binary, 0o755);
  const gateway = gatewayFor(store); gateway.options.detect = async () => [];
  const account = gateway.account = new OpenDesignAccount(store.directory, { binary, pollMs: 1 });
  t.after(() => gateway.close());
  await signIn(account); await account.models(true);
  const cases: [string, RegExp][] = [
    ['media-invalid', /^OpenDesign rejected this request for the selected model\./],
    ['media-plan', /^Your OpenDesign plan does not include this model\./],
    ['media-401', /^Your OpenDesign sign-in is no longer accepted\. Sign out/],
    ['media-unknown-code', /^OpenDesign could not complete this request\. Try again later/],
    ['media-empty-code', /^OpenDesign could not complete this request\. Try again later/],
    // The task was accepted; a failed download must not suggest choosing another model and paying again.
    ['media-get-502', /^OpenDesign accepted this task, but its result could not be read\./],
    // A rejected sign-in while reading the task keeps the sign-out hint; the account still reports signed-in.
    ['media-get-401', /^OpenDesign accepted this task, but your sign-in was rejected while reading its result\. Sign out, then sign in again/],
  ];
  for (const [scenario, expected] of cases) {
    await writeFile(path.join(account.home, 'fixture-mode'), scenario);
    const failed = await finish(store, (await gateway.submit({ model: 'account:fixture-video', modality: 'video', prompt: scenario })).id);
    assert.equal(failed.state, 'failed', scenario); assert.match(failed.error!, expected, scenario);
    assert.doesNotMatch(failed.error!, /private|fixture-user-id|HTTP/, scenario);
  }
  // Generic API errors keep their status and code; a bodiless media response keeps only its status.
  const generic = new AccountRequestError('Error: fetch billing summary: API request failed with status 401: invalid_api_key');
  assert.deepEqual([generic.status, generic.code], [401, 'invalid_api_key']); assert.match(generic.message, /Sign out, then sign in again/);
  const bodiless = new AccountRequestError('Error: media API request failed (, HTTP 504)');
  assert.deepEqual([bodiless.status, bodiless.code], [504, undefined]);
  assert.equal(new AccountRequestError('spawn failed').status, undefined);
}));

test('source installations use the connector locked with their dependencies instead of installing one at runtime', async t => {
  const packaged = createRequire(import.meta.url)('@powerformer/vela-cli').resolveVelaCliBin() as string | null;
  if (!packaged) return t.skip('The connector has no binary for this platform');
  await fixture(async store => {
    const explicit = process.env.OPENMOTION_ACCOUNT_CLI; delete process.env.OPENMOTION_ACCOUNT_CLI;
    t.after(() => { if (explicit !== undefined) process.env.OPENMOTION_ACCOUNT_CLI = explicit; });
    const account = new OpenDesignAccount(store.directory); t.after(() => account.close());
    // Preparation may install; it must pick the checkout's binary before `vela` on PATH or the private installation.
    assert.equal(await account['prepare'](), packaged);
    account['runtime'] = path.join(store.directory, 'removed-vela');
    assert.equal(await account['prepare'](), packaged);
    await assert.rejects(stat(path.join(store.directory, 'account', 'runtime')), { code: 'ENOENT' });
  });
});

test('cancelling account authorization cannot register a provider from a late completion', t => fixture(async store => {
  await chmod(binary, 0o755); const account = new OpenDesignAccount(store.directory, { binary }); t.after(() => account.close());
  await account.login(); await until(async () => Boolean((await account.summary()).authorizationUrl));
  assert.equal((await account.summary()).userCode, 'TEST-123');
  await account.cancel(); await writeFile(path.join(account.home, 'authorize'), 'late'); await delay(50);
  const cancelled = await account.summary();
  assert.equal(cancelled.state, 'signed-out'); assert.equal(cancelled.errorCode, undefined); assert.equal(await account.identity(), undefined); account.close();
}));

test('sign-in failures are classified by the stage reached and logged without account data', t => fixture(async store => {
  await chmod(binary, 0o755);
  const logs: string[] = [];
  const attempt = async (scenario: string, options: { authorize?: boolean; binary?: string; authorizationMs?: number } = {}) => {
    const account = new OpenDesignAccount(store.directory, { binary: options.binary ?? binary, authorizationMs: options.authorizationMs, log: line => logs.push(line) });
    t.after(() => account.close());
    await mkdir(account.home, { recursive: true });
    await writeFile(path.join(account.home, 'fixture-mode'), scenario); await rm(path.join(account.home, 'authorize'), { force: true });
    await account.login();
    if (options.authorize !== false) { await until(async () => Boolean((await account.summary()).authorizationUrl)); await writeFile(path.join(account.home, 'authorize'), 'yes'); }
    await until(async () => (await account.summary()).state !== 'authorizing');
    const summary = await account.summary();
    assert.equal(summary.state, 'signed-out', scenario); assert.equal(await account.identity(), undefined, scenario);
    assert.equal(summary.authorizationUrl, undefined); assert.equal(summary.userCode, undefined);
    return summary;
  };
  const created = await attempt('login-create-failure', { authorize: false });
  assert.equal(created.errorCode, 'setup_failed'); assert.equal(created.error, "Can't connect to OpenDesign right now. Check your network and try again.");
  assert.deepEqual(created.attempt?.stages, ['attempt_started:started', 'device_auth_create_result:failed:network_error']); assert.equal(created.attempt?.exitCode, 1);
  const missing = await attempt('', { binary: path.join(store.directory, 'missing-connector'), authorize: false });
  assert.equal(missing.errorCode, 'connector_unavailable');
  assert.match(missing.error ?? '', /npm install -g @powerformer\/vela-cli@0\.1\.10/);
  const denied = await attempt('login-denied');
  assert.equal(denied.errorCode, 'authorization_expired'); assert.equal(denied.attempt?.stages.at(-1), 'device_authorization_result:failed:oauth_denied');
  assert.equal((await attempt('', { authorize: false, authorizationMs: 300 })).errorCode, 'authorization_expired');
  const incomplete = await attempt('login-incomplete');
  assert.equal(incomplete.errorCode, 'credentials_rejected'); assert.equal(incomplete.attempt?.receipt, 'rejected'); assert.equal(incomplete.attempt?.persisted, true);
  const unconfirmed = await attempt('login-complete-failure');
  assert.equal(unconfirmed.errorCode, 'credentials_rejected'); assert.equal(unconfirmed.attempt?.receipt, 'accepted'); assert.equal(unconfirmed.attempt?.exitCode, 1);
  assert.equal(unconfirmed.attempt?.stages.at(-1), 'credential_persist_result:success');
  const approved = await attempt('login-missing-key-id');
  assert.equal(approved.errorCode, 'credentials_rejected'); assert.equal(approved.attempt?.stages.at(-1), 'device_authorization_result:success');
  // Nothing was accepted or stored, so a transient exchange or local write failure stays retryable.
  const exchange = await attempt('login-exchange-failure');
  assert.equal(exchange.errorCode, 'setup_failed'); assert.equal(exchange.attempt?.stages.at(-1), 'token_exchange_result:failed:network_error');
  assert.equal(exchange.attempt?.persisted, false);
  const persisted = await attempt('login-persist-failure');
  assert.equal(persisted.errorCode, 'setup_failed'); assert.equal(persisted.attempt?.stages.at(-1), 'credential_persist_result:failed:credential_persist_error');
  assert.equal(persisted.attempt?.persisted, false);
  assert.equal(logs.length, 9);
  assert.doesNotMatch(logs.join('\n'), /synthetic-private|TEST-123|open-design\.ai|fixture@example|Fixture user|fixture-user-id|private upstream/);
}));

test('an interrupted sign-in is confirmed by the next attempt, or replaced by a new authorization once the service refuses it', t => fixture(async store => {
  await chmod(binary, 0o755);
  const logs: string[] = [], records: SignInRecord[] = [];
  const account = new OpenDesignAccount(store.directory, { binary, log: line => logs.push(line), track: record => records.push(record) }); t.after(() => account.close());
  const config = path.join(account.home, 'config.json');
  const mode = async (scenario: string) => {
    await mkdir(account.home, { recursive: true });
    await writeFile(path.join(account.home, 'fixture-mode'), scenario); await rm(path.join(account.home, 'authorize'), { force: true });
  };
  const interrupt = async () => {
    await mode('login-complete-unavailable');
    await account.login(); await until(async () => Boolean((await account.summary()).authorizationUrl));
    await writeFile(path.join(account.home, 'authorize'), 'yes');
    await until(async () => (await account.summary()).state !== 'authorizing');
    // The service could not confirm the saved credentials: they stay pending and the failure reads as a connection problem.
    const failed = await account.summary();
    assert.equal(failed.state, 'signed-out'); assert.equal(failed.errorCode, 'setup_failed'); assert.equal(failed.attempt?.receipt, 'accepted');
    assert(JSON.parse(await readFile(config, 'utf8')).profiles.prod.pendingLogin);
  };
  await interrupt();
  await mode('');
  await account.login(); await until(async () => (await account.summary()).state !== 'authorizing');
  const resumed = await account.summary();
  assert.equal(resumed.state, 'signed-in'); assert.equal(resumed.errorCode, undefined); assert.equal(resumed.attempt?.resumed, true);
  assert.deepEqual(resumed.attempt?.stages, ['attempt_started:started', 'device_authorization_result:success', 'token_exchange_result:success', 'credential_persist_result:success']);
  await account.logout();
  await interrupt();
  // The service refuses the old attempt and the connector rolls it back; the same sign-in continues with a new link.
  // Offline, the rolled-back key stays queued for revocation next to the new session until a refresh delivers it.
  await mode('resume-rejected'); await writeFile(path.join(account.home, 'offline'), 'yes');
  await account.login(); await until(async () => Boolean((await account.summary()).authorizationUrl));
  const fresh = await account.summary();
  assert.equal(fresh.state, 'authorizing'); assert.equal(fresh.userCode, 'TEST-123'); assert.equal(fresh.attempt?.resumed, undefined);
  await writeFile(path.join(account.home, 'authorize'), 'yes');
  await until(async () => (await account.summary()).state === 'signed-in');
  assert.equal(JSON.parse(await readFile(config, 'utf8')).pendingRevocations.length, 1);
  await rm(path.join(account.home, 'offline')); await account.summary(true);
  await until(async () => !JSON.parse(await readFile(config, 'utf8')).pendingRevocations);
  assert.equal((await account.summary()).state, 'signed-in');
  assert.equal(JSON.parse(await readFile(path.join(account.home, 'revoked.json'), 'utf8')).length, 2);
  assert.equal(logs.length, 3); assert.match(logs[2], /"errorCode":"credentials_rejected".*"resumed":true/);
  assert.doesNotMatch(logs.join('\n'), /synthetic-private|TEST-123|open-design\.ai|fixture@example|fixture-user-id/);
  // The refused attempt is reported as replaced, so one click still counts as one completed sign-in.
  assert.deepEqual(records.map(record => [record.outcome, record.resumed, record.error_code]), [
    ['failure', false, 'setup_failed'], ['success', true, undefined], ['failure', false, 'setup_failed'], ['replaced', true, 'credentials_rejected'], ['success', false, undefined]]);
  assert.equal(records[3].entry_id, records[4].entry_id);
  assert.equal(records[3].entry_occurred_at, records[4].entry_occurred_at);
  assert.notEqual(records[2].entry_id, records[3].entry_id);
}));

test('completed sign-in delivers its source through the shared sender and respects opt-out', t => fixture(async store => {
  await chmod(binary, 0o755);
  const batches: any[] = [], installationId = randomUUID();
  let enabled = true;
  const tracking = createTracker({ registry: omEvents, entrypoint: 'mcp', enabled: true, isEnabled: () => enabled, flushIntervalMs: 0,
    send: createPosthogSender({ identity: { installation_id: installationId, utm_source: 'creator', created_at: new Date().toISOString() },
      appVersion: '0.0.1', env: 'test', host: 'https://collector.example', token: 'phc_test',
      fetch: async (_url, init) => { batches.push(JSON.parse(String(init?.body))); return Response.json({ status: 1 }); } }) });
  t.after(() => tracking.close());
  const account = new OpenDesignAccount(store.directory, { binary, track: record => { tracking.track('account_sign_in_result', record); } });
  t.after(() => account.close());
  await signIn(account);
  assert.equal(await tracking.flush(), 'accepted');
  const batch = batches[0].batch;
  assert.equal(batch.length, 1); assert.equal(batch[0].event, 'account_sign_in_result');
  const fields = batch[0].properties;
  assert.equal(fields.outcome, 'success'); assert.equal(fields.product, 'openmotion');
  assert.equal(fields.source_product, 'openmotion'); assert.equal(fields.source_detail, 'openmotion_editor_login');
  assert.equal(fields.amr_user_id, 'fixture-user-id');
  assert.equal(fields.installation_id, installationId); assert.equal(fields.distinct_id, installationId); assert.equal(fields.utm_source, 'creator');
  assert.notEqual(fields.entry_id, fields.attempt_id);
  assert.doesNotMatch(JSON.stringify(batches), /fixture@example|synthetic-private|TEST-123|open-design\.ai/);
  enabled = false;
  await account.logout(); await rm(path.join(account.home, 'authorize'));
  await signIn(account);
  assert.equal(await tracking.flush(), 'disabled'); assert.equal(batches.length, 1);
}));

test('finished sign-in reports the confirmed account only on success, without credentials or personal details', t => fixture(async store => {
  await chmod(binary, 0o755);
  const records: SignInRecord[] = [];
  const account = new OpenDesignAccount(store.directory, { binary, track: record => records.push(record) }); t.after(() => account.close());
  const file = (name: string) => path.join(account.home, name);
  // Holds the model catalogue sync so the step after browser approval can be observed.
  let release: (() => void) | undefined;
  const connector = (args: string[]) => new Promise<string>((resolve, reject) => execFile(binary, args, { env: { ...process.env, AMR_HOME: account.home } }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  account.options.run = async args => { if (args[0] === 'model') await new Promise<void>(resolve => { release = resolve; }); return connector(args); };
  await account.login(); await until(async () => (await account.summary()).browserOpened !== undefined);
  const waiting = await account.summary();
  assert.equal(waiting.browserOpened, true); assert.equal(waiting.syncing, undefined); assert(waiting.authorizationUrl);
  await writeFile(file('authorize'), 'yes'); await until(async () => Boolean(release));
  const syncing = await account.summary();
  assert.equal(syncing.state, 'authorizing'); assert.equal(syncing.syncing, true); assert.equal(syncing.authorizationUrl, undefined); assert.equal(records.length, 0);
  release!(); await until(async () => (await account.summary()).state === 'signed-in');
  assert.equal((await account.summary()).syncing, undefined);
  await account.logout(); await rm(file('authorize'));
  // Two clients cancelling the same attempt still count it once.
  await account.login(); await until(async () => (await account.summary()).browserOpened === true); await Promise.all([account.cancel(), account.cancel()]);
  await writeFile(file('fixture-mode'), 'login-denied');
  await account.login(); await until(async () => Boolean((await account.summary()).authorizationUrl));
  await writeFile(file('authorize'), 'yes'); await until(async () => (await account.summary()).state !== 'authorizing');
  assert.deepEqual(records.map(record => record.outcome), ['success', 'cancelled', 'failure']);
  const [success, cancelled, failure] = records;
  const { attempt_id: _id, entry_id, entry_occurred_at, duration_ms, prepare_ms, link_ms, approved_ms, ...fixed } = success;
  assert.deepEqual(fixed, { outcome: 'success', connector_version: '0.1.10', resumed: false, last_stage: 'credential_persist_result', last_result: 'success',
    source_product: 'openmotion', source_detail: 'openmotion_editor_login', amr_user_id: 'fixture-user-id',
    browser_opened: true, receipt: 'accepted', exit_code: 0 });
  assert.match(entry_id!, /^[0-9a-f-]{36}$/); assert.notEqual(entry_id, success.attempt_id);
  assert.equal(new Date(entry_occurred_at!).toISOString(), entry_occurred_at);
  assert.equal(new Set(records.map(record => record.entry_id)).size, 3);
  assert(prepare_ms! <= link_ms! && link_ms! <= approved_ms! && approved_ms! <= duration_ms);
  assert.equal(cancelled.error_code, undefined); assert.equal(cancelled.last_stage, 'browser_open_result'); assert.equal(cancelled.approved_ms, undefined);
  assert.equal(failure.error_code, 'authorization_expired'); assert.equal(failure.error_kind, 'oauth_denied');
  assert.equal(failure.last_stage, 'device_authorization_result'); assert.equal(failure.last_result, 'failed'); assert.equal(failure.exit_code, 1);
  assert.equal(cancelled.amr_user_id, undefined); assert.equal(failure.amr_user_id, undefined);
  assert.equal(new Set(records.map(record => record.attempt_id)).size, 3);
  for (const record of records) assert(validProperties(omEvents, 'account_sign_in_result', record), JSON.stringify(record));
  assert.doesNotMatch(JSON.stringify(records), /synthetic-private|TEST-123|open-design\.ai|fixture@example|Fixture user/);
}));

test('sign-out keeps an undelivered revocation and retries it after a restart and on refresh', t => fixture(async store => {
  await chmod(binary, 0o755);
  const account = new OpenDesignAccount(store.directory, { binary }); t.after(() => account.close());
  const file = (name: string) => path.join(account.home, name);
  const exists = (name: string) => access(file(name)).then(() => true, () => false);
  const retries = async () => await exists('retries') ? (await readFile(file('retries'), 'utf8')).length : 0;
  await signIn(account);
  await writeFile(file('offline'), 'yes');
  assert.equal((await account.logout()).state, 'signed-out'); assert.deepEqual(await account.models(), []);
  const queued = JSON.parse(await readFile(file('config.json'), 'utf8'));
  assert.equal(queued.pendingRevocations.length, 1); assert.doesNotMatch(JSON.stringify(queued.profiles), /synthetic-private/);
  await account.summary(true); await until(async () => await retries() === 1);
  assert(await exists('config.json')); assert.equal(await exists('revoked.json'), false);
  // Back online: the first status read after a restart delivers the revocation and removes the file.
  await rm(file('offline'));
  const restarted = new OpenDesignAccount(store.directory, { binary }); t.after(() => restarted.close());
  assert.equal((await restarted.summary()).state, 'signed-out');
  await until(async () => !await exists('config.json'));
  assert.equal(await retries(), 2); assert.deepEqual(JSON.parse(await readFile(file('revoked.json'), 'utf8')), ['fixture-control-key-id']);
  // A refresh retries as well.
  await rm(file('authorize')); await signIn(account);
  await writeFile(file('offline'), 'yes'); await account.logout(); await rm(file('offline'));
  await account.summary(true); await until(async () => !await exists('config.json'));
  assert.equal(await retries(), 3); assert.equal(JSON.parse(await readFile(file('revoked.json'), 'utf8')).length, 2);
}));

test('a revocation retry in flight holds back sign-in and sign-out and cannot remove the credentials they use', t => fixture(async store => {
  await chmod(binary, 0o755);
  const account = new OpenDesignAccount(store.directory, { binary }); t.after(() => account.close());
  const file = (name: string) => path.join(account.home, name);
  // Holds every `logout --retry-pending` until released; other commands run the fixture connector.
  let release: ((output: string) => void) | undefined;
  const connector = (args: string[]) => new Promise<string>((resolve, reject) => execFile(binary, args, { env: { ...process.env, AMR_HOME: account.home } }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const hold = () => { release = undefined; account.options.run = args => args.includes('--retry-pending') ? new Promise(resolve => { release = resolve; }) : connector(args); };
  const delivered = JSON.stringify({ ok: true, revocationPending: false });
  await signIn(account);
  await writeFile(file('offline'), 'yes'); await account.logout(); await rm(file('offline')); await rm(file('authorize'));
  hold(); await account.summary(true); await until(async () => Boolean(release));
  // Sign-in waits for the retry: no connector runs and no activation link appears before it finishes.
  await account.login(); await delay(200);
  const waiting = await account.summary();
  assert.equal(waiting.state, 'authorizing'); assert.equal(waiting.authorizationUrl, undefined);
  release!(delivered);
  await until(async () => Boolean((await account.summary()).authorizationUrl));
  await writeFile(file('authorize'), 'yes'); await until(async () => (await account.summary()).state === 'signed-in');
  assert((await access(file('config.json')).then(() => true, () => false)));
  // Sign in again while offline so a key stays queued; the refresh at the end of sign-in starts a held retry.
  await writeFile(file('offline'), 'yes'); await account.logout(); await rm(file('authorize'));
  hold(); await signIn(account); await until(async () => Boolean(release)); await rm(file('offline'));
  // Sign-out waits for that retry, and the retry finishing during sign-out cannot remove the file first.
  let signedOut = false; const logout = account.logout().then(summary => { signedOut = true; return summary; });
  await delay(200);
  assert.equal(signedOut, false); assert(JSON.parse(await readFile(file('config.json'), 'utf8')).profiles.prod.controlKey);
  release!(delivered);
  assert.equal((await logout).state, 'signed-out');
  assert.equal(await access(file('config.json')).then(() => true, () => false), false);
}));

test('production billing uses the authenticated summary and preserves HTTP refusals', t => fixture(async store => {
  const account = new OpenDesignAccount(store.directory);
  await mkdir(account.home, { recursive: true });
  await writeFile(path.join(store.directory, 'account/session.json'), JSON.stringify({ id: 'test-session' }));
  const profile = { apiUrl: 'https://amr-api.open-design.ai', user: { id: 'test' }, controlKey: 'test-control', controlKeyId: 'test-id', runtimeKey: 'test-runtime' };
  await writeFile(path.join(account.home, 'config.json'), JSON.stringify({ profiles: { prod: profile } }));
  let response = Response.json({ membershipTier: 'pro', balanceUsd: '12.3456' });
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://amr-api.open-design.ai/api/v1/billing/summary');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-control');
    assert.equal(init.redirect, 'error');
    return response;
  });
  const summary = await account.summary(true);
  assert.equal(summary.plan, 'pro'); assert.equal(summary.balance, '12.3456');
  response = Response.json({ error: 'workspace_billing_scope_locked' }, { status: 403 });
  const denied = await account.summary(true);
  assert.deepEqual(denied.billingError, { status: 403, code: 'workspace_billing_scope_locked' });
  assert.equal(denied.balance, undefined);
}));

test('billing reads an empty tier as Free, keeps the session on refusal and asks to sign in again on a rejected key', t => fixture(async store => {
  await chmod(binary, 0o755);
  const gateway = gatewayFor(store); gateway.options.detect = async () => [];
  const account = gateway.account = new OpenDesignAccount(store.directory, { binary }); t.after(() => gateway.close());
  const mode = (scenario: string) => writeFile(path.join(account.home, 'fixture-mode'), scenario);
  const provider = async () => (await providerDirectory(gateway)).providers.find(p => p.id === 'account')!;
  await signIn(account);
  await mode('billing-free');
  const free = await account.summary(true);
  assert.equal(free.plan, 'free'); assert.equal(free.balance, '0.00'); assert.equal(free.billingUnavailable, false);
  await mode('billing-403');
  const refused = await account.summary(true);
  assert.equal(refused.state, 'signed-in'); assert.equal(refused.billingUnavailable, true); assert.equal(refused.plan, undefined); assert.equal(refused.balance, undefined);
  assert.deepEqual(refused.billingError, { status: 403, code: 'workspace_billing_scope_locked' }); assert((await provider()).available);
  await mode('billing-failure');
  const failed = await account.summary(true);
  assert.equal(failed.billingUnavailable, true); assert.equal(failed.billingError, undefined); assert.doesNotMatch(JSON.stringify(failed), /private upstream/);
  await mode('billing-401');
  const rejected = await account.summary(true);
  assert.equal(rejected.state, 'reauth-required'); assert.equal(rejected.billingUnavailable, false); assert.equal(rejected.plan, undefined);
  assert.equal((await provider()).available, false); assert.match((await provider()).reason, /sign-in expired/);
  const gatewayAccount = (await gateway.status()).providers.find(p => p.id === 'account')!;
  assert.equal(gatewayAccount.available, false); assert.match(gatewayAccount.reason, /sign-in expired/);
  assert.equal((await account.summary()).state, 'reauth-required');
  for (const scenario of ['billing-failure', 'billing-502']) {
    await mode(scenario); assert.equal((await account.summary(true)).state, 'reauth-required', scenario);
  }
  await mode('billing-403-text');
  const untyped = await account.summary(true);
  assert.equal(untyped.state, 'signed-in'); assert.deepEqual(untyped.billingError, { status: 403 });
  await mode('billing-401'); await account.summary(true);
  await mode('billing-403');
  assert.equal((await account.summary(true)).state, 'signed-in');
  await mode('billing-401'); await account.summary(true);
  await mode('');
  const restored = await account.summary(true);
  assert.equal(restored.state, 'signed-in'); assert.equal(restored.plan, 'pro'); assert.equal(restored.billingError, undefined);
}));

test('a late catalogue response cannot replace models after a protocol change', () => fixture(async store => {
  let release!: (value: Response) => void;
  const response = new Promise<Response>(resolve => { release = resolve; });
  let requested = false;
  const connections = new ProviderConnections(store, async () => { requested = true; return response; });
  const id = await connections.configure(null, { label: 'API', protocol: 'openai', baseUrl: 'https://models.example/v1', apiKey: 'synthetic-key' });
  await connections.saveModel(id, { modelId: 'manual', label: 'Manual', kind: 'text' });
  const sync = connections.sync(id);
  await until(async () => requested);
  await connections.configure(id, { protocol: 'anthropic' });
  const rejected = assert.rejects(sync, /Provider changed/);
  release(Response.json({ data: [{ id: 'late-model' }] })); await rejected;
  assert.deepEqual((await connections.models()).map(model => model.modelId), ['manual']);
}));

test('cancelling after credentials arrive cannot restore a session through a late model sync', t => fixture(async store => {
  const account = new OpenDesignAccount(store.directory, { binary }); t.after(() => account.close());
  let release!: (value: string) => void, requested = false;
  const response = new Promise<string>(resolve => { release = resolve; });
  account.options.run = async args => {
    if (args[0] === 'model') { requested = true; return response; }
    return JSON.stringify({ models: [] });
  };
  await account.login(); await until(async () => Boolean((await account.summary()).authorizationUrl));
  await writeFile(path.join(account.home, 'authorize'), 'yes'); await until(async () => requested);
  await account.cancel();
  release(JSON.stringify({ source: 'remote', data: [{ id: 'late-model' }] }));
  await delay(50);
  assert.equal((await account.summary()).state, 'signed-out');
  assert.equal(await account.identity(), undefined); assert.deepEqual(await account.models(), []);
  assert.deepEqual(JSON.parse(await readFile(path.join(store.directory, 'account', 'models.json'), 'utf8')), []);
}));

test('account fixture publishes complete credentials while sign-in is being polled', t => fixture(async store => {
  await chmod(binary, 0o755);
  const started = path.join(store.directory, 'credential-write-started');
  const release = path.join(store.directory, 'allow-credential-publication');
  const preload = path.join(store.directory, 'pause-credential-write.mjs');
  await writeFile(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const write = fs.writeFileSync;
fs.writeFileSync = (file, ...args) => {
  if (String(file).includes('config.json')) {
    write(file, '', args[1]);
    write(${JSON.stringify(started)}, 'ready');
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(${JSON.stringify(release)})) {
      if (Date.now() > deadline) throw new Error('Credential publication fixture timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return write(file, ...args);
};
syncBuiltinESMExports();`);
  const spawnFixture = ((_command: string, args: readonly string[], options: SpawnOptions) =>
    spawn(process.execPath, ['--import', preload, binary, ...args], options)) as typeof spawn;
  const account = new OpenDesignAccount(store.directory, { binary, spawn: spawnFixture });
  t.after(() => account.close());
  await account.login(); await until(async () => Boolean((await account.summary()).authorizationUrl));
  await writeFile(path.join(account.home, 'authorize'), 'yes');
  await until(async () => access(started).then(() => true, () => false));
  try { assert.equal((await account.summary()).state, 'authorizing'); }
  finally { await writeFile(release, 'continue'); }
  await until(async () => (await account.summary()).state === 'signed-in');
}));

test('an in-flight billing refresh cannot report an old account after sign-out', t => fixture(async store => {
  const account = new OpenDesignAccount(store.directory, { binary }); t.after(() => account.close());
  await signIn(account); await account.summary(true);
  let release!: (value: string) => void, requested = false;
  const response = new Promise<string>(resolve => { release = resolve; });
  account.options.run = async args => { if (args[0] === 'billing') { requested = true; return response; } return '{}'; };
  const pending = account.summary(true); await until(async () => requested);
  await account.logout(); release(JSON.stringify({ membershipTier: 'pro', balanceUsd: '99.00' }));
  const summary = await pending;
  assert.equal(summary.state, 'signed-out'); assert.equal(summary.plan, undefined); assert.equal(summary.balance, undefined);
}));

test('model overrides survive catalogue sync and reach generation with per-request precedence', () => fixture(async store => {
  const gateway = gatewayFor(store); gateway.options.detect = async () => [];
  const fetcher: Fetcher = async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'picture', context_length: 128000, architecture: { output_modalities: ['image'], input_modalities: ['text', 'image'] }, supported_parameters: ['reasoning', 'tools'] }] });
    assert.deepEqual(JSON.parse(String(init?.body)), { model: 'picture', prompt: 'cup', quality: 'high', size: '1024x1024' });
    return Response.json({ data: [{ b64_json: png.toString('base64') }] });
  };
  gateway.options.fetcher = fetcher; gateway.connections = new ProviderConnections(store, fetcher);
  const provider = await gateway.connections.configure(null, { label: 'Test', protocol: 'openai', baseUrl: 'https://models.example/v1', apiKey: 'synthetic-key' });
  await gateway.connections.sync(provider);
  const id = provider + ':picture';
  const synced = (await providerDirectory(gateway)).models.find(model => model.id === id)!;
  assert.deepEqual(synced.inputs, ['vision']); assert.deepEqual(synced.capabilities, ['reasoning', 'tools']);
  await gateway.connections.updateMetadata(id, { label: 'My picture', group: 'Creative', contextWindow: null, capabilities: [], inputs: ['vision'], defaults: { quality: 'standard', size: '1024x1024' } });
  await gateway.connections.sync(provider);
  const edited = (await providerDirectory(gateway)).models.find(model => model.id === id)!;
  assert.equal(edited.label, 'My picture'); assert.equal(edited.group, 'Creative'); assert.equal(edited.contextWindow, null); assert.deepEqual(edited.capabilities, []);
  const job = await gateway.submit({ model: id, modality: 'image', prompt: 'cup', parameters: { quality: 'high' } });
  assert.equal((await finish(store, job.id)).state, 'completed');
  for (const invalid of [{ contextWindow: -1 }, { contextWindow: 128000, maxInputTokens: 200000 }, { inputs: ['unknown'] }, { defaults: { authorization: 'secret' } }, { defaults: [] }]) await assert.rejects(gateway.connections.updateMetadata(id, invalid));
  await gateway.connections.updateModel(id, null); assert.equal((await gateway.connections.modelOverrides())[id], undefined);
  await gateway.close();
}));

test('media setup discovery rechecks saved and removed keys without executing a model', () => fixture(async store => {
  const gateway = gatewayFor(store);
  gateway.options.detect = async () => [];
  gateway.options.fetcher = async () => { throw new Error('Setup must not call a paid model'); };
  const inspect = () => mediaUse(store, { action: 'inspect' });
  const before = await inspect();
  assert.deepEqual(before.settingsHandoff, { tool: 'openmotion_open_preview', arguments: { target: 'providers' } });
  assert.equal(before.providers.some(provider => provider.available), false);
  await gateway.configureProvider('atlascloud', { apiKey: 'synthetic-onboarding-key' });
  const saved = await inspect();
  assert.equal(saved.providers.find(provider => provider.id === 'atlascloud')?.available, true);
  assert.doesNotMatch(JSON.stringify(saved), /synthetic-onboarding-key/);
  await gateway.configureProvider('atlascloud', { apiKey: null });
  assert.equal((await inspect()).providers.find(provider => provider.id === 'atlascloud')?.available, false);
}));

test('media inspection refreshes advisory billing without disabling account models or leaking balances', t => fixture(async store => {
  await chmod(binary, 0o755);
  const gateway = gatewayFor(store); gateway.options.detect = async () => [];
  const account = gateway.account = new OpenDesignAccount(store.directory, { binary });
  t.after(() => gateway.close());
  const inspect = async () => (await mediaUse(store, { action: 'inspect' })).providers.find(p => p.id === 'account')!;
  const signedOut = await inspect();
  assert.equal(signedOut.available, false); assert.equal(Object.hasOwn(signedOut, 'mediaEntitlement'), false);
  assert.equal(signedOut.plan, undefined); assert.equal(signedOut.hasBalance, undefined);
  await signIn(account);
  for (const [mode, entitlement, plan, hasBalance] of [
    ['billing-free', 'not-included', 'free', false], ['billing-go', 'not-included', 'go', false],
    ['billing-plus', 'included', 'plus', undefined], ['', 'included', 'pro', undefined],
    ['billing-topup', 'unknown', 'free', true], ['billing-malformed', 'unknown', 'free', undefined],
    ['billing-missing', 'unknown', 'go', undefined], ['billing-403', 'unknown', undefined, undefined],
    ['billing-failure', 'unknown', undefined, undefined],
  ] as const) {
    await writeFile(path.join(account.home, 'fixture-mode'), mode);
    const provider = await inspect();
    assert.equal(provider.mediaEntitlement, entitlement, mode); assert.equal(provider.available, true, mode);
    assert.equal(provider.plan, plan, mode); assert.equal(provider.hasBalance, hasBalance, mode);
    const directory = await providerDirectory(gateway);
    const official = directory.providers.find(p => p.id === 'account')!;
    assert.equal(official.reason, provider.reason); assert.equal(official.available, true);
    assert(!('mediaEntitlement' in official), 'ProviderConnection public fields remain unchanged');
    assert(directory.models.some(m => m.modelId === 'language-one' && m.enabled), 'Go text discovery remains usable');
    await setDefaultModel(gateway, 'text', 'account:language-one');
    const models = await mediaUse(store, { action: 'models', provider: 'account', modality: 'image' });
    assert(models.catalogs.some(page => page.models.length > 0), 'advisory entitlement must not filter discovery');
    assert.doesNotMatch(JSON.stringify(provider), /"balance"|12\.50|1\.2345|controlKey|runtimeKey|fixture-user/);
    if (mode === 'billing-free') {
      const queued = await gateway.submit({ projectId: store.projectId, model: 'account:fixture-image', modality: 'image', prompt: 'cup', idempotencyKey: 'free-advisory' });
      assert.equal(queued.state, 'queued', 'local submission retains server-side enforcement');
      await gateway.cancel(queued.id);
    }
  }
  await writeFile(path.join(account.home, 'fixture-mode'), 'billing-401');
  const rejected = await inspect();
  assert.equal(rejected.available, false); assert.equal(Object.hasOwn(rejected, 'mediaEntitlement'), false);
  assert.equal((await account.summary()).state, 'reauth-required');
}));


test('provider directory keeps a signed-in account usable before billing is fetched', t => fixture(async store => {
  const gateway = gatewayFor(store); gateway.options.detect = async () => [];
  t.after(() => gateway.close());
  t.mock.method(gateway.account, 'summary', async (refresh = false) => {
    assert.equal(refresh, false, 'the directory must not refresh billing');
    return { state: 'signed-in', consoleUrl: 'https://example.test' };
  });
  const account = (await providerDirectory(gateway)).providers.find(p => p.id === 'account')!;
  assert.equal(account.available, true);
  assert.equal(account.reason, 'Signed in; model access and balance are checked when generating');
  assert.equal(Object.hasOwn(account, 'mediaEntitlement'), false, 'directory public fields stay unchanged');
}));
