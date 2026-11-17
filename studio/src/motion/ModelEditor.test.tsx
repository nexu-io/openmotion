// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelEditor } from './ModelEditor';
import { ModelCatalog } from './ModelCatalog';
import { I18nProvider } from '../i18n/I18n';
import type { DirectoryModel, ProviderConnection } from '../../../shared/provider-directory';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; vi.restoreAllMocks(); });
async function mount(child: React.ReactNode) { const host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(<I18nProvider initialLocale="en">{child}</I18nProvider>)); }
function button(label: string) { const value = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label); expect(value).toBeTruthy(); return value!; }
async function fill(label: string, value: string) { await act(async () => { const input = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
const provider = { id: 'test', label: 'Test', protocol: 'openai', kinds: ['text'] } as ProviderConnection;
it('saves grouping, classification, exact token limits and default parameters through one model form', async () => {
  const save = vi.fn(async () => true), close = vi.fn();
  await mount(<ModelEditor provider={provider} save={save} onClose={close} onError={vi.fn()} />);
  await fill('Model ID', 'test-model'); await fill('Display name', 'My model'); await fill('Group name', 'Research');
  await act(async () => button('More settings').click());
  await act(async () => button('Reasoning').click()); await act(async () => button('Vision').click());
  await act(async () => button('Context window: 200000').click()); await act(async () => button('Max output tokens: 65536').click());
  await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'test-model', label: 'My model', group: 'Research', capabilities: ['reasoning'], inputs: ['vision'], contextWindow: 200000, maxOutputTokens: 65536, defaults: {} })); expect(close).toHaveBeenCalledOnce();
});
it('combines independent model filters, removes chips and retains group expansion', async () => {
  const models = [{ id: 'a', modelId: 'a', label: 'Reasoning model', kind: 'text', group: 'Research', capabilities: ['reasoning'], enabled: true, source: 'live' }, { id: 'b', modelId: 'b', label: 'Image model', kind: 'image', group: 'Creative', enabled: true, source: 'custom' }, { id: 'c', modelId: 'c', label: 'Disabled model', kind: 'text', group: 'Research', enabled: false, source: 'live' }] as DirectoryModel[];
  await mount(<ModelCatalog models={models} render={model => <p key={model.id} data-model={model.id}>{model.label}</p>} />);
  await act(async () => button('Filter models').click());
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(el => el.textContent === 'Language')!.click());
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(el => el.textContent === 'Enabled')!.click());
  expect([...document.querySelectorAll('[data-model]')].map(el => el.getAttribute('data-model'))).toEqual(['a']);
  await act(async () => button('Remove Language filter').click());
  expect(document.querySelectorAll('[data-model]')).toHaveLength(2);
  await act(async () => button('Clear filters').click());
  await act(async () => button('Collapse all groups').click()); expect(document.querySelectorAll('[data-model]')).toHaveLength(0);
  await act(async () => button('Expand all groups').click()); expect(document.querySelectorAll('[data-model]')).toHaveLength(3);
});
