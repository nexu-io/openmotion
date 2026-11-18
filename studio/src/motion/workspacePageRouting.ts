/** Application pages live in the query; the project hash belongs to the editor. */
export const settingsSections = ['account', 'subscription', 'providers', 'models', 'local', 'general', 'appearance', 'privacy', 'about', 'help', 'mcp', 'brand-kit'] as const;
export type SettingsSection = typeof settingsSections[number];
export const mcpClients = ['codex', 'claude', 'cursor', 'deepseek', 'desktop', 'chatgpt', 'mcp'] as const;
export type McpClient = typeof mcpClients[number];
export type WorkspacePage = { settings: SettingsSection | null; assets: boolean; skills: boolean; skill: string | null; templates: boolean; client: McpClient; setup: 'agent' | 'manual'; provider: string | null; template: string | null; brandKit: string | null };

export function readWorkspacePage(search: string): WorkspacePage {
  const query = new URLSearchParams(search), page = query.get('page'), section = query.get('section');
  const settings = page === 'brand-kit' ? 'brand-kit' : page === 'mcp' ? 'mcp' : page === 'settings'
    ? settingsSections.find(value => value === section) ?? 'general' : null;
  return { settings, brandKit: settings === 'brand-kit' ? query.get('kit') || null : null, assets: page === 'assets', skills: page === 'skills', skill: page === 'skills' ? query.get('skill') || null : null, templates: query.get('templates') === '1',
    client: mcpClients.find(value => value === query.get('host')) ?? 'codex',
    setup: query.get('setup') === 'manual' ? 'manual' : 'agent',
    provider: settings === 'providers' ? query.get('provider') || null : null,
    template: query.get('templates') === '1' ? query.get('template') || null : null };
}

export function workspacePageHref(href: string, patch: Partial<WorkspacePage>): string {
  const url = new URL(href), page = { ...readWorkspacePage(url.search), ...patch };
  for (const key of ['page', 'section', 'templates', 'host', 'setup', 'provider', 'template', 'skill', 'kit']) url.searchParams.delete(key);
  if (patch.settings) { page.assets = false; page.skills = false; }
  if (patch.assets) { page.settings = null; page.skills = false; }
  if (patch.skills) { page.settings = null; page.assets = false; }
  const inSettings = Boolean(page.settings) && !page.assets && !page.skills && page.settings !== 'brand-kit' && page.settings !== 'mcp';
  if (!inSettings) url.searchParams.delete('entry_from');
  if (page.skills) {
    url.searchParams.set('page', 'skills');
    if (page.skill) url.searchParams.set('skill', page.skill);
  } else if (page.assets) {
    url.searchParams.set('page', 'assets');
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
  }
  if (page.templates) {
    url.searchParams.set('templates', '1');
    if (page.template) url.searchParams.set('template', page.template);
  }
  return url.pathname + url.search + url.hash;
}
