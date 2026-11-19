import { blackFridaySkillIds } from '../../../shared/black-friday-collection';
import { workspacePageName } from '../../../shared/workspace-url';
import { mcpClients, type McpClient } from './mcpClients';
import { exploreCommunities, findLandingScene, findMediaStudio, findTechniqueStudio, type ExploreCommunity, type TechniqueStudio, type StudioScene } from '../../../shared/studio-catalog';
import { sceneDestination, studioDestination, type StudioDestination } from './creativeStudios';

/** Application pages live in the query; the project hash belongs to the editor. */
export const settingsSections = ['account', 'subscription', 'providers', 'models', 'local', 'general', 'appearance', 'privacy', 'about', 'help', 'mcp', 'brand-kit'] as const;
export type SettingsSection = typeof settingsSections[number];
export type ExploreFilters = { community: ExploreCommunity['id'] | null; medium: StudioScene['modality'] | null };
export type WorkspacePage = ExploreFilters & { motion: boolean; api: boolean; tool: string | null; specialty: TechniqueStudio | null; assetId: string | null; assetVersion: string | null; explore: boolean; studio: StudioDestination | null; settings: SettingsSection | null; assets: boolean; skills: boolean; skill: string | null; templates: boolean; blackFriday: boolean; modelOverview: string | null; modelHub: string | null; creators: boolean; creator: string | null; client: McpClient; setup: 'agent' | 'manual'; provider: string | null; template: string | null; brandKit: string | null };

export function readWorkspacePage(search: string, hash = ''): WorkspacePage {
  const query = new URLSearchParams(search), page = workspacePageName(query, hash), section = query.get('section');
  const settings = page === 'brand-kit' ? 'brand-kit' : page === 'mcp' ? 'mcp' : page === 'settings'
    ? settingsSections.find(value => value === section) ?? 'general' : null;
  const sceneId = query.get('scene'), model = query.get('model') || null;
  const collection = findTechniqueStudio(page);
  const studioKind = collection?.scenes.some(id => id === sceneId) ? collection : findMediaStudio(page);
  const landing = page === 'create' && findLandingScene(sceneId);
  const studio = landing ? sceneDestination(landing, null, model) : studioKind ? studioDestination(studioKind, sceneId, model) : null;
  const specialty = studio ? null : collection ?? null;
  const community = exploreCommunities.find(item => item.id === query.get('community'))?.id ?? null;
  const medium = (['image', 'video', 'audio'] as const).find(value => value === query.get('medium')) ?? null;
  const skill = query.get('skill') || null;
  const templates = query.get('templates') === '1';
  const creators = templates && query.get('view') === 'creators';
  const blackFriday = templates && !creators && query.get('collection') === 'black-friday';
  const selectedSkill = blackFriday ? blackFridaySkillIds.find(id => id === skill) ?? null
    : page === 'skills' || collection?.techniques.some(id => id === skill) ? skill : null;
  return { motion: page === 'motion', api: page === 'api', tool: page === 'api' ? query.get('tool') : null, modelOverview: page === 'model' ? model : null, modelHub: page === 'model-hub' ? query.get('hub') || null : null, creators, creator: creators ? query.get('creator')?.trim() || null : null, specialty, community, medium, assetId: page === 'assets' ? query.get('asset') || null : null,
    assetVersion: page === 'assets' && query.get('asset') ? query.get('version') || null : null, explore: page === 'explore', studio, settings, brandKit: settings === 'brand-kit' ? query.get('kit') || null : null, assets: page === 'assets', skills: page === 'skills', skill: selectedSkill, templates, blackFriday,
    client: mcpClients.find(value => value.id === query.get('host'))?.id ?? 'codex',
    setup: query.get('setup') === 'manual' ? 'manual' : 'agent',
    provider: settings === 'providers' ? query.get('provider') || null : null,
    template: templates ? query.get('template') || null : null };
}

export function workspacePageHref(href: string, patch: Partial<WorkspacePage>): string {
  const url = new URL(href), current = readWorkspacePage(url.search, url.hash), page = { ...current, ...patch };
  const currentSearchPage = url.searchParams.get('page');
  for (const key of ['page', 'section', 'templates', 'host', 'setup', 'provider', 'template', 'skill', 'kit', 'community', 'medium', 'collection', 'hub']) url.searchParams.delete(key);
  if (current.api || page.api) url.searchParams.delete('tool');
  if (current.creators || page.creators) { url.searchParams.delete('view'); url.searchParams.delete('creator'); }
  if (current.assets || page.assets) { url.searchParams.delete('asset'); url.searchParams.delete('version'); }
  if (current.studio || current.specialty || page.studio || currentSearchPage === 'create' || currentSearchPage === 'model') {
    url.searchParams.delete('scene');
    url.searchParams.delete('model');
  }
  // A primary destination replaces its peers. Overlay and detail patches retain their parent.
  if (['explore', 'motion', 'api', 'studio', 'modelOverview', 'modelHub', 'specialty', 'assets', 'skills', 'settings'].some(key => key in patch)) {
    page.motion = Boolean(patch.motion);
    page.explore = Boolean(patch.explore);
    page.api = Boolean(patch.api);
    page.studio = patch.studio ?? null;
    page.modelOverview = patch.modelOverview ?? null;
    page.modelHub = patch.modelHub ?? null;
    page.specialty = patch.specialty ?? null;
    page.assets = Boolean(patch.assets);
    page.skills = Boolean(patch.skills);
    page.settings = patch.settings ?? null;
  }
  const inSettings = Boolean(page.settings) && !page.assets && !page.skills && page.settings !== 'brand-kit' && page.settings !== 'mcp';
  if (!inSettings) url.searchParams.delete('entry_from');
  if (page.explore) {
    url.searchParams.set('page', 'explore');
  } else if (page.motion) {
    url.searchParams.set('page', 'motion');
  } else if (page.api) {
    url.searchParams.set('page', 'api');
    if (page.tool) url.searchParams.set('tool', page.tool);
  } else if (page.modelOverview) {
    url.searchParams.set('page', 'model');
    url.searchParams.set('model', page.modelOverview);
  } else if (page.modelHub) {
    url.searchParams.set('page', 'model-hub');
    url.searchParams.set('hub', page.modelHub);
  } else if (page.specialty) {
    url.searchParams.set('page', page.specialty.id);
    if (page.specialty.techniques.some(id => id === page.skill)) url.searchParams.set('skill', page.skill!);
  } else if (page.studio) {
    url.searchParams.set('page', page.studio.landing ? 'create' : page.studio.studio.id);
    url.searchParams.set('scene', page.studio.scene.id);
    if (page.studio.studio.surface === 'techniques' && page.studio.studio.techniques.some(id => id === page.skill)) url.searchParams.set('skill', page.skill!);
    if (page.studio.model) url.searchParams.set('model', page.studio.model);
  } else if (page.skills) {
    url.searchParams.set('page', 'skills');
    if (page.skill) url.searchParams.set('skill', page.skill);
  } else if (page.assets) {
    url.searchParams.set('page', 'assets');
    if (page.assetId) {
      url.searchParams.set('asset', page.assetId);
      if (page.assetVersion) url.searchParams.set('version', page.assetVersion);
    }
  } else if (page.settings === 'brand-kit') {
    url.searchParams.set('page', 'brand-kit');
    if (page.brandKit) url.searchParams.set('kit', page.brandKit);
  } else if (page.settings === 'mcp') {
    url.searchParams.set('page', 'mcp');
    url.searchParams.set('host', page.client);
    if (page.setup === 'manual') url.searchParams.set('setup', 'manual');
  } else if (page.settings) {
    url.searchParams.set('page', 'settings');
    url.searchParams.set('section', page.settings);
    if (page.settings === 'providers' && page.provider) url.searchParams.set('provider', page.provider);
  } else if (!page.templates && workspacePageName(url.searchParams, url.hash) === 'explore') {
    url.searchParams.set('page', 'editor');
  }
  if (page.explore || page.motion || page.api || page.modelOverview || page.modelHub || page.specialty || page.studio || page.skills) {
    if (page.community) url.searchParams.set('community', page.community);
    if (page.medium) url.searchParams.set('medium', page.medium);
  }
  if (page.templates) {
    url.searchParams.set('templates', '1');
    if (page.creators) {
      url.searchParams.set('view', 'creators');
      if (page.creator) url.searchParams.set('creator', page.creator);
    } else if (page.blackFriday) {
      url.searchParams.set('collection', 'black-friday');
      if (page.skill) url.searchParams.set('skill', page.skill);
    }
    if (page.template) url.searchParams.set('template', page.template);
  }
  return url.pathname + url.search + url.hash;
}
