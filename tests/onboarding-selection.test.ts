import { Window } from 'happy-dom';
import { onboardingTemplateIds, selectOnboardingTemplateIds } from '../shared/onboarding-templates.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { renderInlineOnboarding } from '../scripts/inline-onboarding.mjs';
import { loadTemplatePresentation, showTemplateRecommendations } from '../shared/mcp-template-recommendations.ts';
import { mountTemplateCards, readRecommendation, recreationPrompt } from '../mcp-ui/template-recommendations/app.ts';
import type { TemplateCardsBootstrap } from '../mcp-ui/template-recommendations/types.ts';
import { onboardingCatalog } from '../scripts/onboarding-catalog.ts';
import { prepareInstallationOnboarding } from '../scripts/install-onboarding.mjs';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
// Acceptance values deliberately do not import the implementation's selection.
const selected = [
  'motion-664184d9-593e-4984-b473-701248b69cfe',
  'motion-b31d078a-4e5e-461e-8b43-3101ee0a2f93',
  'motion-1e48dea5-903d-48f6-b10e-99a70f1c183d',
];
const titles = ['Bolt Skills｜团队能力展示', 'A New Era of No-Code', 'Magic Share'];

test('curated random selection covers all nine approved references without replacement or pool mutation', () => {
  const expectedTitles = ['Bolt Skills｜团队能力展示', 'A New Era of No-Code', 'Magic Share', 'Glean Agents 发布', 'HyperOS 官网界面动效 1', 'Salsa｜音乐主题 Doodle', '功能更新｜Voice mode', 'Dia 开放给 Arc 会员', '免费语音输入'];
  assert.deepEqual(onboardingTemplateIds.map(id => JSON.parse(requireRecord(id)).entry.original.templateName), expectedTitles);
  const original = [...onboardingTemplateIds], seen = new Set<string>();
  for (let index = 0; index < 9; index++) {
    const cards = selectOnboardingTemplateIds(() => (index + 0.5) / 9);
    assert.equal(cards.length, 3); assert.equal(new Set(cards).size, 3);
    assert(cards.every(id => (onboardingTemplateIds as readonly string[]).includes(id)));
    seen.add(cards[0]);
  }
  assert.equal(seen.size, 9); assert.deepEqual([...onboardingTemplateIds], original);
  assert.notDeepEqual(selectOnboardingTemplateIds(() => 0), selectOnboardingTemplateIds(() => 0.99));
});

test('one preparation freezes a random selection across inline cards and fallback catalog', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'om-random-onboarding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await prepareInstallationOnboarding({ appRoot, dataDirectory: directory, templateEnvironment: 'prod', language: 'zh' });
  const ids = result.inlinePresentation.templateIds;
  assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 3);
  assert(ids.every((id: string) => (onboardingTemplateIds as readonly string[]).includes(id)));
  assert.deepEqual(result.catalog.templates.map((item: any) => item.templateId), ids);
  assert.equal(result.catalog.recommendedTemplateId, ids[0]);
  assert.equal(result.inlinePresentation.status, 'native_required');
  assert.equal(result.inlinePresentation.path, undefined);
  assert.equal(result.inlinePresentation.presentation.arguments.onboarding, false);
  assert.match(result.inlinePresentation.welcomeMarkdown, /我是你的开源视频创作搭档/);
  assert.match(result.inlinePresentation.welcomeMarkdown, /上方卡片/);
  assert.doesNotMatch(result.inlinePresentation.welcomeMarkdown, /下方|👇/);
  const presentation = loadTemplatePresentation();
  const bootstrap = JSON.parse(presentation.content.text.match(/window\.__OPENMOTION_TEMPLATE_CARDS__=(.*?);<\/script>/s)![1]);
  const window = new Window(); t.after(() => window.happyDOM.abort());
  window.URL.createObjectURL = () => 'blob:verified'; window.URL.revokeObjectURL = () => {};
  const root = window.document.createElement('main'); window.document.body.append(root);
  const ui = mountTemplateCards(root as unknown as HTMLElement, bootstrap, { sendMessage: async () => ({}), getHostCapabilities: () => ({}) });
  ui.update(showTemplateRecommendations(presentation, result.inlinePresentation.presentation.arguments));
  assert.equal(window.document.querySelector('.omtc-welcome'), null, 'Welcome must stream as final reply text, outside the native App');
  t.after(() => ui.destroy());
  const displayed = () => [...window.document.querySelectorAll('.omtc-card')].map(card => card.getAttribute('data-template-id'));
  assert.deepEqual(displayed(), ids);
  (window.document.querySelector('.omtc-cover') as any).click();
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(displayed(), ids, 'Detail navigation must not redraw the selection');
});

test('random selection has all 504 ordered outcomes with equal candidate exposure', () => {
  const outcomes = new Set<string>(), counts = new Map(onboardingTemplateIds.map(id => [id, [0, 0, 0]]));
  for (let first = 0; first < 9; first++) for (let second = 0; second < 8; second++) for (let third = 0; third < 7; third++) {
    const draws = [(first + 0.5) / 9, (second + 0.5) / 8, (third + 0.5) / 7];
    const result = selectOnboardingTemplateIds(() => draws.shift()!);
    assert.equal(new Set(result).size, 3);
    outcomes.add(result.join(','));
    result.forEach((id, position) => counts.get(id as typeof onboardingTemplateIds[number])![position]++);
  }
  assert.equal(outcomes.size, 9 * 8 * 7);
  for (const positions of counts.values()) assert.deepEqual(positions, [56, 56, 56]);
});

test('native onboarding rejects builtin shortcuts while ordinary explicit recommendations retain them', () => {
  const presentation = loadTemplatePresentation();
  const shortcuts = ['product-promo', 'nyt-graph', 'decision-tree'];
  assert.throws(() => showTemplateRecommendations(presentation, { templateIds: shortcuts, onboarding: true }), /INVALID_ARGUMENT/);
  assert.throws(() => showTemplateRecommendations(presentation, { templateIds: [selected[0], selected[1], 'decision-tree'], onboarding: true }), /INVALID_ARGUMENT/);
  assert.deepEqual(showTemplateRecommendations(presentation, { templateIds: shortcuts }).cards.map(card => card.templateId), shortcuts);
});

test('installation recommendations use the same references rather than the shortest builtin catalog', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'om-install-recommendations-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await onboardingCatalog(appRoot, directory, selected);
  assert.deepEqual(result.templates.map(item => item.templateId), selected);
  assert.deepEqual(result.templates.map(item => item.name), titles);
  assert.equal(result.recommendedTemplateId, selected[0]);
  assert(result.templates.every(item => item.kind === 'reference'));
  assert.match(result.selectionGuide, /yes.*named recommendation/i);
  assert.match(result.selectionGuide, /recovery/i);
});

test('failed installation catalog preserves the failure instead of offering decision-tree', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'om-no-builtin-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs/install-onboarding.md'), '<!-- installation-onboarding:start -->Keep the accepted template.<!-- installation-onboarding:end -->');
  // An eligible local builtin must not become a recommendation when catalog preparation fails.
  const builtin = path.join(root, 'template-library/decision-tree');
  await mkdir(builtin, { recursive: true });
  await writeFile(path.join(builtin, 'index.html'), '<html></html>');
  await writeFile(path.join(builtin, 'registry-item.json'), JSON.stringify({ name: 'decision-tree', title: 'Decision Tree', duration: 10,
    files: [{ path: 'index.html', target: 'index.html' }] }));
  await mkdir(path.join(root, 'node_modules/gsap/dist'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/gsap/dist/gsap.min.js'), '');
  const result = await prepareInstallationOnboarding({ appRoot: root, host: 'workbuddy', templateEnvironment: 'prod' });
  assert.deepEqual(result.catalog.templates, []);
  assert.equal(result.catalog.recommendedTemplateId, null);
  assert.match(result.catalog.warning, /unavailable/i);
});

test('a prepared explicit selection retains its exact three references and order', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'om-selected-onboarding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await renderInlineOnboarding({ appRoot, output: path.join(directory, 'cards.html'), language: 'zh', templateIds: selected });
  assert.deepEqual(result.templateIds, selected);
});

test('reference recommendations keep exact catalog identities without builtin creation arguments', () => {
  const presentation = loadTemplatePresentation();
  const result = showTemplateRecommendations(presentation, { templateIds: selected, onboarding: true, language: 'zh' });
  assert.deepEqual(result.cards.map(card => card.title), titles);
  for (const card of result.cards) {
    assert.equal(card.templateKind, 'reference');
    assert.equal(card.createArgs, undefined);
    const record = JSON.parse(requireRecord(card.templateId));
    assert.equal(card.durationSeconds, Number(record.entry.original.durationSeconds));
  }
  assert.match(result.selectionGuide, /openmotion_get_template/);
  assert.match(result.selectionGuide, /openmotion-recreate/);
  const bootstrap = JSON.parse(presentation.content.text.match(/window\.__OPENMOTION_TEMPLATE_CARDS__=(.*?);<\/script>/s)![1]) as TemplateCardsBootstrap;
  assert(readRecommendation(result, bootstrap));
  for (const card of result.cards) for (const language of ['zh', 'en', 'ja', 'ko', 'fr', 'es', 'pt'] as const) {
    const prompt = recreationPrompt(card, language);
    assert(prompt.includes(card.templateId));
    assert.match(prompt, /openmotion_get_template/);
    assert.match(prompt, /openmotion-recreate/);
  }
  const injected = structuredClone(result);
  Object.assign(injected.cards[0], { createArgs: { projectType: 'template', templateId: selected[0] } });
  assert.equal(readRecommendation(injected, bootstrap), null, 'References must never acquire builtin-copy arguments');
});

function requireRecord(id: string) {
  return readFileSync(path.join(appRoot, 'library/templates/catalog', id, 'template.json'), 'utf8');
}

test('reference presentation rejects a substituted media URL or missing source identity', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'om-reference-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(path.join(appRoot, 'mcp-ui/template-recommendations'), directory, { recursive: true });
  const file = path.join(directory, 'manifest.json');
  const original = await readFile(file, 'utf8');
  for (const mutate of [
    (item: any) => { item.videoUrl = 'https://r.open-design.ai/files/' + 'a'.repeat(64); },
    (item: any) => { item.posterUrl = 'https://example.com/poster.jpg'; },
    (item: any) => { item.sourceFiles.pop(); },
    (item: any) => { item.durationSeconds = 1; },
  ]) {
    const manifest = JSON.parse(original);
    mutate(manifest.templates.find((item: any) => item.id === selected[0]));
    await writeFile(file, JSON.stringify(manifest));
    assert.throws(() => loadTemplatePresentation({ directory }), /TEMPLATE_PRESENTATION_INVALID/);
  }
});
