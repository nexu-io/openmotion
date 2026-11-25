// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const account = vi.hoisted(() => ({ state: 'signed-out' as string }));
vi.mock('./AccountSettings', () => ({ useAccountSummary: () => ({ account: { state: account.state } }) }));
vi.mock('./useMediaCatalog', () => ({ useMediaCatalog: () => ({ catalog: { models: [], status: { providers: [{ id: 'gemini', label: 'Gemini', available: false }] } }, failed: false, retry: () => {} }) }));
import { ModelHub } from './ModelHub';
import { I18nProvider } from '../i18n/I18n';

let container: HTMLDivElement;
afterEach(() => container?.remove());
async function render() {
  container = document.createElement('div'); document.body.append(container);
  const onProvider = vi.fn();
  const onOpenMcp = vi.fn();
  const onSettings = vi.fn();
  const onUse = vi.fn();
  await act(async () => createRoot(container).render(<I18nProvider initialLocale="en"><ModelHub id="gemini-4" onExplore={() => {}} onProvider={onProvider} onOpenMcp={onOpenMcp} onModel={() => {}} onUse={onUse} onSettings={onSettings} /></I18nProvider>));
  return { onProvider, onOpenMcp, onSettings, onUse, hero: () => [...container.querySelectorAll<HTMLButtonElement>('.om-model-hub-hero-copy button')].map(button => button.textContent) };
}

it('guides guests to sign in on Open in Motion Studio and always surfaces Connect MCP until connected', async () => {
  account.state = 'signed-out';
  let view = await render();
  expect(view.hero()).toContain('Open in Motion Studio');
  expect(view.hero()).toContain('Connect MCP');
  const [openBtn, mcpBtn] = [...container.querySelectorAll<HTMLButtonElement>('.om-model-hub-hero-copy button')];
  await act(async () => openBtn.click());
  expect(view.onSettings).toHaveBeenCalledWith('account');
  await act(async () => mcpBtn.click());
  expect(view.onOpenMcp).toHaveBeenCalled();
  container.remove();

  account.state = 'signed-in';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ connections: [{ activeTokenCount: 1 }] }),
  }));
  view = await render();
  expect(view.hero()).toContain('Open in Motion Studio');
  expect(view.hero()).toContain('Connected to Gemini · MCP');
  await act(async () => container.querySelector<HTMLButtonElement>('.om-model-hub-connected')!.click());
  expect(view.onOpenMcp).toHaveBeenCalled();
  vi.unstubAllGlobals();
});
