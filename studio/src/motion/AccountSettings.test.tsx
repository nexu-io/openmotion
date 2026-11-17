// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { AccountSummary } from '../../../shared/provider-directory';
import { I18nProvider, type Locale } from '../i18n/I18n';
import { AccountSettings } from './AccountSettings';
import { GITHUB_REPOSITORY } from './githubRepository';

const hooks = vi.hoisted(() => ({ account: undefined as unknown, request: vi.fn() }));
vi.mock('./gatewayClient', () => ({ gatewayRequest: hooks.request }));
vi.mock('./useProviderDirectory', () => ({ notifyProvidersChanged: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.clearAllMocks(); });

const activation = 'https://open-design.ai/activate?code=TEST-123';
async function open(account: Partial<AccountSummary>, locale: Locale = 'en') {
  hooks.account = { consoleUrl: 'https://open-design.ai/cloud', ...account };
  hooks.request.mockImplementation(async () => hooks.account);
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<I18nProvider initialLocale={locale}><AccountSettings openProviders={() => {}} /></I18nProvider>));
  return container;
}
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll<HTMLElement>('.om-settings-actions .om-button')].find(item => item.textContent === label);
const actions = (container: HTMLElement) => [...container.querySelectorAll('.om-settings-actions .om-button')].map(item => item.textContent);

it('leaves the activation page to the browser and leads with the link only when the browser did not open', async () => {
  let page = await open({ state: 'authorizing', authorizationUrl: activation, userCode: 'TEST-123', browserOpened: true });
  expect(page.querySelector('[role=status]')?.textContent).toBe('Waiting for browser authorization…TEST-123');
  const fallback = button(page, "Didn't open? Click here") as HTMLAnchorElement;
  expect(fallback.href).toBe(activation); expect(fallback.hasAttribute('data-primary')).toBe(false);
  expect(actions(page)).toEqual(["Didn't open? Click here", 'Cancel']);
  act(() => root!.unmount()); document.body.innerHTML = '';
  page = await open({ state: 'authorizing', authorizationUrl: activation, userCode: 'TEST-123', browserOpened: false });
  expect(button(page, 'Continue in browser')?.hasAttribute('data-primary')).toBe(true);
  expect(page.querySelectorAll(`a[href="${activation}"]`)).toHaveLength(1);
});

it('says it is connecting until the link exists, then syncing with nothing left to click', async () => {
  let page = await open({ state: 'authorizing' }, 'zh-CN');
  expect(page.querySelector('[role=status]')?.textContent).toBe('正在连接 OpenDesign，请稍候…');
  expect(page.textContent).not.toMatch(/组件|下载/);
  expect(actions(page)).toEqual(['取消']);
  act(() => root!.unmount()); document.body.innerHTML = '';
  page = await open({ state: 'authorizing', syncing: true, browserOpened: true }, 'zh-CN');
  expect(page.querySelector('[role=status]')?.textContent).toBe('已授权，正在同步账户信息…');
  expect(page.querySelector('.om-account-summary h2')?.textContent).toBe('正在完成登录');
  expect(actions(page)).toEqual(['取消']); expect((button(page, '取消') as HTMLButtonElement).disabled).toBe(true);
});

it('offers a retry after a connection failure, and sign-in again with a feedback link after rejected credentials', async () => {
  let page = await open({ state: 'signed-out', errorCode: 'setup_failed', error: "Can't connect to OpenDesign right now. Check your network and try again." });
  expect(actions(page)).toEqual(['Retry']); expect(page.querySelector('[role=alert]')?.textContent).toContain("Can't connect to OpenDesign");
  await act(async () => button(page, 'Retry')!.click());
  expect(hooks.request).toHaveBeenCalledWith('settings/account/login', 'POST', {});
  act(() => root!.unmount()); document.body.innerHTML = '';
  page = await open({ state: 'signed-out', errorCode: 'credentials_rejected', error: 'Account credentials could not be verified. Sign in again, and contact us if this keeps happening.' });
  expect(actions(page)).toEqual(['Sign in again', 'Report an issue']);
  expect((button(page, 'Report an issue') as HTMLAnchorElement).href).toBe(`${GITHUB_REPOSITORY}/issues/new/choose`);
  act(() => root!.unmount()); document.body.innerHTML = '';
  page = await open({ state: 'signed-out', errorCode: 'authorization_expired', error: 'Browser authorization expired or was cancelled. Sign in again.' });
  expect(actions(page)).toEqual(['Sign in again']);
});

it('shows the account email once, under the name only when the account has a different one', async () => {
  const identity = async (user: AccountSummary['user']) => {
    const page = await open({ state: 'signed-in', user, plan: 'pro', balance: '1.00' });
    const result = [page.querySelector('.om-account-identity h1')?.textContent, page.querySelector('.om-account-identity p')?.textContent];
    act(() => root!.unmount()); document.body.innerHTML = '';
    return result;
  };
  expect(await identity({ email: 'ada@example.test' })).toEqual(['ada@example.test', 'Your creative workspace, connected.']);
  expect(await identity({ name: 'Ada@Example.test', email: 'ada@example.test' })).toEqual(['ada@example.test', 'Your creative workspace, connected.']);
  expect(await identity({ name: 'Ada', email: 'ada@example.test' })).toEqual(['Ada', 'ada@example.test']);
});

it('explains that account models still work when the plan and balance cannot be read', async () => {
  const page = await open({ state: 'signed-in', user: { email: 'ada@example.test' }, billingUnavailable: true }, 'zh-CN');
  expect(page.textContent).toContain('暂时无法读取订阅和余额。账户模型不受影响，可以照常使用。');
});

it('replaces missing billing metrics with a dashboard link on 403 and restores them on retry', async () => {
  const page = await open({ state: 'signed-in', billingUnavailable: true, billingError: { status: 403 } }, 'zh-CN');
  expect(page.textContent).toContain('账单服务拒绝了本次查询');
  expect(page.querySelector('.om-account-metrics')).toBeNull();
  expect(page.querySelector('a')?.href).toBe('https://open-design.ai/cloud/dashboard?billing=plan');
  hooks.account = { state: 'signed-in', plan: 'pro', balance: '0.00', consoleUrl: 'https://open-design.ai/cloud' };
  await act(async () => page.querySelector<HTMLButtonElement>('button[aria-busy]')!.click());
  expect(page.querySelector('.om-account-metrics')?.textContent).toContain('$0.00');
  expect(page.textContent).not.toContain('账单服务拒绝了本次查询');
});
