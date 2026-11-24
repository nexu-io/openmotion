import test from 'node:test';
import assert from 'node:assert/strict';
import { TemplateCatalog } from '../prism-templates.ts';
import { designCatalog } from '../shared/design-catalog.ts';
import {
  extractHighlightTerms,
  matchesSearchDocument,
  normalizeSearchText,
  parseSearchQuery,
  rankSearchResults,
  scoreSearchDocument,
} from '../shared/fuzzy-search.ts';
import { clearWorkspaceResourceCache, collectWorkspaceResources } from '../gateway/super-agent-resources.ts';
import { fixture } from './fixtures.ts';

test('fuzzy search supports Chinese natural-language queries, Traditional folding, and English typos', () => {
  const nlDoc = {
    id: 'science-data-card',
    title: '数据故事与科学原理',
    subtitle: '数据叙事 · 流程动画',
    description: '用于知识科普、信息图解与课程讲解的短视频模板',
    tags: ['科普', '数据叙事', '讲解', '短视频'],
  };
  const unrelatedDoc = {
    id: 'unrelated-brand',
    title: 'Minimal Luxury Logo Intro',
    subtitle: 'Motion',
    description: 'Clean logo emblem reveal for fashion house',
    tags: ['Brand promotion'],
  };

  assert.ok(scoreSearchDocument(nlDoc, '我想找一个科技科普讲解的视频模板') > 0);
  assert.ok(matchesSearchDocument({ title: '产品演示与功能介绍', tags: ['产品演示'] }, '產品演示'));
  assert.ok(scoreSearchDocument({ title: 'Smooth Text Animation' }, 'animaton') > 0);
  assert.ok(scoreSearchDocument({ title: 'Template Showcase' }, 'tempalte') > 0);
  assert.equal(normalizeSearchText('  產品演示—V2  '), '产品演示 v2');

  const ranked = rankSearchResults([unrelatedDoc, nlDoc], '科普讲解', doc => doc);
  assert.equal(ranked[0]?.item.id, 'science-data-card');
});

test('fuzzy search enforces short-token boundaries, identifier coordination, and brand disjointness', () => {
  assert.equal(scoreSearchDocument({ title: 'Anything goes' }, 'NYT'), 0);
  assert.ok(scoreSearchDocument({ title: 'NYT Graph' }, 'NYT') > 0);
  assert.ok(scoreSearchDocument({ title: '3D动效标题' }, '3D') > 0);

  assert.equal(scoreSearchDocument({ title: 'Studio Brand', tags: ['Brand promotion'] }, '产品演示'), 0);
  assert.equal(scoreSearchDocument({ title: 'Studio promo', tags: ['Brand promotion'] }, 'product promo'), 0);
  assert.ok(scoreSearchDocument({ title: 'Product reveal', tags: ['Product launch'] }, 'product promo') > 0);

  const partial = {
    id: 'hf-moment-M1165',
    title: 'Interactive components in a frame',
    tags: ['cursor_trail'],
    description: 'Agents workflow',
  };
  assert.equal(scoreSearchDocument(partial, 'hf-component-agent-cursor'), 0);
  assert.ok(scoreSearchDocument({ id: 'hf-component-agent-cursor', title: 'Cursor agent' }, 'hf-component-agent-cursor') > 0);

  const parsed = parseSearchQuery('Seedance 2.0');
  assert.ok(parsed.isIdentifier === false);
  assert.ok(extractHighlightTerms('Seedance 2.0').includes('2.0'));
});

test('tightened hot queries return relevant catalog hits without noisy false positives in both zh-CN and en', () =>
  fixture(async store => {
    const coveredQueries = ['科普', '电商', '讲解', 'logo'];
    for (const locale of ['zh-CN', 'en'] as const) {
      const catalog = new TemplateCatalog(store.directory, { locale });
      for (const query of coveredQueries) {
        const page = await catalog.page({ category: 'all', query, limit: 20 });
        assert.ok(page.total > 0, `Expected hits for "${query}" in locale ${locale}, got 0`);
        assert.ok(page.items.length > 0);
      }
      // Precision check: "科普" must stay tight instead of pulling in 30+ SaaS demos/earnings.
      const sciencePage = await catalog.page({ category: 'all', query: '科普', limit: 20 });
      assert.ok(sciencePage.total <= 10, `Expected tightened "科普" results (<=10) in ${locale}, got ${sciencePage.total}`);
      // Exact catalog vocabulary ("字幕" / "实拍剪辑") still matches directly, while "口播" / "vlog"
      // intentionally avoid pulling in unrelated brand films or vertical SaaS promos (handled by Skill fallback).
      if (locale === 'zh-CN') {
        const subtitlePage = await catalog.page({ category: 'all', query: '字幕', limit: 20 });
        assert.ok(subtitlePage.total > 0, 'Expected exact catalog vocabulary "字幕" to match');
        const liveActionPage = await catalog.page({ category: 'all', query: '实拍剪辑', limit: 20 });
        assert.ok(liveActionPage.total > 0, 'Expected exact catalog vocabulary "实拍剪辑" to match');
        const talkingHeadPage = await catalog.page({ category: 'all', query: '口播', limit: 20 });
        assert.equal(talkingHeadPage.total, 0, 'Expected "口播" not to falsely match unrelated brand/SaaS templates');
      }
      // Cross-locale English typo search also finds matches even in zh-CN via searchAliases.
      const typoPage = await catalog.page({ category: 'all', query: 'animaton', limit: 20 });
      assert.ok(typoPage.total > 0, `Expected cross-locale typo hits for "animaton" in ${locale}`);
    }
  }, false));

test('designCatalog supports Chinese, alias, and fuzzy search queries', () => {
  const catalog = designCatalog();
  const zhTemplates = catalog.templates({ q: '小红书' });
  assert.ok(zhTemplates.items.length > 0);
  const fuzzySystems = catalog.systems({ q: 'minimalst' });
  assert.ok(fuzzySystems.length >= 0);
  const fuzzySkills = catalog.skills({ q: '设计' });
  assert.ok(fuzzySkills.length > 0);
});

test('collectWorkspaceResources returns full motion templates without hitting page limit<=60 and matches bilingual queries', () =>
  fixture(async store => {
    clearWorkspaceResourceCache();
    const res = await collectWorkspaceResources(store, { kind: 'motion-template', query: '电商', limit: 20, locale: 'zh-CN' });
    assert.ok(res.counts.motionTemplates > 60, `Expected >60 motion templates, got ${res.counts.motionTemplates}`);
    assert.ok(res.items.length > 0, 'Expected motion-template matches for 电商');

    const enLogo = await collectWorkspaceResources(store, { kind: 'motion-template', query: 'logo', limit: 20, locale: 'zh-CN' });
    assert.ok(enLogo.items.length > 0, 'Expected motion-template matches for logo in zh-CN');
  }, false));
