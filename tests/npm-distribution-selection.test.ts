import { onboardingTemplateIds, onboardingSourceFiles, builtinRecommendationIds } from '../shared/onboarding-templates.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distributionFiles } from '../scripts/distribution.ts';
import { prepareInlineOnboarding, publishInlineOnboarding } from '../scripts/inline-onboarding.mjs';
import { runFile } from '../scripts/runtime-assets.mjs';

const appRoot = fileURLToPath(new URL('../', import.meta.url));

test('application selection validates only its selected positive-list files', async () => {
  assert.deepEqual(await distributionFiles('phase1', file => file === '.codex-plugin/plugin.json'), ['.codex-plugin/plugin.json']);
});

test('an empty application selection does not require optional showcase downloads', async () => {
  assert.deepEqual(await distributionFiles('phase1', () => false), []);
});

test('the onboarding distribution keeps the in-turn renderer without the retired queue scheduler', async () => {
  const files = await distributionFiles('phase1', file => /^scripts\/(?:install-onboarding|inline-onboarding|onboarding-callback)\.mjs$/.test(file));
  assert.deepEqual(files.sort(), ['scripts/inline-onboarding.mjs', 'scripts/install-onboarding.mjs']);
});

test('packaged onboarding prepares and publishes real cards from the allowlist without dependencies', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'om-packaged-onboarding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeFiles = new Set(['package.json', 'template-library.ts', 'hyperframes.ts',
    'shared/export-spec.ts', 'shared/mcp-template-recommendations.ts', 'shared/onboarding-templates.ts', ...onboardingSourceFiles,
    'scripts/inline-onboarding.mjs', 'scripts/runtime-assets.mjs', 'scripts/onboarding-catalog.ts',
    'shared/template-config.ts', 'shared/template-config.json']);
  for (const profile of ['phase1', 'legacy']) {
    const installedRoot = path.join(directory, profile);
    // Select only the renderer's runtime closure from the actual package allowlist.
    // Nothing is copied from the source tree unless distributionFiles ships it.
    const files = await distributionFiles(profile, file => runtimeFiles.has(file)
      || file.startsWith('mcp-ui/template-recommendations/')
      || /^template-library\/(?:product-promo\/|nyt-graph\/|decision-tree\/|LICENSE$|NOTICE\.md$)/.test(file));
    for (const file of files) {
      const target = path.join(installedRoot, file);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(appRoot, file), target);
    }
    const prepared = await prepareInlineOnboarding({ appRoot: installedRoot,
      output: path.join(directory, profile + '.html'), language: 'zh', templateIds: onboardingTemplateIds.slice(-3) });
    assert.equal(prepared.status, 'native_required');
    assert.equal(prepared.path, undefined);
    assert.deepEqual(prepared.templateIds, onboardingTemplateIds.slice(-3));
    const catalog = JSON.parse(await runFile(process.execPath, ['--experimental-strip-types',
      path.join(installedRoot, 'scripts/onboarding-catalog.ts'), '--template-ids', JSON.stringify(prepared.templateIds)], { cwd: directory }));
    assert.deepEqual(catalog.templates.map((item: any) => item.templateId), prepared.templateIds);
    assert.equal(catalog.recommendedTemplateId, prepared.templateIds[0]);
    assert(catalog.templates.every((item: any) => item.kind === 'reference'));
    assert.match(catalog.selectionGuide, /yes.*named recommendation/i);
    const bundled = await prepareInlineOnboarding({ appRoot: installedRoot, output: path.join(directory, profile + '-bundled.html'),
      language: 'zh', templateIds: [...builtinRecommendationIds] });
    const published = await publishInlineOnboarding({ source: bundled.path,
      expectedSHA256: bundled.sha256, hostDirectory: path.join(directory, 'host') });
    assert.equal(published.status, 'published');
    assert.equal(published.sha256, bundled.sha256);
    assert.equal(await readFile(published.path, 'utf8'), await readFile(bundled.path, 'utf8'));
  }
});


test('both distribution profiles include the complete project archive entry points', async () => {
  const required = ['project-management.ts', 'shared/project-management.ts', 'project-archive.ts', 'shared/project-archive.ts', 'shared/project-zip.ts', 'gateway/project-archive-http.ts', 'scripts/zip.mjs', 'docs/project-archives.md'];
  for (const profile of ['phase1', 'legacy']) {
    assert.deepEqual(await distributionFiles(profile, file => required.includes(file)), [...required].sort());
  }
});
