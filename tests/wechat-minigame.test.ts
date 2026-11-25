import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WechatMinigame } from '../gateway/wechat-minigame.ts';
import { dispatchGameTool } from '../game-projects.ts';
import { gameTools, gameToolAnnotations } from '../shared/game-tools.ts';
import { validateInput } from '../shared/phase1-tools.ts';
import { WorkspaceStore } from '../workspace.ts';
import { transport } from './http.ts';
import { mcpRegistry, rpc } from '../mcp.ts';

const prefix = '/api/publish/wechat';
function serviceFor(workspace: string, options: ConstructorParameters<typeof WechatMinigame>[1] = {}) {
  return new WechatMinigame(workspace, { ...options, keyDirectory: path.join(workspace, 'wechat-keys') });
}
const appid = 'wx0123456789abcdef';
// Assembled at runtime so the repository credential scan does not read a test fixture as a real key.
const pem = (edge: 'BEGIN' | 'END') => `-----${edge} ${'PRIVATE'} KEY-----`;
const key = [pem('BEGIN'), Buffer.from('test-only-private-key').toString('base64'), pem('END')].join('\n');
async function fixture(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'wechat-test-'));
  try { await run(workspace); }
  finally { await rm(workspace, { recursive: true, force: true }); }
}
const request = (service: WechatMinigame, method: string, route: string, body?: unknown) => service.handle(method, prefix + route, async () => body);
function errorCode(result: Awaited<ReturnType<typeof request>>) { return (result.data as any).error?.code; }
function noKey(value: unknown) {
  const serialized = JSON.stringify(value);
  assert.ok(!serialized.includes('-----BEGIN'));
  assert.ok(!serialized.includes(key.split('\n')[1]));
}
async function project(workspace: string) {
  const dir = path.join(workspace, 'games', 'demo');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'game.json'), JSON.stringify({ title: 'Orbit', description: 'Collect stars', controls: 'Tap to fly' }));
  const projectDir = path.join(dir, 'wechat-minigame');
  await mkdir(projectDir);
  await writeFile(path.join(projectDir, 'game.js'), 'start();');
  await writeFile(path.join(projectDir, 'game.json'), '{}');
  return projectDir;
}
function fakeCi(overrides: Record<string, any> = {}) {
  return {
    Project: class { options: any; constructor(options: any) { this.options = options; } },
    preview: async (options: any) => { await writeFile(options.qrcodeOutputDest, Buffer.from([137, 80, 78, 71])); },
    upload: async () => ({ subPackageInfo: [{ name: 'main', size: 10 }] }),
    ...overrides,
  };
}

const action = (service: WechatMinigame, action: string, input: Record<string, unknown> = {}) => service.action({ id: 'demo', action, ...input });
const statePath = (workspace: string) => path.join(workspace, 'games', 'demo', 'publish', 'wechat.json');
const stateFile = async (workspace: string) => JSON.parse(await readFile(statePath(workspace), 'utf8'));
async function configured(workspace: string, ci = fakeCi()) {
  await project(workspace);
  const service = serviceFor(workspace, { loadCi: async () => ci });
  await request(service, 'PUT', '/credentials', { appid, privateKey: key });
  await action(service, 'set_appid', { appid });
  return service;
}

test('fresh state derives ordered progress, metadata and next version without writing publish state', () => fixture(async workspace => {
  const dir = await project(workspace);
  await rm(dir, { recursive: true });
  const service = serviceFor(workspace);
  const status = await service.status('demo');
  assert.equal(status.appid, null); assert.equal(status.hasKey, false);
  assert.deepEqual(status.project, { exists: false, hasGameJs: false, hasGameJson: false, totalBytes: 0, mainPackageLimitBytes: 4194304, portReady: false });
  assert.equal(status.current, 'account'); assert.equal(status.nextVersion, '1.0.0');
  assert.deepEqual(status.game, { title: 'Orbit', description: 'Collect stars', controls: 'Tap to fly' });
  assert.equal(status.steps.length, 12); assert(status.steps.every(step => step.status === 'todo'));
  assert.deepEqual(status.steps.filter(step => step.later).map(step => step.key), ['category', 'review', 'filing', 'release']);
  assert.equal(status.preview, null); assert.equal(status.upload, null);
  await assert.rejects(stat(statePath(workspace)), { code: 'ENOENT' });
  assert.deepEqual(await dispatchGameTool('openmotion_game_wechat', { id: 'demo', action: 'status' }, workspace), status);
}));

test('MCP WeChat schema rejects secrets/invalid inputs and annotations distinguish action effects', () => {
  const tool = gameTools.find(tool => tool.name === 'openmotion_game_wechat')!;
  assert.equal(tool.title, 'OpenMotion · WeChat Mini Game');
  for (const input of [{ action: 'status' }, { action: 'confirm_upload', present: true }, { action: 'upload', version: '1.2.3', confirmMissing: true }]) validateInput(tool.inputSchema, { id: 'demo', ...input });
  for (const input of [{ action: 'status', privateKey: key }, { action: 'set_appid', appid: 'wx123' }, { action: 'upload', version: 'v1' }, { action: 'upload', desc: 'x'.repeat(201) }, { action: 'confirm', step: 'key' }]) assert.throws(() => validateInput(tool.inputSchema, { id: 'demo', ...input }));
  assert.equal(gameToolAnnotations(tool.name, { action: 'status' })?.readOnlyHint, true);
  for (const action of ['set_appid', 'confirm', 'confirm_upload', 'ip_check', 'preview', 'upload']) {
    const annotations = gameToolAnnotations(tool.name, { action });
    assert.equal(annotations?.readOnlyHint, false);
    assert.equal(annotations?.openWorldHint, ['ip_check', 'preview', 'upload'].includes(action));
  }
});

test('MCP authorizes status as read-only and returns readable publish errors for writes', () => fixture(async workspace => {
  const store = new WorkspaceStore(workspace);
  for (const action of ['status', 'set_appid', 'ip_check', 'preview', 'upload', 'confirm_upload']) {
    let authorized = false;
    const reply = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'openmotion_game_wechat', arguments: { id: 'demo', action } } }, store, mcpRegistry('phase1'), undefined, undefined, {
      authorizeToolCall: tool => { authorized = true; assert.equal(tool.annotations?.readOnlyHint, action === 'status'); },
      callPhase1: async payload => { assert.equal(payload.name, 'openmotion_game_wechat'); throw Object.assign(new Error('Check Version management before retrying'), { code: 'UPLOAD_UNCONFIRMED', status: 409 }); },
    });
    assert(authorized);
    assert.equal(reply.result.isError, true);
    assert.equal(reply.result.structuredContent.error.code, 'UPLOAD_UNCONFIRMED');
    assert.equal(reply.result.structuredContent.error.message, 'Check Version management before retrying');
  }
}));

test('game state mutations cannot race a pending preview or bypass the per-AppID BUSY lock', () => fixture(async workspace => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const service = await configured(workspace, fakeCi({ preview: async (options: any) => { entered(); await gate; await writeFile(options.qrcodeOutputDest, 'png'); } }));
  const second = serviceFor(workspace);
  const pending = action(service, 'preview');
  try {
    await started;
    await assert.rejects(action(second, 'set_appid', { appid: 'wxfedcba9876543210' }), { code: 'BUSY', status: 409 });
    assert.equal((await action(second, 'status')).appid, appid);
    assert.equal(errorCode(await request(second, 'POST', '/upload', { gameId: 'demo', appid, version: '1.0.0', desc: '' })), 'BUSY');
  } finally { release(); }
  assert((await pending).preview);
  assert.equal((await action(second, 'confirm', { step: 'account' })).appid, appid);
}));

test('appid changes clear app-scoped progress and image but keep user confirmations', () => fixture(async workspace => {
  const service = await configured(workspace);
  await action(service, 'confirm', { step: 'account' });
  await action(service, 'ip_check'); await action(service, 'preview'); await action(service, 'upload');
  const unchanged = await action(service, 'set_appid', { appid });
  assert.equal(unchanged.uploadedVersion, '1.0.0'); assert(unchanged.preview);
  const changed = await action(service, 'set_appid', { appid: 'wxFEDCBA9876543210' });
  assert.equal(changed.appid, 'wxfedcba9876543210'); assert.equal(changed.hasKey, false);
  assert.equal(changed.ipCheck, null); assert.equal(changed.preview, null); assert.equal(changed.upload, null);
  assert.equal(changed.uploadedVersion, null); assert.equal(changed.nextVersion, '1.0.0');
  const state = await stateFile(workspace);
  assert.ok(Date.parse(state.confirmed.account)); assert.ok(Date.parse(state.updatedAt));
  assert.deepEqual(await serviceFor(workspace).status('demo'), changed);
  assert.equal((await request(service, 'GET', '/preview-image/demo')).status, 404);
  await assert.rejects(stat(path.join(path.dirname(statePath(workspace)), 'wechat-preview.png')), { code: 'ENOENT' });
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.dirname(statePath(workspace)))).mode & 0o777, 0o700);
    assert.equal((await stat(statePath(workspace))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await readdir(path.dirname(statePath(workspace))), ['wechat.json']);
}));

test('blocked IP is persisted with the address WeChat saw and becomes done on a later check', () => fixture(async workspace => {
  let blocked = true;
  const service = await configured(workspace, fakeCi({ preview: async () => { if (blocked) throw new Error('invalid ip: 198.51.100.7'); } }));
  const status = await action(service, 'ip_check');
  assert.deepEqual(status.result, { allowed: false, ip: '198.51.100.7' });
  const step = status.steps.find(step => step.key === 'ip')!;
  assert.equal(step.status, 'blocked'); assert.equal(step.detail, '198.51.100.7');
  assert.equal((await stateFile(workspace)).ipCheck.ip, '198.51.100.7');
  blocked = false;
  assert.equal((await action(service, 'ip_check')).steps.find(step => step.key === 'ip')?.status, 'done');
}));

test('a key WeChat refuses is flagged until a new key is saved or a call succeeds; other failures are not', () => fixture(async workspace => {
  let answer: string | undefined = 'invalid signature';
  const service = await configured(workspace, fakeCi({ preview: async (options: any) => {
    if (answer) throw new Error(answer);
    await writeFile(options.qrcodeOutputDest, Buffer.from([137, 80, 78, 71]));
  } }));
  assert.equal((await service.status('demo')).keyRejected, false);
  await assert.rejects(action(service, 'ip_check'), { code: 'WECHAT_CI_ERROR' });
  assert.equal((await service.status('demo')).keyRejected, true);
  assert.ok(Date.parse((await stateFile(workspace)).keyRejected.at));
  // Saving a key again clears the flag without another WeChat call.
  await new Promise(resolve => setTimeout(resolve, 5));
  await request(service, 'PUT', '/credentials', { appid, privateKey: key });
  assert.equal((await service.status('demo')).keyRejected, false);
  // A refusal at preview flags it again; the next success clears it.
  await assert.rejects(action(service, 'preview'), { code: 'WECHAT_CI_ERROR' });
  assert.equal((await service.status('demo')).keyRejected, true);
  answer = undefined;
  assert.equal((await action(service, 'preview')).keyRejected, false);
  assert.equal((await stateFile(workspace)).keyRejected, undefined);
  // An unrelated WeChat error does not suggest replacing the key.
  answer = 'system busy, try later';
  await assert.rejects(action(service, 'preview'), { code: 'WECHAT_CI_ERROR' });
  assert.equal((await service.status('demo')).keyRejected, false);
}));

test('port readiness requires files, package size and a passed smoke test report', () => fixture(async workspace => {
  const dir = await project(workspace), service = serviceFor(workspace);
  assert.equal((await service.status('demo')).project.portReady, false);
  for (const report of ['invalid JSON', '{"smokeTest":"failed"}', '{"smokeTest":"passed"}']) {
    await writeFile(path.join(dir, 'port-report.json'), report);
    assert.equal((await service.status('demo')).project.portReady, report.includes('passed'));
  }
  await writeFile(path.join(dir, 'oversized.bin'), Buffer.alloc(4194304));
  assert.equal((await service.status('demo')).project.portReady, false);
  await rm(path.join(dir, 'oversized.bin')); await rm(path.join(dir, 'game.json'));
  assert.equal((await service.status('demo')).project.portReady, false);
}));

test('preview persists private PNG and the real HTTP handler serves raw PNG with no-store', () => fixture(async workspace => {
  const service = await configured(workspace);
  const status = await action(service, 'preview');
  const qrcodeUrl = '/motion-api/publish/wechat/preview-image/demo';
  assert.equal(status.preview?.qrcodeUrl, qrcodeUrl);
  assert.deepEqual(status.result, status.preview);
  assert.ok(!JSON.stringify(status).includes('base64'));
  const file = path.join(path.dirname(statePath(workspace)), 'wechat-preview.png');
  assert.deepEqual(await readFile(file), Buffer.from([137, 80, 78, 71]));
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  const http = transport(new WorkspaceStore(workspace), {});
  const image = await http(qrcodeUrl);
  assert.equal(image.status, 200); assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.equal(image.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), await readFile(file));
  const state = await (await http('/motion-api/publish/wechat/state/demo')).json();
  assert.equal(state.preview.qrcodeUrl, qrcodeUrl);
  const confirmed = await http('/motion-api/publish/wechat/state/demo/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"step":"account"}' });
  assert.equal(confirmed.status, 200);
  const changed = await http('/motion-api/publish/wechat/state/demo/appid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"appid":"wxfedcba9876543210"}' });
  assert.equal(changed.status, 200); assert.equal((await http(qrcodeUrl)).status, 404);
  for (const route of [qrcodeUrl, '/motion-api/publish/wechat/state/demo']) {
    assert.equal((await http(route, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  }
}));

test('successful uploads set the accepted version, increment patch, preserve other steps and reach later steps', () => fixture(async workspace => {
  let uploaded: any;
  const service = await configured(workspace, fakeCi({ upload: async (options: any) => { uploaded = options; return {}; } }));
  for (const step of ['testers', 'review', 'release']) await assert.rejects(action(service, 'confirm', { step }), { code: 'UPLOAD_REQUIRED', status: 409 });
  await action(service, 'ip_check'); const preview = await action(service, 'preview');
  await writeFile(path.join(workspace, 'games/demo/wechat-minigame/port-report.json'), '{"smokeTest":"passed"}');
  const status = await action(service, 'upload', { version: '2.4.9', desc: 'Stars update' });
  assert.deepEqual(status.result, { outcome: 'done', version: '2.4.9' });
  assert.equal(status.uploadedVersion, '2.4.9'); assert.equal(status.nextVersion, '2.4.10');
  assert.equal(status.upload?.desc, 'Stars update'); assert.equal(status.current, 'testers');
  assert.deepEqual(status.preview, preview.preview); assert.equal(status.ipCheck?.allowed, true);
  assert.equal((await action(service, 'confirm', { step: 'testers' })).current, 'category');
  for (const step of ['category', 'review', 'filing', 'release']) await action(service, 'confirm', { step });
  assert.equal((await service.status('demo')).current, null);
  const second = await action(service, 'upload');
  assert.equal(uploaded.version, '2.4.10'); assert.equal(uploaded.desc, 'OpenDesign upload');
  // A new version must be set as trial version, reviewed and released again.
  assert.equal(second.nextVersion, '2.4.11'); assert.equal(second.current, 'testers');
}));

test('uncertain uploads refuse same-version retries until confirmed present/missing or confirmMissing', () => fixture(async workspace => {
  let fail = true, calls = 0;
  const service = await configured(workspace, fakeCi({ upload: async () => { calls++; if (fail) throw new Error('WeChat did not answer in time'); return {}; } }));
  const unknown = await action(service, 'upload');
  assert.equal(unknown.upload?.state, 'unknown'); assert.equal(unknown.uploadedVersion, null);
  assert.deepEqual(unknown.result, { outcome: 'unknown', version: '1.0.0', checkWhere: 'Mini Program console → Management → Version management → Development versions' });
  assert.equal(unknown.steps.find(step => step.key === 'upload')?.status, 'unknown');
  await assert.rejects(action(service, 'upload'), { code: 'UPLOAD_UNCONFIRMED', status: 409 }); assert.equal(calls, 1);
  const present = await action(service, 'confirm_upload', { present: true });
  assert.equal(present.upload?.state, 'done'); assert.equal(present.uploadedVersion, '1.0.0'); assert.equal(present.nextVersion, '1.0.1');
  await action(service, 'upload');
  const missing = await action(service, 'confirm_upload', { present: false });
  assert.equal(missing.upload?.state, 'failed'); assert.equal(missing.upload?.error, 'Not in Version management');
  assert.equal(missing.uploadedVersion, '1.0.0');
  await action(service, 'upload');
  await assert.rejects(action(service, 'upload'), { code: 'UPLOAD_UNCONFIRMED' });
  fail = false;
  assert.equal((await action(service, 'upload', { confirmMissing: true })).upload?.state, 'done');
  assert.equal(calls, 4);
}));

test('all transport ambiguity messages produce unknown; other failures are blocked and secrets never persist', () => fixture(async workspace => {
  let message = '';
  const service = await configured(workspace, fakeCi({ upload: async (options: any) => { throw new Error(`${message} ${key} ${options.project.options.privateKeyPath} ${service.keyDirectory}`); } }));
  for (const error of ['ETIMEDOUT', 'ECONNRESET', 'socket hang up', 'WeChat worker exited without a result', 'Invalid WeChat worker result', 'appid mismatch']) {
    message = error;
    const status = await action(service, 'upload', { confirmMissing: true });
    const expected = error === 'appid mismatch' ? 'failed' : 'unknown';
    assert.equal(status.upload?.state, expected);
    assert.equal(status.steps.find(step => step.key === 'upload')?.status, expected === 'failed' ? 'blocked' : 'unknown');
    noKey(status);
    for (const value of [JSON.stringify(status), await readFile(statePath(workspace), 'utf8')]) {
      assert.ok(!value.includes('PRIVATE KEY')); assert.ok(!value.includes(service.keyDirectory));
    }
  }
  await assert.rejects(action(service, 'confirm_upload', { present: true }), { code: 'UPLOAD_NOT_UNKNOWN' });
}));

test('credentials validate, save atomically with private permissions, list and delete without exposing PEM', () => fixture(async workspace => {
  const service = serviceFor(workspace);
  for (const invalid of ['wx123', '../escape', '', null]) {
    const result = await request(service, 'PUT', '/credentials', { appid: invalid, privateKey: key });
    assert.equal(result.status, 400);
    assert.equal(errorCode(result), 'INVALID_APPID'); noKey(result);
  }
  for (const privateKey of ['', '-----BEGIN certificate-----', null, key + 'x'.repeat(16384)]) {
    const result = await request(service, 'PUT', '/credentials', { appid, privateKey });
    assert.equal(errorCode(result), 'INVALID_KEY'); noKey(result);
  }
  const malformed = await service.handle('PUT', prefix + '/credentials', async () => { throw new Error(key); });
  assert.equal(errorCode(malformed), 'INVALID_REQUEST'); noKey(malformed);
  assert.deepEqual((await request(service, 'GET', `/credentials/${appid}`)).data, { appid, hasKey: false, savedAt: null });
  const saved = await request(service, 'PUT', '/credentials', { appid: appid.toUpperCase(), privateKey: key });
  assert.equal(saved.status, 200); noKey(saved);
  const keyPath = path.join(service.keyDirectory, `private.${appid}.key`);
  assert.equal(await readFile(keyPath, 'utf8'), key);
  if (process.platform !== 'win32') {
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
    assert.equal((await stat(service.keyDirectory)).mode & 0o777, 0o700);
  }
  assert.deepEqual(await readdir(service.keyDirectory), [`private.${appid}.key`]);
  const savedAt = (await stat(keyPath)).mtime.toISOString();
  const list = await request(service, 'GET', '/credentials');
  assert.deepEqual(list.data, { saved: [{ appid, savedAt }] }); noKey(list);
  const detail = await request(service, 'GET', `/credentials/${appid}`);
  assert.deepEqual(detail.data, { appid, hasKey: true, savedAt }); noKey(detail);
  assert.equal(errorCode(await request(service, 'DELETE', '/credentials/invalid')), 'INVALID_APPID');
  assert.deepEqual((await request(service, 'DELETE', `/credentials/${appid}`)).data, { appid, hasKey: false });
  assert.deepEqual((await request(service, 'GET', '/credentials')).data, { saved: [] });
}));

test('project lookup uses the game store, skips hidden/dependency files and caps inventory', () => fixture(async workspace => {
  const service = serviceFor(workspace);
  const projectDir = await project(workspace);
  await mkdir(path.join(projectDir, 'assets'));
  await mkdir(path.join(projectDir, 'node_modules'));
  await writeFile(path.join(projectDir, '.secret'), key);
  await writeFile(path.join(projectDir, 'node_modules', 'skip.js'), 'skip');
  await writeFile(path.join(projectDir, 'assets', 'sprite.png'), 'sprite');
  await writeFile(path.join(projectDir, 'project.config.json'), '{}');
  const result = await request(service, 'GET', '/project/demo');
  assert.equal(result.status, 200);
  const data = result.data as any;
  assert.equal(data.projectDir, projectDir);
  assert.equal(data.exists, true);
  assert.equal(data.hasGameJs, true); assert.equal(data.hasGameJson, true); assert.equal(data.hasProjectConfig, true);
  assert.equal(data.mainPackageLimitBytes, 4194304);
  assert.deepEqual(data.files.map((file: any) => file.path).sort(), ['assets/sprite.png', 'game.js', 'game.json', 'project.config.json']);
  assert.equal(data.totalBytes, 18); noKey(result);
  await Promise.all(Array.from({ length: 501 }, (_, i) => writeFile(path.join(projectDir, 'assets', `${i}.txt`), 'x')));
  const capped = (await request(service, 'GET', '/project/demo')).data as any;
  assert.equal(capped.files.length, 500); assert.equal(capped.totalBytes, 519);
  await rm(projectDir, { recursive: true });
  const missing = (await request(service, 'GET', '/project/demo')).data as any;
  assert.equal(missing.exists, false); assert.deepEqual(missing.files, []); assert.equal(missing.hasGameJs, false);
  assert.equal(errorCode(await request(service, 'GET', '/project/%2e%2e%2foutside')), 'PROJECT_MISSING');
}));

test('preview returns a PNG data URL, upload preserves metadata, and temporary PNG is removed', () => fixture(async workspace => {
  const projectDir = await project(workspace);
  let png = '';
  const ci = fakeCi({ preview: async (options: any) => {
    png = options.qrcodeOutputDest;
    assert.equal(options.desc, 'OpenDesign preview'); assert.equal(options.robot, 1);
    assert.equal(options.project.options.projectPath, projectDir);
    assert.deepEqual(options.project.options.ignores, ['node_modules/**/*', 'mock-*.js', 'port-report.json']);
    assert.equal(options.project.options.type, 'miniGame');
    assert.deepEqual(options.setting, { es6: true, minify: true });
    await writeFile(png, Buffer.from([137, 80, 78, 71]));
  } });
  const service = serviceFor(workspace, { loadCi: async () => ci });
  await request(service, 'PUT', '/credentials', { appid, privateKey: key });
  const preview = await request(service, 'POST', '/preview', { gameId: 'demo', appid });
  assert.equal(preview.status, 200); noKey(preview);
  assert.equal((preview.data as any).qrcode, 'data:image/png;base64,iVBORw==');
  assert.ok(Date.parse((preview.data as any).createdAt));
  await assert.rejects(stat(path.dirname(png)), { code: 'ENOENT' });
  const upload = await request(service, 'POST', '/upload', { gameId: 'demo', appid, version: '1.2.3', desc: 'Test upload' });
  assert.equal(upload.status, 200); noKey(upload);
  assert.equal((upload.data as any).version, '1.2.3');
  assert.deepEqual((upload.data as any).subPackageInfo, [{ name: 'main', size: 10 }]);
}));

test('validation, missing prerequisites and lazy module failure map to structured errors', () => fixture(async workspace => {
  const service = serviceFor(workspace, { loadCi: async () => { throw new Error('module unavailable'); } });
  assert.equal(errorCode(await request(service, 'POST', '/upload', { appid, version: 'v1' })), 'INVALID_VERSION');
  assert.equal(errorCode(await request(service, 'POST', '/upload', { appid, version: '1.0.0', desc: 'x'.repeat(201) })), 'INVALID_DESC');
  assert.equal(errorCode(await request(service, 'POST', '/preview', { appid })), 'KEY_MISSING');
  await request(service, 'PUT', '/credentials', { appid, privateKey: key });
  assert.equal(errorCode(await request(service, 'POST', '/preview', { appid, gameId: 'demo' })), 'PROJECT_MISSING');
  const dir = await project(workspace);
  await rm(path.join(dir, 'game.js'));
  assert.equal(errorCode(await request(service, 'POST', '/preview', { appid, gameId: 'demo' })), 'PROJECT_MISSING');
  await writeFile(path.join(dir, 'game.js'), '');
  const missing = await request(service, 'POST', '/preview', { appid, gameId: 'demo' });
  assert.equal(missing.status, 500); assert.equal(errorCode(missing), 'WECHAT_CI_MISSING'); noKey(missing);
}));

test('CI errors preserve WeChat details, redact key/path/PEM, clean temp files and release the lock', () => fixture(async workspace => {
  await project(workspace);
  let png = '';
  const service = serviceFor(workspace, { loadCi: async () => fakeCi({ preview: async (options: any) => {
    png = options.qrcodeOutputDest;
    throw Object.assign(new Error(`IP not on allowlist ${options.project.options.privateKeyPath} ${key}`), { errCode: 40013, errMsg: 'appid mismatch' });
  } }) });
  await request(service, 'PUT', '/credentials', { appid, privateKey: key });
  for (let i = 0; i < 2; i++) {
    const result = await request(service, 'POST', '/preview', { appid, gameId: 'demo' });
    assert.equal(result.status, 502); assert.equal(errorCode(result), 'WECHAT_CI_ERROR'); noKey(result);
    assert.match((result.data as any).error.message, /IP not on allowlist/);
    assert.match((result.data as any).error.message, /40013: appid mismatch/);
    assert.ok(!JSON.stringify(result).includes(service.keyDirectory));
    await assert.rejects(stat(path.dirname(png)), { code: 'ENOENT' });
  }
}));

test('BUSY covers preview and upload across service instances for the same appid', () => fixture(async workspace => {
  await project(workspace);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const ci = fakeCi({ preview: async (options: any) => { entered(); await gate; await writeFile(options.qrcodeOutputDest, 'png'); } });
  const service = serviceFor(workspace, { loadCi: async () => ci });
  const second = serviceFor(workspace, { loadCi: async () => ci });
  await request(service, 'PUT', '/credentials', { appid, privateKey: key });
  const pending = request(service, 'POST', '/preview', { appid, gameId: 'demo' });
  try {
    await started;
    for (const route of ['/preview', '/upload']) {
      const result = await request(second, 'POST', route, { appid, gameId: 'demo', version: '1.0.0', desc: '' });
      assert.equal(result.status, 409); assert.equal(errorCode(result), 'BUSY');
    }
  } finally { release(); }
  assert.equal((await pending).status, 200);
  assert.equal((await request(second, 'POST', '/upload', { appid, gameId: 'demo', version: '1.0.0', desc: '' })).status, 200);
}));

test('environment reports DevTools only and makes no public-IP lookup', () => fixture(async workspace => {
  const service = serviceFor(workspace, { platform: 'linux' });
  assert.deepEqual((await request(service, 'GET', '/environment')).data, { devtools: { installed: false, path: null, platform: 'linux' } });
}));

test('ip-check previews a throwaway project and returns the address WeChat saw from -10008', () => fixture(async workspace => {
  let seen: any;
  const blocked = serviceFor(workspace, { loadCi: async () => fakeCi({ preview: async (options: any) => {
    seen = options;
    const projectPath = options.project.options.projectPath;
    assert.deepEqual((await readdir(projectPath)).sort(), ['game.js', 'game.json']);
    assert.equal(options.desc, 'OpenDesign IP check');
    throw Object.assign(new Error(`upload failed ${key}`), { errCode: -10008, errMsg: 'invalid ip: 198.51.100.7, reference: https://developers.weixin.qq.com/' });
  } }) });
  assert.equal(errorCode(await request(blocked, 'POST', '/ip-check', { appid })), 'KEY_MISSING');
  await request(blocked, 'PUT', '/credentials', { appid, privateKey: key });
  const result = await request(blocked, 'POST', '/ip-check', { appid });
  assert.equal(result.status, 200); noKey(result);
  assert.equal((result.data as any).allowed, false);
  assert.equal((result.data as any).ip, '198.51.100.7');
  await assert.rejects(stat(path.dirname(seen.project.options.projectPath)), { code: 'ENOENT' });
  const allowed = serviceFor(workspace, { loadCi: async () => fakeCi() });
  assert.equal(((await request(allowed, 'POST', '/ip-check', { appid })).data as any).allowed, true);
  const other = serviceFor(workspace, { loadCi: async () => fakeCi({ preview: async () => { throw new Error(`bad sign ${key}`); } }) });
  const failed = await request(other, 'POST', '/ip-check', { appid });
  assert.equal(failed.status, 502); assert.equal(errorCode(failed), 'WECHAT_CI_ERROR'); noKey(failed);
}));

test('project inventory rejects symlinks instead of exposing files outside the game', { skip: process.platform === 'win32' }, () => fixture(async workspace => {
  const dir = await project(workspace);
  await symlink(path.join(workspace, 'games', 'demo', 'game.json'), path.join(dir, 'external.json'));
  const result = await request(serviceFor(workspace), 'GET', '/project/demo');
  assert.equal(result.status, 400); assert.equal(errorCode(result), 'PROJECT_MISSING');
}));

test('hidden files and hidden folders cannot smuggle a symlink into the upload', { skip: process.platform === 'win32' }, () => fixture(async workspace => {
  const dir = await project(workspace);
  const outside = path.join(workspace, 'secret.json');
  await writeFile(outside, '{"secret":true}');
  await symlink(outside, path.join(dir, '.private.json'));
  let result = await request(serviceFor(workspace), 'GET', '/project/demo');
  assert.equal(result.status, 400); assert.equal(errorCode(result), 'PROJECT_MISSING');
  await rm(path.join(dir, '.private.json'));
  await mkdir(path.join(dir, '.cache'));
  await symlink(outside, path.join(dir, '.cache', 'x.json'));
  result = await request(serviceFor(workspace), 'GET', '/project/demo');
  assert.equal(result.status, 400); assert.equal(errorCode(result), 'PROJECT_MISSING');
}));

const workerModule = new URL('../gateway/wechat-ci-worker.ts', import.meta.url).href;
async function workerFixture(workspace: string, script: string, workerTimeoutMs = 5000) {
  const workerPath = path.join(workspace, 'fake-worker.mjs');
  await writeFile(workerPath, script);
  const service = serviceFor(workspace, { workerPath, workerTimeoutMs });
  await request(service, 'PUT', '/credentials', { appid, privateKey: key });
  return { service, workerPath };
}
const uploadBody = { appid, gameId: 'demo', version: '1.0.0', desc: 'Worker test' };

test('worker fatal handlers contain asynchronous unhandled rejection and uncaught exception; daemon stays alive', () => fixture(async workspace => {
  await project(workspace);
  const { service, workerPath } = await workerFixture(workspace, '');
  for (const fatal of [
    "Promise.reject(Object.assign(new Error('Error: CodeError: errCode: -1; errMsg: empty content'), { code: 20001 }))",
    "(() => { throw new Error('CodeError: Error: errCode: -1; errMsg: empty content'); })()",
  ]) {
    await writeFile(workerPath, `
      import { runWechatCiWorker } from ${JSON.stringify(workerModule)};
      void runWechatCiWorker(async () => ({
        Project: class {},
        upload: () => new Promise(() => { setTimeout(() => { ${fatal}; }, 10); })
      }));
    `);
    const result = await request(service, 'POST', '/upload', uploadBody);
    assert.equal(result.status, 502); assert.equal(errorCode(result), 'WECHAT_CI_ERROR'); noKey(result);
    assert.equal((result.data as any).error.message, 'errCode: -1; errMsg: empty content');
    assert.equal((await request(service, 'GET', `/credentials/${appid}`)).status, 200);
  }
  // A later successful request proves the lock was released after both fatal failures.
  await writeFile(workerPath, `import { writeSync } from 'node:fs'; writeSync(3, JSON.stringify({ ok: true, data: {} }) + '\\n');`);
  assert.equal((await request(service, 'POST', '/upload', uploadBody)).status, 200);
}));

test('worker exit without a result uses only the last 2 KB of stderr and scrubs key/path/PEM', () => fixture(async workspace => {
  await project(workspace);
  const { service } = await workerFixture(workspace, `
    import { readFileSync, writeSync } from 'node:fs';
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const job = JSON.parse(input);
    console.log(JSON.stringify({ ok: true, data: {} }));
    const key = readFileSync(job.privateKeyPath, 'utf8');
    writeSync(2, 'excluded prefix' + 'x'.repeat(3000) + ' worker failed ' + job.privateKeyPath + ' ' + key);
    process.exit(1);
  `);
  const result = await request(service, 'POST', '/upload', uploadBody);
  assert.equal(result.status, 502); assert.equal(errorCode(result), 'WECHAT_CI_ERROR'); noKey(result);
  const message = (result.data as any).error.message;
  assert.match(message, /worker failed/); assert.ok(!message.includes('excluded prefix'));
  assert.ok(!message.includes(service.keyDirectory)); assert.ok(Buffer.byteLength(message) <= 2048);
  const again = await request(service, 'POST', '/upload', uploadBody);
  assert.equal(again.status, 502); assert.notEqual(errorCode(again), 'BUSY');
}));

test('worker timeout kills the child, removes preview temp directory and releases BUSY', () => fixture(async workspace => {
  await project(workspace);
  const pidFile = path.join(workspace, 'timed-out.pid');
  const { service } = await workerFixture(workspace, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => {}, 1000);
  `, 150);
  const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith('openmotion-wechat-')));
  for (let i = 0; i < 2; i++) {
    const result = await request(service, 'POST', '/preview', { appid, gameId: 'demo' });
    assert.equal(result.status, 502); assert.equal(errorCode(result), 'WECHAT_CI_ERROR'); noKey(result);
    assert.equal((result.data as any).error.message, 'WeChat did not answer in time');
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
  const after = (await readdir(tmpdir())).filter(name => name.startsWith('openmotion-wechat-') && !before.has(name));
  assert.deepEqual(after, []);
}));

test('fd 3 separates results from SDK chatter and jobs contain paths instead of key text', () => fixture(async workspace => {
  await project(workspace);
  const { service } = await workerFixture(workspace, `
    import assert from 'node:assert/strict';
    import { writeSync, writeFileSync } from 'node:fs';
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const job = JSON.parse(input);
    assert.ok(!input.includes('-----BEGIN'));
    assert.deepEqual(process.argv.slice(2), []);
    assert.equal(job.appid, '${appid}');
    console.log('{"ok":false,"message":"stdout is not a result"}');
    console.error('stderr is not a result');
    if (job.kind === 'preview') writeFileSync(job.qrcodeOutputDest, 'png');
    else { assert.equal(job.version, '1.0.0'); assert.equal(job.desc, 'Worker test'); }
    writeSync(3, JSON.stringify({ ok: true, data: { subPackageInfo: [{ name: 'main', size: 123 }] } }) + '\\n');
  `);
  const preview = await request(service, 'POST', '/preview', { appid, gameId: 'demo' });
  assert.equal(preview.status, 200); assert.equal((preview.data as any).qrcode, 'data:image/png;base64,cG5n');
  const upload = await request(service, 'POST', '/upload', uploadBody);
  assert.equal(upload.status, 200); assert.deepEqual((upload.data as any).subPackageInfo, [{ name: 'main', size: 123 }]);
}));

test('credentials discover console-downloaded filenames and ignore invalid names, directories and symlinks', () => fixture(async workspace => {
  const service = serviceFor(workspace);
  await mkdir(service.keyDirectory, { mode: 0o700 });
  const downloaded = path.join(service.keyDirectory, `private.${appid}.key`);
  await writeFile(downloaded, key, { mode: 0o600 });
  await writeFile(path.join(service.keyDirectory, `${appid}.key`), key);
  await writeFile(path.join(service.keyDirectory, 'private.wxinvalid.key'), key);
  await writeFile(path.join(service.keyDirectory, `private.${appid}.key.tmp`), key);
  await mkdir(path.join(service.keyDirectory, 'private.wx1111111111111111.key'));
  if (process.platform !== 'win32') await symlink(downloaded, path.join(service.keyDirectory, 'private.wx2222222222222222.key'));
  const savedAt = (await stat(downloaded)).mtime.toISOString();
  const list = await request(service, 'GET', '/credentials');
  assert.deepEqual(list.data, { saved: [{ appid, savedAt }] }); noKey(list);
  const detail = await request(service, 'GET', `/credentials/${appid}`);
  assert.deepEqual(detail.data, { appid, hasKey: true, savedAt }); noKey(detail);
  if (process.platform !== 'win32') {
    const linked = await request(service, 'GET', '/credentials/wx2222222222222222');
    assert.deepEqual(linked.data, { appid: 'wx2222222222222222', hasKey: false, savedAt: null }); noKey(linked);
  }
  const removed = await request(service, 'DELETE', `/credentials/${appid}`);
  assert.deepEqual(removed.data, { appid, hasKey: false }); noKey(removed);
  await assert.rejects(stat(downloaded), { code: 'ENOENT' });
  assert.deepEqual((await request(service, 'GET', '/credentials')).data, { saved: [] });
}));

test('a different AppID drops steps confirmed for the old Mini Game; the same AppID keeps them', () => fixture(async workspace => {
  const service = await configured(workspace);
  await action(service, 'confirm', { step: 'account' });
  await action(service, 'upload');
  for (const step of ['testers', 'category', 'review', 'filing', 'release']) await action(service, 'confirm', { step });
  const same = await action(service, 'set_appid', { appid });
  assert.deepEqual(same.steps.filter(step => step.later || step.key === 'testers').map(step => step.status), ['done', 'done', 'done', 'done', 'done']);
  const changed = await action(service, 'set_appid', { appid: 'wxfedcba9876543210' });
  const by = Object.fromEntries(changed.steps.map(step => [step.key, step.status]));
  assert.equal(by.account, 'done');
  for (const step of ['testers', 'category', 'review', 'filing', 'release']) assert.equal(by[step], 'todo', step);
  assert.deepEqual(Object.keys((await stateFile(workspace)).confirmed), ['account']);
}));

test('uploading a new version undoes trial version, review and release, but keeps category and filing', () => fixture(async workspace => {
  const service = await configured(workspace);
  await action(service, 'confirm', { step: 'account' });
  await action(service, 'upload', { version: '1.0.0' });
  for (const step of ['testers', 'category', 'review', 'filing', 'release']) await action(service, 'confirm', { step });
  const statusOf = (value: any, key: string) => value.steps.find((step: any) => step.key === key).status;
  assert.equal(statusOf(await action(service, 'status'), 'release'), 'done');
  const next = await action(service, 'upload', { version: '1.0.1' });
  const by = Object.fromEntries(next.steps.map(step => [step.key, step.status]));
  assert.equal(by.upload, 'done'); assert.equal(by.category, 'done'); assert.equal(by.filing, 'done');
  for (const step of ['testers', 'review', 'release']) assert.equal(by[step], 'todo', step);
  // Uploading again under the same version number is still new code: confirm again.
  for (const step of ['testers', 'review', 'release']) await action(service, 'confirm', { step });
  const again = await action(service, 'upload', { version: '1.0.1' });
  for (const step of ['testers', 'review', 'release']) assert.equal(statusOf(again, step), 'todo', step);
  assert.equal(statusOf(again, 'category'), 'done'); assert.equal(statusOf(again, 'filing'), 'done');
}));

test('an uncertain upload confirmed present counts as a new version', () => fixture(async workspace => {
  let fail = false;
  const service = await configured(workspace, fakeCi({ upload: async () => { if (fail) throw new Error('WeChat did not answer in time'); return {}; } }));
  await action(service, 'confirm', { step: 'account' });
  await action(service, 'upload', { version: '1.0.0' });
  for (const step of ['testers', 'review', 'release']) await action(service, 'confirm', { step });
  fail = true;
  const unknown = await action(service, 'upload', { version: '1.0.1' });
  assert.equal(unknown.result.outcome, 'unknown');
  const confirmed = await action(service, 'confirm_upload', { present: true });
  const by = Object.fromEntries(confirmed.steps.map(step => [step.key, step.status]));
  assert.equal(confirmed.uploadedVersion, '1.0.1');
  for (const step of ['testers', 'review', 'release']) assert.equal(by[step], 'todo', step);
}));

test('publish records are not served as game files, exported or copied by a remix', () => fixture(async workspace => {
  const service = await configured(workspace);
  await action(service, 'preview');
  const { gameProjectsFor } = await import('../game-projects.ts');
  const games = gameProjectsFor(workspace);
  for (const relative of ['publish/wechat.json', 'publish/wechat-preview.png', 'x/../publish/wechat.json', './publish/wechat.json']) {
    await assert.rejects(games.staticFile('demo', relative), /Private game metadata|not found|outside/i, relative);
  }
  const archive = await games.exportZip('demo');
  assert.ok(!archive.data.includes(Buffer.from('publish/wechat.json')));
}));
