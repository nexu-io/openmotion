import type { GalleryTemplate } from '../../../shared/catalog';
import { collectionNames, templateCategoryLabel } from '../../../shared/catalog';
import {
  parseSearchQuery,
  prepareSearchDocument,
  rankSearchResults,
  scoreSearchDocument,
  type ParsedSearchQuery,
  type PreparedSearchDocument,
} from '../../../shared/fuzzy-search';
import type { Translate } from '../i18n/messages';
import { motionSkills, type MotionSkill } from './skillCatalog';
import { facetValues, templateFacets } from './templateDiscovery';

export const normalizedTemplateQuery = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

const taskPurposes = new Map([
  ['产品演示', 'Product demos & explainers'],
  ['功能演示', 'Product demos & explainers'],
  ['product demo', 'Product demos & explainers'],
  ['产品宣传', 'Product launch films'],
  ['product promo', 'Product launch films'],
]);

export type IndexedTemplateSearchEntry = {
  readonly item: GalleryTemplate;
  readonly doc: PreparedSearchDocument;
  readonly uses: readonly string[];
};

function buildTemplateSearchDoc(item: GalleryTemplate, t: Translate) {
  const facetAliases = templateFacets.flatMap(([key]) =>
    facetValues(item, key).flatMap(value => (value ? [value, t(value)] : [])),
  );
  const categoryLabel = item.collection ? templateCategoryLabel(item) : '';
  const collectionLabel = item.collection ? collectionNames[item.collection] : '';
  return prepareSearchDocument({
    id: item.id,
    title: item.title,
    subtitle: item.subtitle,
    description: item.description,
    tags: item.tags,
    aliases: [
      ...(item.searchAliases ?? []),
      ...facetAliases,
      ...(categoryLabel ? [categoryLabel, t(categoryLabel)] : []),
      ...(collectionLabel ? [collectionLabel, t(collectionLabel)] : []),
    ],
    author: item.authorName || item.author,
    extra: [item.styleDescription ?? ''],
  });
}

/** Pre-indexes templates once per catalog+locale so keystroke scoring runs in <1ms. */
export function prepareTemplateSearchIndex(
  items: readonly GalleryTemplate[],
  t: Translate,
): IndexedTemplateSearchEntry[] {
  return items.map(item => ({
    item,
    doc: buildTemplateSearchDoc(item, t),
    uses: facetValues(item, 'uses'),
  }));
}

function scoreIndexedTemplate(
  entry: IndexedTemplateSearchEntry,
  parsed: ParsedSearchQuery,
  purpose: string | undefined,
): number {
  const score = scoreSearchDocument(entry.doc, parsed);
  if (purpose && (entry.item.id === 'product-promo' || entry.uses.includes(purpose))) {
    return Math.max(score, 6) + 2;
  }
  return score;
}

/** Scores and ranks a pre-indexed template list without re-parsing documents per keystroke. */
export function rankTemplateSearch(
  entries: readonly IndexedTemplateSearchEntry[],
  query: string,
): { item: GalleryTemplate; score: number }[] {
  const trimmed = query.trim();
  if (!trimmed) return entries.map(({ item }) => ({ item, score: 1 }));
  const parsed = parseSearchQuery(trimmed);
  const purpose = taskPurposes.get(normalizedTemplateQuery(trimmed));
  const scored: { item: GalleryTemplate; score: number; index: number }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const score = scoreIndexedTemplate(entry, parsed, purpose);
    if (score > 0) scored.push({ item: entry.item, score, index: i });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.map(({ item, score }) => ({ item, score }));
}

/** Builds an id->score map from a pre-indexed template list for fast filter+sort in dialogs. */
export function scoreTemplateSearchMap(
  entries: readonly IndexedTemplateSearchEntry[],
  query: string,
): Map<string, number> {
  const scores = new Map<string, number>();
  const trimmed = query.trim();
  if (!trimmed) return scores;
  const parsed = parseSearchQuery(trimmed);
  const purpose = taskPurposes.get(normalizedTemplateQuery(trimmed));
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const score = scoreIndexedTemplate(entry, parsed, purpose);
    if (score > 0) scores.set(entry.item.id, score);
  }
  return scores;
}

/** Scores template relevance using multilingual metadata, taxonomy aliases, and fuzzy matching. */
export function scoreTemplateSearch(item: GalleryTemplate, query: string, t: Translate): number {
  const trimmed = query.trim();
  if (!trimmed) return 1;
  const parsed = parseSearchQuery(trimmed);
  const purpose = taskPurposes.get(normalizedTemplateQuery(trimmed));
  const entry: IndexedTemplateSearchEntry = {
    item,
    doc: buildTemplateSearchDoc(item, t),
    uses: facetValues(item, 'uses'),
  };
  return scoreIndexedTemplate(entry, parsed, purpose);
}

/** Task aliases describe verified resource metadata, never every brand campaign. */
export function matchesTemplateSearch(item: GalleryTemplate, query: string, t: Translate) {
  return scoreTemplateSearch(item, query, t) > 0;
}

/** Matches Skills for template zero-result fallback using the shared multilingual fuzzy engine. */
export function matchingSkillsForQuery(query: string, t: Translate, limit = 3): MotionSkill[] {
  const trimmed = query.trim();
  if (!trimmed || limit <= 0) return [];
  return rankSearchResults(motionSkills, trimmed, skill => ({
    id: skill.id,
    title: t(skill.title),
    subtitle: t(skill.category),
    description: t(skill.useWhen),
    tags: [skill.category, skill.technique, skill.name],
    aliases: [
      skill.title,
      skill.tagline,
      t(skill.tagline),
      t(skill.output),
      skill.example ? t(skill.example) : '',
      skill.repository ?? 'OpenMotion',
    ],
  }))
    .slice(0, limit)
    .map(result => result.item);
}

export function validReferenceLink(value: string) {
  try { return ['http:', 'https:'].includes(new URL(value.trim()).protocol); } catch { return false; }
}

export { templateSearchBrief } from '../../../shared/template-search-brief.ts';
