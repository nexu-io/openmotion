import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installLibrarySkill } from '../scripts/install-library-skill.mjs';

const pairs = { brandkit: 'openmotion-brandkit', 'presenter-story': 'openmotion-presenter-story', 'motion-design-remix': 'openmotion-design-remix' };
// Original published forwarding bytes, retained only as migration test data.
const aliases = JSON.parse(await readFile(new URL('./legacy-library-aliases.json', import.meta.url), 'utf8'));
async function isolated(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'openmotion-library-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function legacyFixture(root, old) {
  const directory = path.join(root, old);
  for (const [file, content] of Object.entries(aliases[old])) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), content);
  }
  return directory;
}

for (const [old, canonical] of Object.entries(pairs)) {
  test(`standalone ${canonical} removes its unchanged retired entry and reuses one payload`, async t => {
    const root = await isolated(t), destination = path.join(root, 'skills');
    await legacyFixture(destination, old);
    const result = await installLibrarySkill(canonical, destination);
    assert.deepEqual(await readdir(destination), [canonical]);
    assert.equal(result.entry, path.join(destination, canonical, 'SKILL.md'));
    assert.deepEqual(result.removedLegacy, [old]);
    assert.deepEqual(result.preservedLegacy, []);
    assert.equal(await readFile(result.entry, 'utf8'), await readFile(`library/skills/${canonical}/SKILL.md`, 'utf8'));
    assert.deepEqual((await installLibrarySkill(canonical, destination)).installed, [canonical]);
    assert.deepEqual(await readdir(destination), [canonical]);
    if (old === 'presenter-story') {
      assert((await readFile(path.join(destination, canonical, 'references/workflow-demo/MOTION_DESIGN.md'), 'utf8')).length > 100);
      assert((await readFile(path.join(destination, canonical, 'assets/john-tagudin-capso-result.mp4'))).length > 1000);
    }
    if (old === 'motion-design-remix') {
      for (const id of ['ui-3d-reveal', 'wireframe-portal-title', 'canopy-part-title', 'code-3d-extrude', 'code-particle-assemble', 'liquid-glass-widgets']) {
        const output = path.join(root, id);
        const invoked = spawnSync(process.execPath, [path.join(destination, canonical, 'scripts/materialize.mjs'), id, 'remix', output], { cwd: root, encoding: 'utf8' });
        assert.equal(invoked.status, 0, invoked.stderr);
        assert((await readFile(path.join(output, 'index.html'), 'utf8')).length > 100);
        assert((await readFile(path.join(output, 'vendor/manifest.json'), 'utf8')).length > 100);
      }
    }
    await assert.rejects(installLibrarySkill(old, destination), /Unknown Library Skill/);
  });
}

test('standalone openmotion-growth-teardown installs without a retired entry', async t => {
  const root = await isolated(t), destination = path.join(root, 'skills');
  const result = await installLibrarySkill('openmotion-growth-teardown', destination);
  assert.deepEqual(await readdir(destination), ['openmotion-growth-teardown']);
  assert.deepEqual(result.removedLegacy, []);
  assert.deepEqual(result.preservedLegacy, []);
  const check = spawnSync(process.execPath, [path.join(destination, 'openmotion-growth-teardown/scripts/build.mjs'), '--check', 'tests/fixtures/growth-teardown.json'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('growth-teardown --check rejects inputs the generator cannot render', async t => {
  const root = await isolated(t), fixture = JSON.parse(await readFile('tests/fixtures/growth-teardown.json', 'utf8'));
  const build = path.resolve('library/skills/openmotion-growth-teardown/scripts/build.mjs');
  const cases = {
    'needs 1-6 moves': d => { delete d.lanes[0].moves; },
    'must be a full http(s) URL': d => { d.lanes[0].moves[0].source.url = 'example.com/blog/free'; },
    'stat.value must be a number': d => { delete d.plays[0].stat; },
    'longer than 28 characters': d => { d.lanes[0].moves[0].label = 'x'.repeat(29); },
    'keep it under 220': d => { d.plays[0].instruction = 'x'.repeat(221); },
  };
  for (const [message, mutate] of Object.entries(cases)) {
    const data = structuredClone(fixture); mutate(data);
    const file = path.join(root, 'growth.json'); await writeFile(file, JSON.stringify(data));
    const check = spawnSync(process.execPath, [build, '--check', file], { encoding: 'utf8' });
    assert.equal(check.status, 1, `${message}: ${check.stdout}${check.stderr}`);
    assert.match(check.stderr, new RegExp(message.replace(/[()]/g, '\\$&')));
    assert.doesNotMatch(check.stderr, /TypeError|ERR_INVALID_URL/);
  }
});

test('standalone openmotion-design-styles installs and its plan checker runs', async t => {
  const root = await isolated(t), destination = path.join(root, 'skills');
  await installLibrarySkill('openmotion-design-styles', destination);
  assert.deepEqual(await readdir(destination), ['openmotion-design-styles']);
  const script = path.join(destination, 'openmotion-design-styles/scripts/style.mjs');
  const list = spawnSync(process.execPath, [script, 'list'], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout.trim().split('\n').length, 23);
  const check = spawnSync(process.execPath, [script, 'check', 'tests/fixtures/design-styles.json'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('design-styles check rejects plans that would not read as the style', async t => {
  const root = await isolated(t), fixture = JSON.parse(await readFile('tests/fixtures/design-styles.json', 'utf8'));
  const script = path.resolve('library/skills/openmotion-design-styles/scripts/style.mjs');
  const cases = {
    'is not in the library': d => { d.style = 'vaporwave'; },
    'is not on the Swiss Style card': d => { d.colors.push('#00FF00'); },
    'keep it within 48': d => { d.scenes[1].headline = 'x'.repeat(49); },
    'move is required': d => { delete d.scenes[1].move; },
    'seconds must be a number between 1 and 12': d => { d.scenes[0].seconds = '2'; },
    'scenes add up to': d => { d.seconds = 30; },
    'OpenMotion end credit': d => { Object.assign(d.scenes.at(-1), { headline: 'Thanks', body: '', move: 'OpenMotion logo slides out' }); },
  };
  for (const [message, mutate] of Object.entries(cases)) {
    const data = structuredClone(fixture); mutate(data);
    const file = path.join(root, 'plan.json'); await writeFile(file, JSON.stringify(data));
    const check = spawnSync(process.execPath, [script, 'check', file], { encoding: 'utf8' });
    assert.equal(check.status, 1, `${message}: ${check.stdout}${check.stderr}`);
    assert.match(check.stderr, new RegExp(message));
  }
});

test('standalone cleanup preserves customized, extra-file and symlink legacy folders', async t => {
  const root = await isolated(t);
  for (const kind of ['customized', 'extra-file', 'symlink']) {
    const destination = path.join(root, kind), legacy = await legacyFixture(destination, 'brandkit');
    if (kind === 'customized') await writeFile(path.join(legacy, 'SKILL.md'), 'User-owned instructions');
    if (kind === 'extra-file') await writeFile(path.join(legacy, 'notes.md'), 'User notes');
    if (kind === 'symlink') {
      const original = path.join(root, 'original');
      await mkdir(original); await writeFile(path.join(original, 'SKILL.md'), 'User workflow');
      await rm(legacy, { recursive: true });
      await symlink(original, legacy, process.platform === 'win32' ? 'junction' : 'dir');
    }
    const before = await readFile(path.join(legacy, 'SKILL.md'), 'utf8');
    const result = await installLibrarySkill('openmotion-brandkit', destination);
    assert.deepEqual(result.removedLegacy, []);
    assert.deepEqual(result.preservedLegacy, ['brandkit']);
    assert.equal(await readFile(path.join(legacy, 'SKILL.md'), 'utf8'), before);
    if (kind === 'extra-file') assert.equal(await readFile(path.join(legacy, 'notes.md'), 'utf8'), 'User notes');
  }
});

test('installation preserves customized canonical content before attempting legacy cleanup', async t => {
  const root = await isolated(t);
  await installLibrarySkill('openmotion-brandkit', root);
  const legacy = await legacyFixture(root, 'brandkit');
  const file = path.join(root, 'openmotion-brandkit/SKILL.md');
  await writeFile(file, 'User-owned instructions');
  await assert.rejects(installLibrarySkill('openmotion-brandkit', root), /Existing Skill differs/);
  assert.equal(await readFile(file, 'utf8'), 'User-owned instructions');
  assert.equal(await readFile(path.join(legacy, 'SKILL.md'), 'utf8'), aliases.brandkit['SKILL.md']);
  await assert.rejects(installLibrarySkill('../foreign', root), /Unknown Library Skill/);
});

for (const canonical of ['openmotion-ad-script', 'openmotion-adaptive-layout', 'openmotion-ai-assistant-tour', 'openmotion-archive-collage', 'openmotion-article-illustrations', 'openmotion-aurora-gradient', 'openmotion-before-after', 'openmotion-bilingual-captions', 'openmotion-bold-type-poster', 'openmotion-bubble-field', 'openmotion-caption-styling', 'openmotion-card-carousel', 'openmotion-cards-and-text', 'openmotion-chalk-blueprint', 'openmotion-cinematic-logo', 'openmotion-clay-explainer', 'openmotion-color-pop-poster', 'openmotion-content-cover', 'openmotion-coral-title-cards', 'openmotion-corner-frames', 'openmotion-dark-premium-poster', 'openmotion-design-styles', 'openmotion-doc-promo', 'openmotion-echo-stack-type', 'openmotion-edit-to-script', 'openmotion-editorial-explainer', 'openmotion-editorial-poster', 'openmotion-editorial-webinar', 'openmotion-electric-impact-type', 'openmotion-felt-stop-motion', 'openmotion-flat-beat', 'openmotion-flat-card-explainer', 'openmotion-flat-lay-product', 'openmotion-folder-pop', 'openmotion-footage-to-handpainted', 'openmotion-giant-flip-type', 'openmotion-glitch-logo-sting', 'openmotion-growth-teardown', 'openmotion-hand-drawn-explainer', 'openmotion-hidden-feature-demo', 'openmotion-highlighter-notes', 'openmotion-in-hand-product', 'openmotion-ink-ribbon', 'openmotion-isometric-card-flight', 'openmotion-juicy-splash-poster', 'openmotion-light-shadow-product', 'openmotion-liquid-blob', 'openmotion-liquid-glass-logo', 'openmotion-liquid-logo', 'openmotion-livestream-clips', 'openmotion-magnet-particles', 'openmotion-manifesto-pop', 'openmotion-monochrome-magazine', 'openmotion-motion-graphic-placement', 'openmotion-multi-clips-to-reels', 'openmotion-multicam-edit', 'openmotion-mystery-box-reveal', 'openmotion-neon-outline-type', 'openmotion-nova-intro', 'openmotion-one-bit-dither', 'openmotion-orange-unfiltered', 'openmotion-paper-collage-explainer', 'openmotion-paper-diorama', 'openmotion-paper-map-journey', 'openmotion-paper-stop-motion', 'openmotion-pastel-flat-2d', 'openmotion-pixel-art-explainer', 'openmotion-pop-style', 'openmotion-premium-halo', 'openmotion-push-in-type', 'openmotion-quantum-particles', 'openmotion-red-pen-archive', 'openmotion-relight-reveal', 'openmotion-retro-flat-scene', 'openmotion-retro-print-poster', 'openmotion-ring-mask-reveal', 'openmotion-runway-rebel', 'openmotion-shortlist-shorts', 'openmotion-shot-breakdown', 'openmotion-shutter-bands', 'openmotion-smooth-wipes', 'openmotion-spec-sheet', 'openmotion-splash-float-product', 'openmotion-split-slot-type', 'openmotion-step-by-step-tutorial', 'openmotion-sticker-bounce', 'openmotion-sticker-peel', 'openmotion-storyboard-to-motion', 'openmotion-storybook-myth', 'openmotion-surreal-3d-poster', 'openmotion-talking-head-recreation', 'openmotion-time-freeze', 'openmotion-translucent-glass', 'openmotion-velocity-lines', 'openmotion-website-launch', 'openmotion-whiteboard-doodle', 'openmotion-whiteboard-marker', 'openmotion-wireframe-style']) {
  test(`standalone ${canonical} installs without a retired entry`, async t => {
    const root = await isolated(t), destination = path.join(root, 'skills');
    const result = await installLibrarySkill(canonical, destination);
    assert.deepEqual(await readdir(destination), [canonical]);
    assert.deepEqual(result.removedLegacy, []);
    assert.deepEqual(result.preservedLegacy, []);
    assert.equal(await readFile(result.entry, 'utf8'), await readFile(`library/skills/${canonical}/SKILL.md`, 'utf8'));
    assert.deepEqual((await installLibrarySkill(canonical, destination)).installed, [canonical]);
  });
}
