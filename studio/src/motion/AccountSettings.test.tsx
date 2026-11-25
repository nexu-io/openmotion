// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { uuid } from '../../../tracking/core';
import type { AccountSummary } from '../../../shared/provider-directory';
import { I18nProvider, type Locale } from '../i18n/I18n';
import { AccountSettings } from './AccountSettings';
import { GITHUB_REPOSITORY } from './githubRepository';
import { notifyProvidersChanged } from './useProviderDirectory';

const hooks = vi.hoisted(() => ({ account: undefined as unknown, request: vi.fn() }));
vi.mock('./gatewayClient', () => ({ gatewayRequest: hooks.request }));
vi.mock('./useProviderDirectory', () => ({ notifyProvidersChanged: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.clearAllMocks(); });

const activation = 'https://open-design.ai/activate?code=TEST-123';
async function open(account: Partial<AccountSummary>, locale: Locale = 'en', section: 'account' | 'subscription' = 'account') {
  hooks.account = { consoleUrl: 'https://open-design.ai/cloud', ...account };
  hooks.request.mockImplementation(async () => hooks.account);
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<I18nProvider initialLocale={locale}><AccountSettings subscription={section === 'subscription'} openProviders={() => {}} /></I18nProvider>));
  return container;
}
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll<HTMLElement>('.om-settings-actions :is(button, a)')].find(item => item.textContent === label);
const actions = (container: HTMLElement) => [...container.querySelectorAll('.om-settings-actions :is(button, a)')].map(item => item.textContent);

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

it('explains a missing sign-in component, offers Retry and a copyable command that installs it where the service looks', async () => {
  const command = "npm install --prefix '/opt/openmotion/data/account/runtime' --ignore-scripts @powerformer/vela-cli@0.1.10";
  const writeText = vi.fn(async () => {}); Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  const page = await open({ state: 'signed-out', errorCode: 'connector_unavailable', connectorInstall: { command },
    error: "OpenMotion couldn't find npm to set up the OpenDesign sign-in component. Run this command in a terminal, then select Retry:" }, 'zh-CN');
  expect(page.querySelector('[role=alert]')?.textContent).toBe('OpenMotion 找不到 npm，无法安装 OpenDesign 登录组件。请在终端运行下面的命令，然后点「重试」：');
  expect(page.querySelector('.om-account-summary .om-code-block')?.textContent).toBe(command);
  expect(actions(page)).toEqual(['重试', '复制口令']);
  await act(async () => button(page, '复制口令')!.click());
  expect(writeText).toHaveBeenCalledWith(command);
  await act(async () => button(page, '重试')!.click());
  expect(hooks.request).toHaveBeenCalledWith('settings/account/login', 'POST', { hookId: 'settings_signin', entryId: expect.any(String) });
});

it('offers a retry after a connection failure, and sign-in again with a feedback link after rejected credentials', async () => {
  let page = await open({ state: 'signed-out', errorCode: 'setup_failed', error: "Can't connect to OpenDesign right now. Check your network and try again." });
  expect(actions(page)).toEqual(['Retry']); expect(page.querySelector('[role=alert]')?.textContent).toContain("Can't connect to OpenDesign");
  await act(async () => button(page, 'Retry')!.click());
  expect(hooks.request).toHaveBeenCalledWith('settings/account/login', 'POST', { hookId: 'settings_signin', entryId: expect.any(String) });
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

it('refreshes Go on checkout return and updates providers only after the plan changes', async () => {
  const page = await open({ state: 'signed-in', plan: 'go', balance: '0.00' }, 'en', 'subscription');
  const original = hooks.account;
  hooks.request.mockImplementation(async (route: string) => route === 'settings/account/subscription' ? { opened: true } : hooks.account);
  hooks.request.mockClear();
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(hooks.request).not.toHaveBeenCalled();
  await act(async () => button(page, 'Upgrade to Plus')!.click());
  expect(hooks.request).toHaveBeenCalledWith('settings/account/subscription', 'POST', { hookId: 'settings_subscription', entryId: expect.stringMatching(uuid) });
  hooks.account = { ...original as AccountSummary, plan: 'plus', balance: '4.00' };
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const billingReads = () => hooks.request.mock.calls.filter(([route]) => route === 'settings/account?refresh=true').length;
  expect(billingReads()).toBe(1);
  expect(page.querySelector('[data-guide="upgrade"]')).toBeNull();
  expect(page.querySelector('.om-plan-usage h2')?.textContent).toBe('Plus');
  expect(notifyProvidersChanged).toHaveBeenCalledTimes(1);
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(billingReads()).toBe(1);
});

it('explains that account models still work when the plan and balance cannot be read', async () => {
  const page = await open({ state: 'signed-in', user: { email: 'ada@example.test' }, billingUnavailable: true }, 'zh-CN', 'subscription');
  expect(page.textContent).toContain('暂时无法读取订阅和余额。账户模型不受影响，可以照常使用。');
});

it('asks the local service to open the subscription page in the system browser, and opens it itself only as a fallback', async () => {
  const page = await open({ state: 'signed-in', user: { email: 'ada@example.test' }, plan: 'plus', balance: '12.00' }, 'en', 'subscription');
  const manage = page.querySelector<HTMLButtonElement>('.om-plan-usage button.om-plan-usage-console')!;
  expect(manage.textContent).toBe('Go to console');
  expect(page.querySelector('.om-plan-usage h2')?.textContent).toBe('Plus');
  expect(page.querySelector('.om-plan-usage [data-quota="balance"]')?.textContent).toContain('$12.00');
  expect(page.querySelector('.om-settings-section a')).toBeNull();
  const popup = vi.spyOn(window, 'open').mockReturnValue(null);
  const handoff = 'https://open-design.ai/cloud/login?intentId=intent-1';
  hooks.request.mockImplementation(async (route: string) => route === 'settings/account/subscription' ? { url: handoff, opened: true } : hooks.account);
  await act(async () => manage.click());
  expect(hooks.request).toHaveBeenCalledWith('settings/account/subscription', 'POST', { hookId: 'settings_subscription', entryId: expect.any(String) });
  expect(popup).not.toHaveBeenCalled();
  const fallback = { opener: window as Window | null };
  popup.mockReturnValue(fallback as unknown as Window);
  hooks.request.mockImplementation(async (route: string) => route === 'settings/account/subscription' ? { url: handoff, opened: false } : hooks.account);
  await act(async () => manage.click());
  expect(popup).toHaveBeenCalledWith(handoff, '_blank'); expect(fallback.opener).toBeNull();
  expect(page.querySelector('.om-settings-section a')).toBeNull();
  popup.mockReturnValue(null);
  await act(async () => manage.click());
  const link = page.querySelector<HTMLAnchorElement>('.om-settings-section > a.om-button')!;
  expect(link.textContent).toBe('Continue in browser'); expect(link.href).toBe(handoff); expect(link.target).toBe('_blank');
  await act(async () => link.click());
  expect(page.querySelector('.om-settings-section a')).toBeNull();
  hooks.request.mockImplementation(async (route: string) => { if (route === 'settings/account/subscription') throw new Error('offline'); return hooks.account; });
  await act(async () => manage.click());
  expect(document.body.textContent).toContain("Couldn't open your browser. Try again.");
  popup.mockRestore();
});

it('shows an unknown plan, not Free or an Upgrade, until the first billing read arrives', async () => {
  const page = await open({ state: 'signed-in', user: { email: 'ada@example.test' } }, 'en', 'subscription');
  expect(page.querySelector('.om-plan-usage h2')?.textContent).toBe('—');
  expect(page.querySelector('.om-plan-usage [data-quota="balance"]')?.textContent).toContain('—');
  expect([...page.querySelectorAll('.om-plan-usage button')].map(item => item.textContent)).toEqual(['Go to console', 'Top up']);
});

it('replaces missing billing metrics with a dashboard link on 403 and restores them on retry', async () => {
  const page = await open({ state: 'signed-in', billingUnavailable: true, billingError: { status: 403 } }, 'zh-CN', 'subscription');
  expect(page.textContent).toContain('账单服务拒绝了本次查询');
  expect(page.querySelector('.om-account-metrics')).toBeNull();
  expect([...page.querySelectorAll('.om-settings-section button.om-button')].some(item => item.textContent === '管理订阅')).toBe(true);
  hooks.account = { state: 'signed-in', plan: 'pro', balance: '0.00', consoleUrl: 'https://open-design.ai/cloud' };
  await act(async () => page.querySelector<HTMLButtonElement>('button[aria-busy]')!.click());
  expect(page.querySelector('.om-plan-usage')?.textContent).toContain('$0.00');
  expect(page.textContent).not.toContain('账单服务拒绝了本次查询');
});

it.each(['free', 'go'])('offers an upgrade above the connected account for the %s plan and refreshes after checkout', async plan => {
  const page = await open({ state: 'signed-out' });
  const offer = () => page.querySelector<HTMLElement>('section[data-guide="upgrade"]');
  expect(actions(page)).toEqual(['Sign in now']);
  expect(offer()).toBeNull();
  await act(async () => button(page, 'Sign in now')!.click());
  expect(hooks.request).toHaveBeenCalledWith('settings/account/login', 'POST', { hookId: 'settings_signin', entryId: expect.stringMatching(uuid) });

  hooks.account = { state: 'signed-in', plan, balance: '12.00' };
  await act(async () => window.dispatchEvent(new Event('motion:account-changed')));
  expect(actions(page)).toEqual(['Upgrade to Plus', 'Sign out']);
  expect(page.querySelector('.om-account-metrics, .om-plan-guide')).toBeNull();
  expect(page.textContent).toContain('Model providers');
  expect(offer()).not.toBeNull();
  const connected = page.querySelector('.om-account-summary');
  expect(page.querySelector('.om-account-identity')?.nextElementSibling).toBe(offer());
  expect(offer()?.nextElementSibling).toBe(connected);
  expect(connected?.nextElementSibling?.textContent).toContain('Model providers');
  const upgrade = offer()!.querySelector('button')!;
  expect(upgrade.textContent).toBe('Upgrade to Plus');
  hooks.request.mockImplementation(async (route: string) => route === 'settings/account/subscription' ? { opened: true } : hooks.account);
  await act(async () => upgrade.click());
  expect(hooks.request).toHaveBeenCalledWith('settings/account/subscription', 'POST', { hookId: 'settings_subscription', entryId: expect.stringMatching(uuid) });
  hooks.account = { state: 'signed-in', plan: 'plus' };
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(offer()).toBeNull();
});

it.each(['account', 'subscription'] as const)('shows the localized sign-in offer on the %s page', async section => {
  const page = await open({ state: 'signed-out' }, 'zh-CN', section);
  const guide = page.querySelector<HTMLElement>('[data-guide="sign-in"]')!;
  expect(guide.querySelector('h2')?.textContent).toBe('登录后精选模型7天无限用');
  expect(guide.querySelector('h2 span')?.textContent).toBe('7天无限用');
  expect(guide.querySelector('h2 + span')?.textContent).toBe('Plus 及以上');
  expect(guide.querySelector('h2 + span strong')?.textContent).toBe('Plus');
  expect(actions(guide)).toEqual(['立即登录']);
  expect(guide.querySelector('p')?.textContent).toBe('GPT image 2.0｜Nano banana 2｜Seedream5.0｜Seedream5.5');
  expect([...guide.querySelectorAll('p [data-brand="true"]')].map(icon => icon.getAttribute('data-provider')))
    .toEqual(['openai', 'nano-banana', 'bytedance', 'bytedance']);
  expect(guide.querySelector('ul, .om-account-offer')).toBeNull();
  expect(page.querySelectorAll('.om-account-metrics .om-card')).toHaveLength(section === 'subscription' ? 2 : 0);
  expect(page.querySelector('[data-guide="upgrade"]')).toBeNull();
});

it('starts login from the signed-out subscription offer and switches to upgrade after Free sign-in', async () => {
  const page = await open({ state: 'signed-out' }, 'en', 'subscription');
  const guide = page.querySelector<HTMLElement>('[data-guide="sign-in"]')!;
  expect(guide.querySelector('h2')?.textContent).toBe('Sign in for 7 days of unlimited use on select models');
  expect(guide.querySelector('h2 + span')?.textContent).toBe('Plus and above');
  expect(guide.querySelector('ul, .om-account-offer')).toBeNull();
  expect(actions(guide)).toEqual(['Sign in now']);
  expect(page.querySelectorAll('.om-account-metrics .om-card')).toHaveLength(2);

  hooks.account = { state: 'authorizing', authorizationUrl: activation };
  await act(async () => button(guide, 'Sign in now')!.click());
  expect(hooks.request).toHaveBeenCalledWith('settings/account/login', 'POST', { hookId: 'settings_signin', entryId: expect.stringMatching(uuid) });
  expect(page.querySelector('[data-guide]')).toBeNull();
  expect(button(page, 'Cancel')).toBeTruthy();

  hooks.account = { state: 'signed-in', plan: 'free' };
  await act(async () => window.dispatchEvent(new Event('motion:account-changed')));
  const upgrade = page.querySelector<HTMLElement>('[data-guide="upgrade"]')!;
  expect(upgrade.className).toBe(guide.className);
  expect(upgrade.querySelector('ul')?.getAttribute('aria-label')).toBe('Subscription offers');
  expect(actions(upgrade)).toEqual(['Upgrade to Plus']);
});

it.each(['account', 'subscription'] as const)('shows the localized seven-day upgrade offer on the %s page', async section => {
  const page = await open({ state: 'signed-in', plan: 'free' }, 'zh-CN', section);
  const guide = page.querySelector<HTMLElement>('[data-guide="upgrade"]')!;
  expect(guide.querySelector('h2')?.textContent).toBe('精选模型7天无限用');
  expect(guide.querySelector('h2 span')?.textContent).toBe('7天无限用');
  expect(actions(guide)).toEqual(['立即升级']);
});

it('offers Free and Go accounts an upgrade through the registered entry source, and nothing to paid plans', async () => {
  for (const plan of ['free', 'go']) {
    const page = await open({ state: 'signed-in', user: { email: 'ada@example.test' }, plan, balance: '0.00' }, 'en', 'subscription');
    const guide = page.querySelector<HTMLElement>('[data-guide="upgrade"]')!;
    expect(guide.querySelector('h2')?.textContent).toBe('7 days of unlimited use on select models');
    expect(guide.querySelector('p')?.textContent).toBe('GPT image 2.0｜Nano banana 2｜Seedream5.0｜Seedream5.5');
    const modelIcons = guide.querySelectorAll('p [data-brand="true"]');
    expect([...modelIcons].map(icon => icon.getAttribute('data-provider'))).toEqual(['openai', 'nano-banana', 'bytedance', 'bytedance']);
    expect(guide.textContent).not.toContain('Current plan');
    expect(page.querySelector('.om-plan-usage h2')?.textContent).toBe(plan === 'free' ? 'Free plan' : 'Go');
    expect(actions(guide)).toEqual(['Upgrade to Plus']);
    expect([...guide.querySelectorAll('li')].map(item => item.textContent)).toEqual([
      'Go Max annual from $100/mo', 'Claude / GPT up to 20% off',
    ]);
    expect([...page.querySelectorAll('.om-plan-usage button')].map(item => item.textContent)).toEqual(['Go to console', 'Top up']);
    expect(page.querySelector('.om-account-summary')).toBeNull();
  }
  const paid = await open({ state: 'signed-in', user: { email: 'ada@example.test' }, plan: 'plus', balance: '12.00' }, 'en', 'subscription');
  expect(paid.querySelector('[data-guide="upgrade"]')).toBeNull();
});
