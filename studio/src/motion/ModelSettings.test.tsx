// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelSettings, providerListStatus } from './ModelSettings';
import { I18nProvider } from '../i18n/I18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function click(text: string) {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text)!;
  expect(button, text).toBeTruthy();
  button.click();
}

async function mount(openAccount = vi.fn()) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<I18nProvider initialLocale="en"><ModelSettings openAccount={openAccount} /></I18nProvider>));
  return { openAccount };
}

const sampleModels = [
  { id: 'opendesign:image-pro', provider: 'opendesign', modelId: 'image-pro', label: 'Image Pro', modality: 'image', source: 'live', mode: 'text-to-image' },
  { id: 'opendesign:video-pro', provider: 'opendesign', modelId: 'video-pro', label: 'Video Pro', modality: 'video', source: 'live', mode: 'text-to-video' },
];

it('renders the unified OpenDesign Model Gateway with zero BYOK key or custom BaseURL forms', async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes('models/catalog')) return Response.json({ provider: 'opendesign', mode: 'opendesign', defaults: { image: 'opendesign:image-pro' }, models: sampleModels });
    if (url.includes('models/status')) return Response.json({ providers: [{ id: 'opendesign', label: 'OpenDesign', configured: true, enabled: true, available: true, plan: 'pro' }], routes: {} });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetcher);
  await mount();
  expect(document.body.textContent).toContain('OpenDesign Model Gateway');
  expect(document.body.textContent).toContain('Image Pro');
  expect(document.body.textContent).toContain('Video Pro');
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(document.querySelector('input[aria-label*="API key"]')).toBeNull();
  expect(document.querySelector('input[aria-label*="base URL"]')).toBeNull();
  expect(document.body.textContent).not.toContain('Add provider');
  expect(document.querySelector('[data-mock-gateway="true"]')).toBeNull();
});

it('displays the MODEL_GATEWAY_MODE=mock local development banner in mock mode', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('models/catalog')) return Response.json({ provider: 'opendesign', mode: 'mock', defaults: {}, models: sampleModels });
    return Response.json({ providers: [{ id: 'opendesign', label: 'OpenDesign', configured: true, enabled: true, available: true }], routes: {} });
  }));
  await mount();
  const banner = document.querySelector('[data-mock-gateway="true"]');
  expect(banner).not.toBeNull();
  expect(banner?.textContent).toContain('MODEL_GATEWAY_MODE=mock');
  expect(banner?.textContent).toContain('Local Mock Model Gateway');
});

it('syncs the live catalog and updates workspace defaults via PUT /motion-api/models/defaults', async () => {
  const writes: unknown[] = [];
  let defaults: Record<string, string | undefined> = { image: 'opendesign:image-pro' };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('models/defaults') && init?.method === 'PUT') {
      defaults = JSON.parse(String(init.body));
      writes.push(defaults);
      return Response.json({ workspaceId: 'ws-1', defaults });
    }
    if (url.includes('models/catalog')) return Response.json({ provider: 'opendesign', mode: 'opendesign', defaults, models: sampleModels });
    return Response.json({ providers: [{ id: 'opendesign', label: 'OpenDesign', configured: true, enabled: true, available: true }], routes: defaults });
  });
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await act(async () => click('Sync models'));
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('models/catalog?refresh=true'))).toBe(true);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Use Video Pro as default"]')!.click());
  expect(writes).toEqual([{ image: 'opendesign:image-pro', video: 'opendesign:video-pro' }]);
  expect(document.body.textContent).toContain('Default model updated');
});

it('reports admin-required 403 errors via floating Toast and recovers from failed loading', async () => {
  let failed = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (failed) return Response.json({ error: 'unavailable' }, { status: 503 });
    if (url.includes('models/defaults') && init?.method === 'PUT') return Response.json({ error: 'Forbidden' }, { status: 403 });
    if (url.includes('models/catalog')) return Response.json({ provider: 'opendesign', mode: 'opendesign', defaults: {}, models: sampleModels });
    return Response.json({ providers: [{ id: 'opendesign', label: 'OpenDesign', configured: true, enabled: true, available: true }], routes: {} });
  }));
  await mount();
  expect(document.body.textContent).toContain('Could not load settings');
  failed = false;
  await act(async () => click('Retry'));
  expect(document.body.textContent).toContain('Image Pro');
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Use Image Pro as default"]')!.click());
  expect(document.body.textContent).toContain('Workspace admin permission is required');
});

it('keeps providerListStatus compatibility semantics', () => {
  expect(providerListStatus({ configured: true, enabled: true, available: true })).toBe('available');
  expect(providerListStatus({ configured: true, enabled: false, available: false })).toBe('disabled');
  expect(providerListStatus({ configured: false, enabled: true, available: false })).toBeNull();
  expect(providerListStatus({ configured: true, enabled: true, available: false })).toBeNull();
});

it('shows honest unavailable status and subscription upgrade guidance when the workspace has zero models', async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes('models/catalog')) {
      return Response.json({ provider: 'opendesign', mode: 'opendesign', defaults: {}, models: [] });
    }
    if (url.includes('models/status')) {
      return Response.json({
        consoleUrl: 'https://console.example.test',
        providers: [
          {
            id: 'opendesign',
            label: 'OpenDesign',
            configured: true,
            enabled: true,
            available: false,
            reason: 'No media models are currently available for this OpenDesign workspace. Upgrade your plan or sync models.',
          },
        ],
        routes: {},
      });
    }
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetcher);
  const { openAccount } = await mount();
  expect(document.body.textContent).toContain('Unavailable');
  expect(document.body.textContent).not.toContain('add a model by its exact ID');
  const card = document.querySelector('[data-empty-models="true"]');
  expect(card).not.toBeNull();
  expect(card?.textContent).toContain('No media models available yet');
  const upgradeLink = card?.querySelector<HTMLAnchorElement>('a');
  expect(upgradeLink?.textContent).toContain('Upgrade to Plus');
  const upgradeUrl = new URL(upgradeLink!.href);
  expect(upgradeUrl.origin + upgradeUrl.pathname).toBe('https://console.example.test/dashboard');
  expect(upgradeUrl.searchParams.get('billing')).toBe('plan');
  expect(upgradeUrl.searchParams.get('od_entry_source')).toBe('openmotion_manage_subscription');
  await act(async () => click('Check account & plan'));
  expect(openAccount).toHaveBeenCalledTimes(1);
});
