// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelSettings, providerListStatus } from './ModelSettings';
import { I18nProvider } from '../i18n/I18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function type(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function click(text: string) { const button = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === text)!; expect(button).toBeTruthy(); button.click(); }
async function mount(providerId?: string) {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<I18nProvider initialLocale="en"><ModelSettings openAccount={() => {}} providerId={providerId} /></I18nProvider>));
}
const account = { id: 'account', label: 'OpenDesign', protocol: 'account', category: 'account', kinds: ['text', 'image'], configured: false, enabled: false, available: false };
it('hides text-only providers across search and direct links while preserving media and unclassified custom connections', async () => {
  const text = { ...account, id: 'text-only', label: 'Text only', protocol: 'openai', category: 'language', kinds: ['text'], configured: true, custom: false };
  const fetcher = vi.fn(async () => Response.json({ providers: [account, text,
    { ...text, id: 'media', label: 'Media models', kinds: ['text', 'image'] },
    { ...text, id: 'discovered-media', label: 'Discovered media' },
    { ...text, id: 'custom-new', label: 'New connection', custom: true },
    { ...text, id: 'custom-text', label: 'Custom text', custom: true }],
    models: [{ provider: 'custom-text', kind: 'text' }, { provider: 'discovered-media', kind: 'image' }], defaults: {} }));
  vi.stubGlobal('fetch', fetcher); await mount('text-only');
  const names = [...document.querySelectorAll('.om-provider-item-name')].map(node => node.firstChild?.textContent);
  expect(names).toEqual(['OpenDesign', 'Media models', 'Discovered media', 'New connection']);
  expect(document.querySelector('.om-provider-heading h1')?.textContent).toBe('OpenDesign');
  await act(async () => type('Search providers', 'Text only'));
  expect(document.querySelectorAll('.om-provider-item')).toHaveLength(0);
  expect(document.body.textContent).toContain('No matching providers');
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Clear filters"]')!.click());
  expect(document.querySelectorAll('.om-provider-item')).toHaveLength(4);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
for (const [id, label] of [['fal', 'fal.ai'], ['atlascloud', 'Atlas Cloud'], ['wavespeed', 'WaveSpeedAI']]) it(`saves and removes ${label} credentials without revealing the key or making a paid call`, async () => {
  let configured = false; const writes: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { expect(url).toBe(`/motion-api/settings/providers/${id}`); const body = JSON.parse(String(init.body)); writes.push(body); configured = !!body.apiKey; return Response.json({}); }
    expect(url).toBe('/motion-api/settings/providers');
    return Response.json({ providers: [account, { id, label, protocol: 'media', category: 'multimodal', kinds: ['image', 'video', 'audio'], baseUrl: 'https://api.example', baseUrlEditable: false, configured, enabled: configured, available: configured, credentialSource: configured ? 'stored' : 'none' }], models: [], defaults: {} });
  }));
  await mount();
  expect(document.body.textContent).toContain('One account. Your models, together.');
  await act(async () => document.querySelectorAll<HTMLButtonElement>('.om-provider-item')[1].click());
  await act(async () => type(`${label} API key`, 'synthetic-private-key'));
  await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(writes).toEqual([{ apiKey: 'synthetic-private-key' }]);
  expect(document.querySelector<HTMLInputElement>(`[aria-label="${label} API key"]`)!.value).toBe('');
  expect(document.querySelector('[role=switch]')?.getAttribute('aria-checked')).toBe('true');
  expect(document.body.textContent).not.toContain('synthetic-private-key');
  await act(async () => click('Remove saved key'));
  expect(writes[1]).toEqual({ apiKey: null });
  expect(document.querySelector('[role=switch]')?.getAttribute('aria-checked')).toBe('false');
});

it('searches providers without mutating credentials and recovers from failed directory loading', async () => {
  let failed = true;
  const fetcher = vi.fn(async () => failed ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json({ providers: [account], models: [], defaults: {} }));
  vi.stubGlobal('fetch', fetcher); await mount();
  expect(document.body.textContent).toContain('Could not load settings');
  failed = false; await act(async () => click('Retry'));
  await act(async () => type('Search providers', 'absent'));
  expect(document.body.textContent).toContain('No matching providers');
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Clear filters"]')!.click());
  expect(document.querySelectorAll('.om-provider-item')).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('marks only runnable providers with a dot and configured-but-switched-off providers as Disabled', async () => {
  expect(providerListStatus({ configured: true, enabled: true, available: true })).toBe('available');
  expect(providerListStatus({ configured: true, enabled: false, available: false })).toBe('disabled');
  expect(providerListStatus({ configured: false, enabled: true, available: false })).toBeNull();
  expect(providerListStatus({ configured: false, enabled: false, available: false })).toBeNull();
  expect(providerListStatus({ configured: true, enabled: true, available: false })).toBeNull();
  const media = { protocol: 'media', category: 'multimodal', kinds: ['image', 'video'], baseUrl: 'https://api.example', custom: false, credentialSource: 'stored' };
  const providers = [
    { ...media, id: 'ready', label: 'Ready', configured: true, enabled: true, available: true },
    { ...media, id: 'off', label: 'Off', configured: true, enabled: false, available: false },
    { ...media, id: 'empty', label: 'Empty', configured: false, enabled: false, available: false, credentialSource: 'none' },
  ];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ providers, models: [], defaults: {} })));
  await mount();
  const row = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.om-provider-item')].find(node => node.textContent?.includes(label))!;
  expect(row('Ready').querySelector('.om-status-dot')).toBeTruthy();
  expect(row('Ready').getAttribute('aria-label')).toContain('Available');
  expect(row('Off').dataset.status).toBe('disabled');
  expect(row('Off').querySelector('.om-badge')?.textContent).toBe('Disabled');
  expect(row('Off').querySelector('.om-status-dot')).toBeNull();
  expect(row('Empty').querySelector('.om-status-dot, .om-badge, .ri-check-line')).toBeNull();
});
