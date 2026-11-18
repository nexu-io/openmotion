import { expect, it } from 'vitest';
import { readWorkspacePage, settingsSections, workspacePageHref } from './workspacePageRouting';

it.each(settingsSections)('round-trips the %s destination without changing editor or host context', settings => {
  const source = 'http://localhost/?session=project&project=project&embed=1&tracking_context=11111111-1111-1111-1111-111111111111#project/project?v=1&t=12&tab=design&rc=0';
  const next = new URL(workspacePageHref(source, { settings }), source);
  expect(readWorkspacePage(next.search).settings).toBe(settings);
  expect(next.hash).toBe(new URL(source).hash);
  for (const key of ['session', 'project', 'embed', 'tracking_context']) expect(next.searchParams.get(key)).toBe(new URL(source).searchParams.get(key));
  const editor = new URL(workspacePageHref(next.href, { settings: null }), source);
  expect(editor.href).toBe(source);
});

it('retains the library return page and selected detail, and clears page-specific options on exit', () => {
  const source = 'http://localhost/?page=mcp&host=claude&setup=manual';
  const library = new URL(workspacePageHref(source, { templates: true, template: 'film/a & b' }), source);
  expect(readWorkspacePage(library.search)).toMatchObject({ settings: 'mcp', templates: true, template: 'film/a & b', client: 'claude', setup: 'manual' });
  expect(workspacePageHref(library.href, { templates: false })).toBe('/?page=mcp&host=claude&setup=manual');
  const providers = new URL(workspacePageHref(library.href, { settings: 'providers', templates: false, provider: 'custom-a' }), source);
  expect(providers.search).toBe('?page=settings&section=providers&provider=custom-a');
  expect(workspacePageHref(providers.href, { settings: 'general' })).toBe('/?page=settings&section=general');
});

it('keeps legacy editor and template URLs and safely defaults unknown options', () => {
  expect(readWorkspacePage('?templates=1').templates).toBe(true);
  expect(readWorkspacePage('?project=project').settings).toBeNull();
  expect(readWorkspacePage('?page=unknown').settings).toBeNull();
  expect(readWorkspacePage('?page=settings&section=unknown').settings).toBe('general');
  expect(readWorkspacePage('?page=mcp&host=unknown&setup=unknown')).toMatchObject({ settings: 'mcp', client: 'codex', setup: 'agent' });
});


it('round-trips Assets with editor context and preserves it underneath the template library', () => {
  const source = 'http://localhost/?project=project&embed=1#project/project?t=12';
  const assets = new URL(workspacePageHref(source, { assets: true }), source);
  expect(readWorkspacePage(assets.search)).toMatchObject({ assets: true, settings: null });
  expect(assets.hash).toBe(new URL(source).hash);
  const library = new URL(workspacePageHref(assets.href, { templates: true }), source);
  expect(workspacePageHref(library.href, { templates: false })).toBe(assets.pathname + assets.search + assets.hash);
  const settings = new URL(workspacePageHref(assets.href, { settings: 'providers' }), source);
  expect(readWorkspacePage(settings.search)).toMatchObject({ assets: false, settings: 'providers' });
  expect(workspacePageHref(assets.href, { assets: false })).toBe(new URL(source).pathname + new URL(source).search + new URL(source).hash);
});

it('preserves a Brand Kit selection behind template browsing and clears it when leaving', () => {
  const source = 'http://localhost/?page=brand-kit&kit=one&embed=1#project/retained';
  expect(readWorkspacePage(new URL(source).search)).toMatchObject({ settings: 'brand-kit', brandKit: 'one' });
  const next = new URL(workspacePageHref(source, { templates: true }), source);
  expect(readWorkspacePage(next.search)).toMatchObject({ settings: 'brand-kit', brandKit: 'one', templates: true });
  expect(workspacePageHref(next.href, { settings: null, templates: false })).toBe('/?embed=1#project/retained');
});

it('keeps entry_from while switching settings sections and clears it when leaving settings', () => {
  const source = 'http://localhost/?page=settings&section=providers&entry_from=agent_media_upgrade_go&embed=1';
  const account = new URL(workspacePageHref(source, { settings: 'account' }), source);
  expect(account.searchParams.get('section')).toBe('account');
  expect(account.searchParams.get('entry_from')).toBe('agent_media_upgrade_go');
  const subscription = new URL(workspacePageHref(account.href, { settings: 'subscription' }), source);
  expect(subscription.searchParams.get('entry_from')).toBe('agent_media_upgrade_go');
  const brandKit = new URL(workspacePageHref(subscription.href, { settings: 'brand-kit' }), source);
  expect(brandKit.searchParams.has('entry_from')).toBe(false);
  expect(new URL(workspacePageHref(brandKit.href, { settings: 'account' }), source).searchParams.has('entry_from')).toBe(false);
  const mcp = new URL(workspacePageHref(subscription.href, { settings: 'mcp' }), source);
  expect(mcp.searchParams.has('entry_from')).toBe(false);
  expect(new URL(workspacePageHref(mcp.href, { settings: 'account' }), source).searchParams.has('entry_from')).toBe(false);
  const assets = new URL(workspacePageHref(subscription.href, { assets: true }), source);
  expect(assets.searchParams.has('entry_from')).toBe(false);
  const skills = new URL(workspacePageHref(subscription.href, { skills: true }), source);
  expect(skills.searchParams.has('entry_from')).toBe(false);
  const closed = new URL(workspacePageHref(subscription.href, { settings: null }), source);
  expect(closed.searchParams.has('entry_from')).toBe(false);
});
