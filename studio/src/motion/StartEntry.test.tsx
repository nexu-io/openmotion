// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccountSummary } from '../../../shared/provider-directory';
import { studioEvents } from '../../../tracking/events.ts';
import { validProperties } from '../../../tracking/core.ts';
import { I18nProvider } from '../i18n/I18n';
import { gatewayRequest } from './gatewayClient';
import { StartEntry } from './StartEntry';
import { trackMotion } from './tracking';

vi.mock('./tracking', () => ({ trackMotion: vi.fn(async () => 'queued') }));
vi.mock('./gatewayClient', () => ({ gatewayRequest: vi.fn() }));
vi.mock('./useProviderDirectory', () => ({ notifyProvidersChanged: vi.fn() }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.mocked(trackMotion).mockClear();
  vi.mocked(gatewayRequest).mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const render = (account: AccountSummary, openAccount = vi.fn()) => {
  act(() => root.render(<I18nProvider initialLocale="zh-CN"><StartEntry account={account} trackingPage="explore" openAccount={openAccount} /></I18nProvider>));
  return openAccount;
};
const button = () => container.querySelector('button')!;

it('starts the OpenDesign sign-in and opens Settings > Account in one click', async () => {
  vi.mocked(gatewayRequest).mockResolvedValue({ state: 'authorizing' });
  const openAccount = render({ state: 'signed-out' });
  expect(button().textContent).toBe('开始使用');
  await act(async () => { button().click(); });
  expect(gatewayRequest).toHaveBeenCalledWith('settings/account/login', 'POST', {});
  expect(openAccount).toHaveBeenCalledTimes(1);
  const click = vi.mocked(trackMotion).mock.calls.find(([event]) => event === 'ui_click')![1] as Record<string, unknown>;
  expect(click).toMatchObject({ page_name: 'explore', area: 'header', element: 'start_sign_in' });
  expect(validProperties(studioEvents, 'ui_click', click)).toBe(true);
});

it('still opens Settings > Account when sign-in cannot start, where the reason is shown', async () => {
  vi.mocked(gatewayRequest).mockRejectedValue(new Error('offline'));
  const openAccount = render({ state: 'signed-out' });
  await act(async () => { button().click(); });
  expect(openAccount).toHaveBeenCalledTimes(1);
});

it('does not start a second sign-in while one is waiting for the browser', async () => {
  const openAccount = render({ state: 'authorizing' });
  expect(button().textContent).toBe('登录中…');
  await act(async () => { button().click(); });
  expect(gatewayRequest).not.toHaveBeenCalled();
  expect(openAccount).toHaveBeenCalledTimes(1);
});
