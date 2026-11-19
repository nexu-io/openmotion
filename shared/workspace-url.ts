import { findLandingScene, findMediaStudio, findTechniqueStudio } from './studio-catalog.ts';

export const providerSetupEntries = [
  'agent_providers', 'agent_media_signed_out', 'agent_media_upgrade_free', 'agent_media_upgrade_go',
  'agent_media_balance_low', 'agent_media_key_rejected', 'agent_media_handbook',
] as const;
export type ProviderSetupEntry = typeof providerSetupEntries[number];

export type WorkspacePresentation = { embedded: boolean; sidebar: boolean; conversation: boolean };
/** Project and template handoff URLs retain their editor context. */
export function workspacePageName(query: URLSearchParams, hash: string) {
  if (query.has('page')) return query.get('page');
  if (query.has('project') || query.has('session') || hash.startsWith('#project/') || query.get('templates') === '1' || query.get('hostChrome') === '1') return null;
  return 'explore';
}

/** Independent workspace pages remain usable even when the retained project cannot start. */
export function isWorkspaceSettingsPage(search: string, hash = '') {
  const query = new URLSearchParams(search), page = workspacePageName(query, hash);
  if (page === 'model') return Boolean(query.get('model'));
  if (page === 'model-hub') return Boolean(query.get('hub'));
  if (page === 'create') return Boolean(findLandingScene(query.get('scene')));
  return page === 'api' || page === 'settings' || page === 'mcp' || page === 'assets' || page === 'skills' || page === 'brand-kit' || page === 'explore' || page === 'motion' || Boolean(findMediaStudio(page) || findTechniqueStudio(page));
}
export function workspacePresentation(search: string): WorkspacePresentation {
  const query = new URLSearchParams(search), embedded = query.get('embed') === '1';
  return { embedded, sidebar: !embedded && query.get('sidebar') !== '0', conversation: !embedded && query.get('conversation') !== '0' };
}
export function sessionPath(sessionId: string, projectId?: string, options: { openArtifact?: boolean; embedded?: boolean } = {}) {
  const query = new URLSearchParams({ session: sessionId });
  if (projectId) query.set('project', projectId);
  if (options.openArtifact) query.set('openArtifact', '1');
  if (options.embedded) query.set('embed', '1');
  return '/?' + query + (projectId ? '#project/' + encodeURIComponent(projectId) : '');
}
export function preservePresentation(target: string, search: string) {
  const url = new URL(target, 'http://workspace.local'), current = new URLSearchParams(search);
  for (const key of ['embed', 'sidebar', 'conversation']) if (current.has(key)) url.searchParams.set(key, current.get(key)!);
  const tracking = current.get('tracking_context');
  if (tracking && /^[0-9a-f-]{36}$/i.test(tracking) && !url.searchParams.has('tracking_context')) url.searchParams.set('tracking_context', tracking);
  return url.pathname + url.search + url.hash;
}

/** Browsing the library has no project, session or content-version identity. */
export function templateLibraryPreview(origin: string, options: { embedded?: boolean; presentation?: string } = {}) {
  return workspacePagePreview(origin, 'templates', options);
}

/** Provider configuration is independent of project initialization and editing. */
export function providerSettingsPreview(origin: string, options: { embedded?: boolean; presentation?: string; entry?: string; attributeEntry?: boolean } = {}) {
  return workspacePagePreview(origin, 'providers', options);
}

export function resolveProviderSetupEntry(entry?: string): ProviderSetupEntry {
  return (providerSetupEntries as readonly string[]).includes(entry ?? '') ? entry as ProviderSetupEntry : 'agent_providers';
}

function workspacePagePreview(origin: string, target: 'templates' | 'providers', options: { embedded?: boolean; presentation?: string; entry?: string; attributeEntry?: boolean }) {
  const query = new URLSearchParams(target === 'providers'
    ? (options.attributeEntry === false ? { page: 'settings', section: 'providers' } : { page: 'settings', section: 'providers', entry_from: resolveProviderSetupEntry(options.entry) })
    : { templates: '1' });
  if (options.embedded !== false) query.set('embed', '1');
  const previewUrl = origin + '/?' + query;
  const presentation = options.presentation ?? 'foreground';
  const background = presentation === 'background';
  return { target, previewUrl, projectCreated: false, openedByHost: false,
    previewHandoff: { target, previewUrl, placement: 'right', reuseExistingTab: true, presentation,
      focusPolicy: background ? 'background' : presentation === 'now' ? 'switch_to_calling_chat' : 'preserve_current_chat',
      state: background ? 'background' : 'pending', openedByHost: false, hostActionRequired: !background,
      nextAction: background ? null : { kind: 'host', operation: 'present_preview', previewUrl, placement: 'right', reuseExistingTab: true,
        codex: { tool: 'open_in_codex', arguments: { placement: 'right', target: { type: 'browser', url: previewUrl } } } },
      instructions: target === 'providers'
        ? 'Open previewUrl in the host built-in browser in the calling chat and follow the same focus policy. Verify that Model providers is visible before reporting it opened. If the host has no browser, provide the actual link and state the limitation. Guide the user to sign in with OpenDesign under Settings > Account (OpenDesign Plus or above provides image, video, speech and music generation; Free and Go do not include it; Subscription & usage > Manage subscription manages the plan), or to save an OpenDesign Cloud or other supported provider API key in Model providers here, then tell you once done. Keep credentials in settings. Re-inspect providers after confirmation and resume the original request. This page does not create or select a project and needs no project record_display receipt.'
        : 'Open previewUrl in the host built-in browser in the calling chat. Reuse a matching native host tab in this chat after checking its identity and URL; preserve all URL parameters. Present it immediately when this chat is active. Queue without switching only when the host confirms this chat is inactive; a queued acknowledgment alone does not prove inactivity. Only presentation=now permits switching. Observe settled native panel visibility and template library content before reporting it opened. If presentation fails or the native tab is gone, retry presentation once, then report the display failure without repeatedly creating tabs. A prepared URL, hidden automation tab or queued acknowledgment is not visible delivery. On return from a deferred chat, recheck the live library. If the host has no browser, provide the actual link and state the limitation. Browsing and previewing templates must not create a project. Create only after the user selects Open and edit or explicitly asks the Agent to use an exact template. No project record_display receipt is needed for this page.' } };
}
