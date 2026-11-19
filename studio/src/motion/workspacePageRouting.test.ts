import type { Model } from '../../../shared/gateway';
import { isWorkspaceSettingsPage } from '../../../shared/workspace-url';
import { creativeStudios, studioScenes, sceneDestination, modelDestination } from './creativeStudios';
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

it('round-trips the Black Friday collection and its selected Skill without leaking either into the regular library', () => {
  const origin = 'http://localhost/?page=explore';
  const collection = new URL(workspacePageHref(origin, { templates: true, blackFriday: true, skill: 'openmotion-sale-promo' }), origin);
  expect(readWorkspacePage(collection.search)).toMatchObject({ explore: true, templates: true, blackFriday: true, skill: 'openmotion-sale-promo' });
  expect(readWorkspacePage('?templates=1&collection=black-friday&skill=unknown').skill).toBeNull();
  expect(readWorkspacePage('?templates=1&view=creators&collection=black-friday').blackFriday).toBe(false);
  expect(workspacePageHref(collection.href, { templates: false })).toBe('/?page=explore');
  expect(workspacePageHref(collection.href, { blackFriday: false, skill: null })).toBe('/?page=explore&templates=1');
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

it('round-trips studio scenes and provider-qualified models while preserving the project and template overlay', () => {
  const base = 'http://localhost/?page=cinema&scene=image-to-video&model=cloud%3Afilm%2Fv2&embed=1#project/film?t=8';
  const current = readWorkspacePage(new URL(base).search);
  expect(current.studio).toMatchObject({ scene: { id: 'image-to-video', modality: 'video' }, model: 'cloud:film/v2' });
  const overlay = new URL(workspacePageHref(base, { templates: true }), base);
  expect(readWorkspacePage(overlay.search)).toMatchObject({ studio: current.studio, templates: true });
  expect(workspacePageHref(overlay.href, { templates: false })).toContain('model=cloud%3Afilm%2Fv2');
  expect(workspacePageHref(base, { studio: null })).toBe('/?embed=1#project/film?t=8');
  expect(workspacePageHref(base, { assets: true })).toBe('/?embed=1&page=assets#project/film?t=8');
  expect(readWorkspacePage('?page=sound&scene=image-edit').studio?.scene.id).toBe('music');
});

it('round-trips every registered studio scene and resolves models in the current studio', () => {
  const registered = new Set<string>();
  for (const studio of creativeStudios) {
    for (const scene of studio.scenes) {
      const target = readWorkspacePage('?page=' + studio.id + '&scene=' + scene).studio!;
      expect([target.studio.id, target.scene.id]).toEqual([studio.id, scene]);
      const url = new URL(workspacePageHref('http://localhost/?page=explore', { studio: target }), 'http://localhost');
      expect(readWorkspacePage(url.search).studio).toEqual(target);
      registered.add(scene);
    }
  }
  expect(registered).toEqual(new Set(studioScenes.map(scene => scene.id)));
  const model: Model = { id: 'image:still', provider: 'image', modelId: 'still', label: 'Still', modality: 'image', mode: 'text-to-image', source: 'custom' };
  expect(modelDestination(model, readWorkspacePage('?page=cinema').studio)).toMatchObject({ studio: { id: 'cinema' }, scene: { id: 'shot-image' } });
  expect(modelDestination(model)).toMatchObject({ studio: { id: 'design' }, scene: { id: 'text-to-image' } });
});

it('carries the originating community through a standalone studio, direct reload and return', () => {
  const source = 'http://localhost/?page=explore&community=3d-motion&medium=video#project/film?t=8';
  const specialty = readWorkspacePage('?page=3d').specialty!;
  const next = new URL(workspacePageHref(source, { specialty, skill: 'three-js' }), source);
  expect(readWorkspacePage(next.search)).toMatchObject({ specialty, skill: 'three-js', community: '3d-motion', medium: 'video' });
  expect(new URL(workspacePageHref(next.href, { explore: true }), source).href).toBe(source);
  expect(readWorkspacePage('?page=3d&skill=unregistered&community=unknown&medium=text')).toMatchObject({ specialty, skill: null, community: null, medium: null });
});

it('opens a pinned asset without carrying its version or a studio scene into unrelated destinations', () => {
  const source = 'http://localhost/?embed=1&page=cinema&scene=shot-image&model=registered#project/film';
  const next = new URL(workspacePageHref(source, { assets: true, assetId: 'my-asset', assetVersion: 'older-version' }), source);
  expect(readWorkspacePage(next.search)).toMatchObject({ assets: true, assetId: 'my-asset', assetVersion: 'older-version', studio: null });
  expect(next.searchParams.has('scene')).toBe(false);
  const settings = new URL(workspacePageHref(next.href, { settings: 'account' }), source);
  expect(settings.searchParams.has('version')).toBe(false);
  expect(settings.searchParams.has('asset')).toBe(false);
  expect(settings.hash).toBe('#project/film');
  expect(readWorkspacePage('?page=assets&version=orphan').assetVersion).toBeNull();
});

it('opens every scene on its registered surface and round-trips the selected model and Explore collection', () => {
  const base = 'http://localhost/?page=explore&community=product-films&medium=image&embed=1#project/film?t=8';
  for (const scene of studioScenes) {
    const destination = sceneDestination(scene, null, 'provider:model/name');
    const url = new URL(workspacePageHref(base, { studio: destination }), base);
    expect(url.searchParams.get('page')).toBe(scene.entry === 'landing' ? 'create' : destination.studio.id);
    expect(isWorkspaceSettingsPage(url.search)).toBe(true);
    expect(readWorkspacePage(url.search).studio).toEqual(destination);
    expect(workspacePageHref(url.href, { explore: true })).toBe('/?embed=1&page=explore&community=product-films&medium=image#project/film?t=8');
  }
  expect(isWorkspaceSettingsPage('?page=create&scene=missing')).toBe(false);
  expect(readWorkspacePage('?page=create&scene=shot-image').studio).toBeNull();
  expect(workspacePageHref('http://localhost/?page=create&scene=bad&model=bad', { assets: true })).toBe('/?page=assets');
});

it('restores each specialty brief, model overview and nested creator preview from their URLs', () => {
  const origin = 'http://localhost/?page=explore&community=short-form#project/film';
  const open = (url: string, patch: Parameters<typeof workspacePageHref>[1]) => new URL(workspacePageHref(url, patch), origin);
  for (const entry of creativeStudios) {
    if (entry.surface !== 'techniques') continue;
    const href = open(origin, { specialty: entry, skill: entry.techniques[0] });
    expect(isWorkspaceSettingsPage(href.search)).toBe(true);
    expect(readWorkspacePage(href.search)).toMatchObject({ specialty: entry, skill: entry.techniques[0], community: 'short-form' });
  }
  const model = open(origin, { modelOverview: 'custom:provider/model' });
  expect(isWorkspaceSettingsPage(model.search)).toBe(true);
  expect(readWorkspacePage(model.search).modelOverview).toBe('custom:provider/model');
  expect(open(model.href, { explore: true }).href).toBe(origin);
  // A model hub is a standalone page, so a session's first artifact must not pull the viewer away from it.
  const hub = open(origin, { modelHub: 'gemini-4' });
  expect(hub.search).toContain('page=model-hub');
  expect(isWorkspaceSettingsPage(hub.search)).toBe(true);
  expect(readWorkspacePage(hub.search).modelHub).toBe('gemini-4');
  expect(isWorkspaceSettingsPage('?page=model-hub')).toBe(false);
  expect(open(hub.href, { explore: true }).href).toBe(origin);
  const directory = open(origin, { templates: true, creators: true });
  const profile = open(directory.href, { creator: 'credit/Jane & Co' });
  const detail = open(profile.href, { template: 'work-1' });
  expect(readWorkspacePage(detail.search)).toMatchObject({ explore: true, creators: true, creator: 'credit/Jane & Co', template: 'work-1' });
  expect(open(detail.href, { template: null }).href).toBe(profile.href);
  expect(open(profile.href, { templates: false }).href).toBe(origin);
});
