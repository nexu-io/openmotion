import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildPlugin } from '../integrations/dsh/build.ts';
import { prepareCandidatePlugin } from '../integrations/dsh/release.ts';
import { downloadOrigin, downloadPrefix, downloadPlugin, downloadManifestUrl, manifestUrl, validateDownload } from '../integrations/dsh/download.ts';
import { publishPlugin } from '../integrations/dsh/publish.ts';

const commit = 'a'.repeat(40);
const archive = Buffer.from('a test plugin archive');
const sha256 = createHash('sha256').update(archive).digest('hex');
const manifest = { schemaVersion: 1 as const, name: 'openmotion-dsh' as const, version: '0.1.0', dshVersion: '0.2.2-rc.1', sourceCommit: commit, bytes: archive.length, sha256, tarballUrl: `${downloadOrigin}/${downloadPrefix}/snapshots/${commit}/${sha256}/openmotion-dsh.tgz` };

test('public plugin downloads bind an immutable URL to a source commit and digest', () => {
  assert.equal(validateDownload(manifest), manifest);
  for (const invalid of [
    { schemaVersion: 2 }, { sourceCommit: 'main' }, { sha256: 'bad' }, { bytes: -1 },
    { version: 'latest' }, { dshVersion: '*' }, { tarballUrl: 'https://example.com/evil.tgz' },
    { tarballUrl: `${downloadOrigin}/${downloadPrefix}/main/openmotion-dsh.tgz` },
  ]) assert.throws(() => validateDownload({ ...manifest, ...invalid } as typeof manifest));
});

test('download helper follows one manifest snapshot, verifies bytes and preserves existing files', async t => {
  const destination = await mkdtemp(path.join(tmpdir(), 'dsh-download-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const requests: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push(String(url)); assert.equal(init?.redirect, 'error');
    return String(url) === manifestUrl ? Response.json(manifest) : new Response(archive);
  };
  const result = await downloadPlugin(destination, fetcher);
  assert.deepEqual(requests, [manifestUrl, manifest.tarballUrl]);
  assert.deepEqual(await readFile(result.filename), archive);
  assert.equal(result.sourceCommit, commit);
  await assert.rejects(downloadPlugin(destination, fetcher), { code: 'EEXIST' });
  assert.deepEqual(await readFile(result.filename), archive);
});

test('download failure or corrupt bytes never create an installable file', async t => {
  const destination = await mkdtemp(path.join(tmpdir(), 'dsh-download-fail-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  for (const broken of [new Response('missing', { status: 404 }), new Response(Buffer.alloc(archive.length))]) {
    await assert.rejects(downloadPlugin(destination, async url => String(url) === manifestUrl ? Response.json(manifest) : broken));
    assert.deepEqual(await readdir(destination), []);
  }
  await assert.rejects(downloadPlugin(destination, async () => new Response('not yet published', { status: 404 })), /source build/);
});

async function publicationFixture(t: any) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'plugin.tgz'); await writeFile(filename, archive);
  const objects = new Map<string, Buffer>(), writes: string[] = [], verified: string[] = [];
  const execute = async (command: string, args: string[]) => {
    assert.equal(command, 'aws'); assert(args.includes('s3api'));
    const key = args[args.indexOf('--key') + 1];
    if (key.includes('/snapshots/')) assert(args.includes('--if-none-match'));
    else assert(verified.includes(manifest.tarballUrl), 'The public package must pass verification before promoting its pointer');
    writes.push(key); objects.set(key, await readFile(args[args.indexOf('--body') + 1])); return '{}';
  };
  const fetcher: typeof fetch = async url => {
    verified.push(String(url));
    const bytes = objects.get(new URL(String(url)).pathname.slice(1));
    return new Response(bytes ?? 'missing', { status: bytes ? 200 : 404 });
  };
  const config = { commit, endpoint: 'https://example.r2.cloudflarestorage.com', bucket: 'example-releases', archive: filename, version: manifest.version, dshVersion: manifest.dshVersion };
  return { config, execute, fetcher, objects, writes, currentCommit: async () => commit };
}

test('publisher verifies the tarball before updating the fixed entry and verifies that entry too', async t => {
  const fixture = await publicationFixture(t);
  assert.deepEqual(await publishPlugin(fixture.config, fixture), manifest);
  assert.deepEqual(fixture.writes, [new URL(manifest.tarballUrl).pathname.slice(1), `${downloadPrefix}/main/latest.json`]);
  const destination = await mkdtemp(path.join(tmpdir(), 'dsh-cold-download-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const downloaded = await downloadPlugin(destination, fixture.fetcher, 'main');
  assert.deepEqual(await readFile(downloaded.filename), archive);
});

test('failed public verification and stale main builds retain the previous download entry', async t => {
  for (const failure of ['verification', 'stale']) {
    const fixture = await publicationFixture(t);
    const pointer = `${downloadPrefix}/main/latest.json`, previous = Buffer.from('previous download');
    fixture.objects.set(pointer, previous);
    if (failure === 'verification') fixture.fetcher = async () => new Response('wrong bytes');
    else fixture.currentCommit = async () => 'b'.repeat(40);
    await assert.rejects(publishPlugin(fixture.config, fixture), failure === 'stale' ? /stale/ : /verification/);
    assert.deepEqual(fixture.objects.get(pointer), previous);
    assert.equal(fixture.writes.length, 1);
  }
});

test('rerun accepts an existing immutable object only after public byte verification', async t => {
  const fixture = await publicationFixture(t);
  const key = new URL(manifest.tarballUrl).pathname.slice(1);
  fixture.objects.set(key, archive);
  const execute = async (command: string, args: string[]) => {
    if (args.includes('--if-none-match')) throw new Error('PreconditionFailed (412)');
    return fixture.execute(command, args);
  };
  await publishPlugin(fixture.config, { ...fixture, execute });
  fixture.objects.set(key, Buffer.from('unexpected existing bytes'));
  await assert.rejects(publishPlugin(fixture.config, { ...fixture, execute }), /verification/);
});

test('installation routing and workflow keep plugin distribution separate from npm publication', async () => {
  const install = await readFile(new URL('../docs/templates/legacy-npm-install.md', import.meta.url), 'utf8');
  assert(install.indexOf('## DSH:') < install.indexOf('## Codex:'));
  assert(install.includes(manifestUrl) && install.includes('integrations/dsh/README.md#download-and-install-the-plugin'));
  const workflow = await readFile(new URL('../.github/workflows/dsh-integration.yml', import.meta.url), 'utf8');
  const step = workflow.slice(workflow.indexOf('      - name: Publish verified main plugin downloads'));
  assert(step.includes("github.repository == 'nexu-io/openmotion' && github.ref == 'refs/heads/main'"));
  assert(step.includes("github.event_name == 'push' || github.event_name == 'workflow_dispatch'"));
  assert(!workflow.slice(0, workflow.indexOf(step)).includes('secrets.'));
  assert(step.includes('run: node integrations/dsh/publish.ts'));
  assert(!workflow.includes('npm publish') && !workflow.includes('id-token: write'));
  const filters = [...workflow.matchAll(/paths:\n((?: +- .+\n)+)/g)].map(match => [...match[1].matchAll(/- '([^']+)'/g)].map(item => item[1]));
  assert.equal(filters.length, 2);
  for (const patterns of filters) {
    for (const dependency of ['integrations/dsh/publish.ts', 'tests/dsh-distribution.test.ts', 'tests/dsh-release.test.ts', 'tests/dsh-template-cards.test.ts', '.github/workflows/dsh-integration.yml']) {
      assert(patterns.some(pattern => path.matchesGlob(dependency, pattern)), `DSH checks must run for ${dependency}`);
    }
  }
  assert(workflow.includes('npm run test --prefix integrations/dsh'));
});

test('installable plugin carries the licenses for its bundled icon artwork', async t => {
  const output = await mkdtemp(path.join(tmpdir(), 'dsh-license-package-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  await buildPlugin(output);
  const { stdout } = await promisify(execFile)('npm', ['pack', '--dry-run', '--ignore-scripts', '--json', output]);
  const files = new Set(JSON.parse(stdout)[0].files.map((file: { path: string }) => file.path));
  for (const filename of ['remix-icon-LICENSE.txt', 'remix-icon-NOTICE.txt']) {
    assert(files.has(filename), `Missing bundled artwork license: ${filename}`);
    assert.deepEqual(await readFile(path.join(output, filename)), await readFile(new URL('../packages/design-system/' + filename, import.meta.url)));
    assert((await readFile(path.join(output, 'README.md'), 'utf8')).includes(filename));
  }
});

test('candidate preparation packs the real plugin at the application version without editing source manifests', async t => {
  const output = await mkdtemp(path.join(tmpdir(), 'dsh-release-build-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const run = promisify(execFile);
  const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const original = await readFile(path.join(root, 'integrations/dsh/plugin/package.json'));
  const metadata = await prepareCandidatePlugin(root, output, '0.0.3-test.99', commit);
  const archive = path.join(output, 'openmotion-dsh-0.0.3-test.99.tgz');
  const pkg = JSON.parse((await run('tar', ['-xOf', archive, 'package/package.json'])).stdout);
  assert.equal(pkg.name, 'openmotion-dsh'); assert.equal(pkg.version, '0.0.3-test.99');
  assert.equal(metadata.sourceCommit, commit);
  assert.equal(metadata.sha256, createHash('sha256').update(await readFile(archive)).digest('hex'));
  assert.deepEqual(await readFile(path.join(root, 'integrations/dsh/plugin/package.json')), original);
});

test('DSH installation recovers when bundled CLI rejects read-only --dump-config for Electron-managed desktop profile', async () => {
  const { existsSync } = await import('node:fs');
  const execFileAsync = promisify(execFile);
  const {
    composeProfileModules,
    inspectProfileModules,
    isElectronManagedProfileError,
    workspacePatch,
  } = await import('../integrations/dsh/install.ts');
  const dshIntegrationDir = fileURLToPath(new URL('../integrations/dsh', import.meta.url));
  const dshBin = path.join(dshIntegrationDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js');

  const electronError = Object.assign(
    new Error('Command failed'),
    { stderr: 'error: profile "desktop" is managed exclusively by the Electron application\n' },
  );

  // Root test suite must not require optional integrations/dsh dependencies: verify fallback via mocks first.
  const warnings: string[] = [];
  const mockedDesktopModules = await inspectProfileModules(
    'desktop',
    async () => { throw electronError; },
    async () => ['@deepseek-ai/dsh-action-cards', '@deepseek-ai/dsh-client-ui-action-cards'],
    message => warnings.push(message),
  );
  assert.deepEqual(mockedDesktopModules, ['@deepseek-ai/dsh-action-cards', '@deepseek-ai/dsh-client-ui-action-cards']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /desktop/i);

  // Case-insensitive desktop profile names recover identically.
  const mixedCaseModules = await inspectProfileModules(
    'Desktop',
    async () => { throw electronError; },
    async () => [],
    () => {},
  );
  assert.deepEqual(mixedCaseModules, []);

  // Existing action-cards config overrides in cordis.patch.yml must not be clobbered even when fallback returns [].
  const root = path.resolve('checkout with spaces'), data = path.resolve('workspace data');
  const withCardOverride = [
    '# Keep Desktop overrides',
    '- id: action-cards',
    '  config:',
    '    queuedMessageLimit: 1',
    '',
  ].join('\n');
  const preservedOverridePatch = await workspacePatch(withCardOverride, root, data, process.execPath, []);
  assert(preservedOverridePatch.startsWith(withCardOverride));
  assert(preservedOverridePatch.includes('id: openmotion-workspace'));
  assert(!preservedOverridePatch.includes('@deepseek-ai/dsh-action-cards'));
  assert(preservedOverridePatch.includes('@deepseek-ai/dsh-client-ui-action-cards'));
  assert.equal(await workspacePatch(preservedOverridePatch, root, data, process.execPath, []), preservedOverridePatch);

  // When inherited modules report both cards, neither card entry is duplicated.
  const inheritedPatch = await workspacePatch(withCardOverride, root, data, process.execPath, mockedDesktopModules);
  assert(!inheritedPatch.includes('@deepseek-ai/dsh-action-cards'));
  assert(!inheritedPatch.includes('@deepseek-ai/dsh-client-ui-action-cards'));

  // If a future DSH CLI allows read-only dumps on desktop, inherited modules are still inspected normally.
  const upstreamFixedModules = await inspectProfileModules(
    'desktop',
    async () => ({ stdout: '- id: action-cards\n  name: "@deepseek-ai/dsh-action-cards"\n' }),
    async () => { throw new Error('should not invoke fallback when dump succeeds'); },
    () => { throw new Error('should not warn when dump succeeds'); },
  );
  assert.deepEqual(upstreamFixedModules, ['@deepseek-ai/dsh-action-cards']);

  // Non-Electron failures on desktop (missing binary, broken YAML, unexpected CLI errors) must still fail fast.
  const unexpectedError = Object.assign(new Error('Command failed: unexpected failure'), { stderr: 'YAMLParseError: unexpected token' });
  assert.equal(isElectronManagedProfileError('desktop', unexpectedError), false);
  await assert.rejects(
    inspectProfileModules('desktop', async () => { throw unexpectedError; }, async () => [], () => {}),
    /unexpected failure/,
  );
  await assert.rejects(
    inspectProfileModules('desktop', async () => ({ stdout: 'invalid: [' }), async () => [], () => {}),
    /Could not inspect the existing DSH profile/,
  );

  // Non-desktop profiles must never treat an Electron-profile message as recoverable.
  assert.equal(isElectronManagedProfileError('desktop', electronError), true);
  assert.equal(isElectronManagedProfileError('web', electronError), false);
  await assert.rejects(
    inspectProfileModules('web', async () => { throw electronError; }, async () => [], () => {}),
    /Command failed/,
  );

  // When the optional DSH integration dependencies are installed, exercise the real bundled CLI rejection
  // and verify read-only layer composition preserves inherited bundle cards and action-cards overrides.
  if (existsSync(dshBin)) {
    const dshHome = await mkdtemp(path.join(tmpdir(), 'openmotion-dsh-desktop-'));
    try {
      const profileDir = path.join(dshHome, 'profiles', 'desktop');
      await mkdir(profileDir, { recursive: true });
      const manifestText = JSON.stringify({
        name: 'dsh-profile-desktop',
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-personalized-recommendations'] } },
      }, null, 2) + '\n';
      await writeFile(path.join(profileDir, 'package.json'), manifestText);
      await writeFile(path.join(profileDir, 'cordis.patch.yml'), withCardOverride);

      const composedModules = await inspectProfileModules(
        'desktop',
        () => execFileAsync(process.execPath, [dshBin, '--profile', 'desktop', '--dump-config'], {
          env: { ...process.env, DSH_HOME: dshHome },
        }),
        () => composeProfileModules(profileDir, dshHome, dshIntegrationDir),
        () => {},
      );
      assert(composedModules.includes('@deepseek-ai/dsh-action-cards'));
      assert(composedModules.includes('@deepseek-ai/dsh-client-ui-action-cards'));
      assert.equal(existsSync(path.join(profileDir, 'cordis.yml')), false, 'read-only fallback must not write cordis.yml');

      const finalPatch = await workspacePatch(withCardOverride, root, data, process.execPath, composedModules);
      assert(!finalPatch.includes('@deepseek-ai/dsh-action-cards'));
      assert(!finalPatch.includes('@deepseek-ai/dsh-client-ui-action-cards'));

      // Verify with DSH's actual composeEntries that the user's queuedMessageLimit override survives intact.
      await writeFile(path.join(profileDir, 'cordis.patch.yml'), finalPatch);
      const appBoot = await import(pathToFileURL(path.join(dshIntegrationDir, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href);
      const installAnchor = path.join(dshIntegrationDir, 'node_modules/@deepseek-ai/dsh/package.json');
      const bundleDir = appBoot.resolveBundleDir('dsh', '@deepseek-ai/dsh-personalized-recommendations', installAnchor, profileDir);
      const bundleManifest = appBoot.readProfileManifest('dsh', bundleDir);
      const bundlePatches = appBoot.bundlePatchPaths(bundleDir, bundleManifest.dsh.bundle)
        .flatMap((p: string) => appBoot.loadOverlayPatches('dsh', p));
      const userPatches = appBoot.loadOverlayPatches('dsh', path.join(profileDir, 'cordis.patch.yml'));
      const composed = appBoot.composeEntries([bundlePatches, userPatches]);
      const actionCardsEntries = composed.filter((row: { id?: string }) => row.id === 'action-cards');
      assert.equal(actionCardsEntries.length, 1);
      assert.equal(actionCardsEntries[0].config?.queuedMessageLimit, 1);

      // Incompatible profile-local card bundles must be skipped unless explicitly exempted for the runtime version.
      const compatProfileDir = path.join(dshHome, 'profiles', 'desktop-compat');
      const localBundleDir = path.join(compatProfileDir, 'node_modules', 'dsh-test-future-cards');
      await mkdir(localBundleDir, { recursive: true });
      await writeFile(path.join(localBundleDir, 'package.json'), JSON.stringify({
        name: 'dsh-test-future-cards',
        version: '1.0.0',
        engines: { dsh: '>=99.0.0' },
        dsh: { bundle: { patch: './bundle.patch.yml' } },
      }, null, 2) + '\n');
      await writeFile(path.join(localBundleDir, 'bundle.patch.yml'), [
        '- insert:',
        '    - id: action-cards',
        '      name: "@deepseek-ai/dsh-action-cards"',
        '    - id: client-ui-action-cards',
        '      name: "@deepseek-ai/dsh-client-ui-action-cards"',
        '',
      ].join('\n'));
      await writeFile(path.join(compatProfileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-desktop-compat',
        private: true,
        dsh: { profile: { bundles: ['dsh-test-future-cards'] } },
      }, null, 2) + '\n');
      await writeFile(path.join(compatProfileDir, 'cordis.patch.yml'), '[]\n');

      const skippedIncompatible = await composeProfileModules(compatProfileDir, dshHome, dshIntegrationDir);
      assert(!skippedIncompatible.includes('@deepseek-ai/dsh-action-cards'));
      assert(!skippedIncompatible.includes('@deepseek-ai/dsh-client-ui-action-cards'));
      const patchWhenIncompatible = await workspacePatch('[]\n', root, data, process.execPath, skippedIncompatible);
      assert(patchWhenIncompatible.includes('@deepseek-ai/dsh-action-cards'));
      assert(patchWhenIncompatible.includes('@deepseek-ai/dsh-client-ui-action-cards'));

      const dshPkg = JSON.parse(await readFile(installAnchor, 'utf8')) as { version: string };
      await writeFile(
        path.join(compatProfileDir, appBoot.PROFILE_COMPATIBILITY_FILENAME),
        JSON.stringify({ 'dsh-test-future-cards@1.0.0': [dshPkg.version] }, null, 2) + '\n',
      );
      const includedExempted = await composeProfileModules(compatProfileDir, dshHome, dshIntegrationDir);
      assert(includedExempted.includes('@deepseek-ai/dsh-action-cards'));
      assert(includedExempted.includes('@deepseek-ai/dsh-client-ui-action-cards'));
      const patchWhenExempted = await workspacePatch('[]\n', root, data, process.execPath, includedExempted);
      assert(!patchWhenExempted.includes('@deepseek-ai/dsh-action-cards'));
      assert(!patchWhenExempted.includes('@deepseek-ai/dsh-client-ui-action-cards'));
    } finally {
      await rm(dshHome, { recursive: true, force: true });
    }
  }
});
