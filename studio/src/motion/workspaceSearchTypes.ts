import type { ReactNode } from 'react';
import type { LibraryAsset } from '../../../shared/asset-library';
import { featuredTemplateIds, isEditableTemplate, isShortFormTemplate, type GalleryTemplate } from '../../../shared/catalog';
import { findDesignScenario } from '../../../shared/design-project';
import { extractHighlightTerms } from '../../../shared/fuzzy-search';
import type { Model, Modality } from '../../../shared/gateway';
import type { ScenarioDefinition } from '../../../shared/scenarios';
import type { CreativeStudio, ExploreCommunity, StudioScene } from '../../../shared/studio-catalog';
import type { SuperAgentChatSummary, SuperAgentResourceAttachment } from '../../../shared/super-agent';
import type { Translate } from '../i18n/messages';
import { escapeRegex } from '../utils/regex';
import type { MotionSkill } from './skillCatalog';

export type SearchScope = 'all' | 'actions' | 'chats' | 'templates' | 'studios' | 'files' | 'tools';

export const SEARCH_SCOPES: readonly {
  id: SearchScope;
  label: string;
  icon: string;
}[] = [
  { id: 'all', label: 'All', icon: 'apps-2-line' },
  { id: 'actions', label: 'Actions', icon: 'flashlight-line' },
  { id: 'chats', label: 'Chats', icon: 'chat-1-line' },
  { id: 'templates', label: 'Templates', icon: 'movie-line' },
  { id: 'studios', label: 'Studios', icon: 'layout-grid-line' },
  { id: 'files', label: 'Projects & files', icon: 'folder-open-line' },
  { id: 'tools', label: 'More', icon: 'puzzle-line' },
];

export type SearchItemKind =
  | 'action'
  | 'chat'
  | 'motion-template'
  | 'design-template'
  | 'motion-project'
  | 'design-project'
  | 'game-project'
  | 'asset'
  | 'brand-kit'
  | 'workflow'
  | 'studio'
  | 'scene'
  | 'skill'
  | 'design-skill'
  | 'model'
  | 'community';

export type SearchPaletteItem = {
  key: string;
  id: string;
  kind: SearchItemKind;
  scope: Exclude<SearchScope, 'all'>;
  group: string;
  label: string;
  detail?: string;
  description?: string;
  ariaLabel?: string;
  modality?: Modality;
  badge?: string;
  meta?: string;
  thumbUrl?: string;
  swatches?: string[];
  tags?: string[];
  searchAliases?: string[];
  iconName?: string;
  tone?: Modality | 'agent';
  pinned?: boolean;
  icon: ReactNode;
  template?: GalleryTemplate;
  chat?: SuperAgentChatSummary;
  resource?: SuperAgentResourceAttachment;
  asset?: LibraryAsset;
  studio?: CreativeStudio;
  scene?: StudioScene;
  skill?: MotionSkill;
  model?: Model;
  providerLabel?: string;
  workflow?: ScenarioDefinition;
  community?: ExploreCommunity;
  motionProject?: { id: string; title: string };
  open: () => void;
};

export type SearchResultGroup = {
  id: string;
  title: string;
  ariaLabel: string;
  items: SearchPaletteItem[];
};

export const POPULAR_SEARCH_TOPICS_ZH = ['口播', '科普', '电商', 'Logo', 'Vlog'] as const;
export const POPULAR_SEARCH_TOPICS_EN = ['Talking head', 'Explainer', 'Product promo', 'Logo', 'Vlog'] as const;

/** Picks diverse featured and editable templates for initial empty-query discovery. */
export function selectRecommendedTemplates(templates: readonly GalleryTemplate[], limit = 6): GalleryTemplate[] {
  if (!templates.length || limit <= 0) return [];
  const featuredRank = new Map<string, number>(featuredTemplateIds.map((id, index) => [id, index]));

  const ranked = [...templates].sort((a, b) => {
    const aFeatured = featuredRank.get(a.id);
    const bFeatured = featuredRank.get(b.id);
    if (aFeatured !== undefined && bFeatured !== undefined) return aFeatured - bFeatured;
    if (aFeatured !== undefined) return -1;
    if (bFeatured !== undefined) return 1;

    const aScore = (isEditableTemplate(a) ? 4 : 0) + (a.posterUrl ? 2 : 0) + (a.previewUrl ? 1 : 0);
    const bScore = (isEditableTemplate(b) ? 4 : 0) + (b.posterUrl ? 2 : 0) + (b.previewUrl ? 1 : 0);
    if (aScore !== bScore) return bScore - aScore;
    return (a.featuredOrder ?? Number.MAX_SAFE_INTEGER) - (b.featuredOrder ?? Number.MAX_SAFE_INTEGER);
  });

  const picked: GalleryTemplate[] = [];
  const seenIds = new Set<string>();
  const addUnique = (item: GalleryTemplate | undefined) => {
    if (!item || seenIds.has(item.id) || picked.length >= limit) return;
    seenIds.add(item.id);
    picked.push(item);
  };

  // Seed diverse slots first when available: editable prism/builtin, spoken/script, short-form
  addUnique(ranked.find(item => isEditableTemplate(item) && item.posterUrl));
  addUnique(ranked.find(item => !seenIds.has(item.id) && (item.role === 'a-roll' || (item.tags ?? []).includes('口播'))));
  addUnique(ranked.find(item => !seenIds.has(item.id) && isShortFormTemplate(item) && item.posterUrl));

  for (const item of ranked) {
    if (picked.length >= limit) break;
    addUnique(item);
  }
  return picked;
}

export function formatRelativeSearchTime(timestamp: number, t: Translate): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return t('Just now');
  if (minutes < 60) return t('{count}m ago', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('{count}h ago', { count: hours });
  const days = Math.floor(hours / 24);
  return t('{count}d ago', { count: days });
}

export function designScenarioLabel(scenario?: string): string {
  if (!scenario) return '';
  return findDesignScenario(scenario)?.label ?? scenario;
}

export function searchHighlightPattern(query: string): RegExp | null {
  const highlightTerms = extractHighlightTerms(query);
  if (!highlightTerms.length) return null;
  return new RegExp('(' + highlightTerms.map(escapeRegex).join('|') + ')', 'iu');
}

/** Picks the initial global-search scope tab based on the active workspace page. */
export function defaultScopeForLocation(
  pathname: string,
  search = '',
  hasStudioDestination = false,
): SearchScope {
  const path = pathname.toLowerCase();
  const params = new URLSearchParams(search);
  if (path.startsWith('/templates') || params.get('templates') === '1' || params.has('template')) {
    return 'templates';
  }
  if (
    path.startsWith('/skills')
    || path.startsWith('/workflows')
    || path.startsWith('/scenarios')
    || path.startsWith('/models')
    || path.startsWith('/model-hub')
    || params.get('page') === 'skills'
    || params.get('page') === 'model-hub'
  ) {
    return 'tools';
  }
  if (path.startsWith('/agent') || params.get('page') === 'agent') {
    return 'chats';
  }
  if (
    path.startsWith('/projects')
    || path.startsWith('/assets')
    || path.startsWith('/brand-kit')
    || params.get('page') === 'projects'
    || params.get('page') === 'assets'
    || params.get('page') === 'brand-kit'
  ) {
    return 'files';
  }
  if (
    hasStudioDestination
    || path.startsWith('/design')
    || path.startsWith('/cinema')
    || path.startsWith('/sound')
    || path.startsWith('/game')
    || path.startsWith('/studio')
    || path.startsWith('/video')
    || path.startsWith('/image')
    || path.startsWith('/audio')
  ) {
    return 'studios';
  }
  return 'all';
}
