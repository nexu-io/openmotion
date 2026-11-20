// @vitest-environment happy-dom
import React, { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanupMounted, mountHost } from '../components/ui/mountHost.testHelpers';
import type { AccountSummary } from '../../../shared/provider-directory';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../i18n/I18n';
import { ApplicationAccountMenu } from './ApplicationChrome';
import { SettingsCenter } from './SettingsCenter';

const accountState = vi.hoisted(() => ({ account: null as AccountSummary | null, refresh: vi.fn() }));
vi.mock('./WorkspaceFrame', () => ({ useWorkspaceChrome: () => ({ openHome: vi.fn(), openLibrary: vi.fn(), switchingDisabled: false, navigationCollapsed: false }) }));
vi.mock('./AccountSettings', () => ({ useAccountSummary: () => ({ account: accountState.account, refresh: accountState.refresh }), AccountSettings: () => null }));
vi.mock('./ModelSwitcher', () => ({ ModelSwitcher: () => null }));
vi.mock('./GitHubLink', () => ({ GitHubLink: () => null }));
vi.mock('./gatewayClient', () => ({ gatewayRequest: vi.fn(async () => ({ version: 'test' })) }));

beforeEach(() => { localStorage.clear(); accountState.account = null; accountState.refresh.mockClear(); });
afterEach(cleanupMounted);
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const click = async (element: Element | null) => { expect(element).not.toBeNull(); act(() => (element as HTMLElement).click()); await settle(); };

it('switches the shared locale from the account submenu and keeps settings in sync', async () => {
  mountHost(<I18nProvider initialLocale="en"><ApplicationAccountMenu settings="general" openSettings={() => {}} /><SettingsCenter section="general" onSection={() => {}} openConnections={() => {}} /></I18nProvider>);
  await click(document.querySelector('[aria-label="Account menu"]'));
  const language = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Language'))!;
  act(() => { language.focus(); language.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
  await settle();
  expect(document.querySelector('[role="menu"][aria-label="Language"]')).not.toBeNull();
  await click([...document.querySelectorAll('[role="menuitemradio"]')].find(item => item.textContent === '简体中文')!);
  expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN');
  expect(document.documentElement.lang).toBe('zh-CN');
  expect(document.querySelector('.om-preference-control')?.textContent).toContain('简体中文');
  expect(document.querySelector('.om-settings-main')?.getAttribute('aria-label')).toBe('通用');
  await click(document.querySelector('[aria-label="账户菜单"]'));
  const translatedLanguage = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('语言'))!;
  await click(translatedLanguage);
  expect(document.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent).toBe('简体中文');
});

it('uses the same direct GitHub destinations in the account menu and settings resources', async () => {
  mountHost(<I18nProvider initialLocale="en"><ApplicationAccountMenu settings="help" openSettings={() => {}} /><SettingsCenter section="help" onSection={() => {}} openConnections={() => {}} /></I18nProvider>);
  await settle();
  await click(document.querySelector('[aria-label="Account menu"]'));
  for (const [label, href] of [["What's new", 'https://github.com/nexu-io/openmotion/releases'], ['Feedback', 'https://github.com/nexu-io/openmotion/issues/new/choose']]) {
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a')].filter(link => link.textContent === label);
    expect(links).toHaveLength(2);
    expect(links.every(link => link.href === href && link.target === '_blank' && link.rel.includes('noopener'))).toBe(true);
    expect(links.some(link => link.getAttribute('role') === 'menuitem')).toBe(true);
    expect(links.some(link => link.closest('.om-settings-main'))).toBe(true);
  }
});

it('shows signed-out, expired, authorizing and signed-in states in the header and account menu', async () => {
  const openSettings = vi.fn();
  const base = { consoleUrl: 'https://open-design.ai/cloud' };

  accountState.account = { ...base, state: 'signed-out' };
  mountHost(<I18nProvider initialLocale="en"><ApplicationAccountMenu settings={null} openSettings={openSettings} /></I18nProvider>);
  const pill = document.querySelector<HTMLButtonElement>('.om-account-status-pill')!;
  expect(pill.textContent).toBe('Not signed in');
  await click(pill);
  expect(openSettings).toHaveBeenCalledWith('account');
  openSettings.mockClear();
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Account menu"]')!;
  expect(trigger.dataset.accountState).toBe('signed-out');
  expect(trigger.querySelector('.om-account-trigger-dot')).not.toBeNull();
  await click(trigger);
  expect(accountState.refresh).toHaveBeenCalledTimes(1);
  let banner = document.querySelector<HTMLElement>('.om-account-menu .om-account-menu-banner')!;
  expect(banner.querySelector('.om-account-menu-banner-head strong')?.textContent).toBe('Account');
  expect(banner.querySelector('.om-badge')?.textContent).toBe('Not signed in');
  expect(banner.querySelector('.om-badge')?.getAttribute('data-status')).toBe('warning');
  let cta = banner.querySelector<HTMLElement>('[role="menuitem"].om-account-menu-cta')!;
  expect(cta.textContent).toBe('Sign in with OpenDesign');
  await click(cta);
  expect(openSettings).toHaveBeenCalledWith('account');
  cleanupMounted();

  accountState.account = { ...base, state: 'signed-out' };
  mountHost(<I18nProvider initialLocale="zh-CN"><ApplicationAccountMenu settings={null} openSettings={openSettings} /></I18nProvider>);
  expect(document.querySelector('.om-account-status-pill')?.textContent).toBe('未登录');
  await click(document.querySelector('[aria-label="账户菜单"]'));
  banner = document.querySelector<HTMLElement>('.om-account-menu .om-account-menu-banner')!;
  expect(banner.querySelector('.om-account-menu-banner-head strong')?.textContent).toBe('账户');
  expect(banner.querySelector('.om-badge')?.textContent).toBe('未登录');
  expect(banner.querySelector('.om-account-menu-cta')?.textContent).toBe('使用 OpenDesign 登录');
  cleanupMounted();

  accountState.account = { ...base, state: 'reauth-required', user: { name: 'Ada', email: 'ada@example.test' } };
  mountHost(<I18nProvider initialLocale="en"><ApplicationAccountMenu settings={null} openSettings={openSettings} /></I18nProvider>);
  expect(document.querySelector('.om-account-status-pill')?.textContent).toBe('Sign-in expired');
  const expiredTrigger = document.querySelector<HTMLButtonElement>('[aria-label="Account menu"]')!;
  expect(expiredTrigger.dataset.accountState).toBe('reauth-required');
  expect(expiredTrigger.querySelector('.om-account-trigger-dot')).not.toBeNull();
  await click(expiredTrigger);
  banner = document.querySelector<HTMLElement>('.om-account-menu .om-account-menu-banner')!;
  expect(banner.querySelector('.om-account-menu-banner-head strong')?.textContent).toBe('Ada');
  expect(banner.querySelector('.om-badge')?.textContent).toBe('Sign-in expired');
  expect(banner.querySelector('.om-badge')?.getAttribute('data-status')).toBe('warning');
  cta = banner.querySelector<HTMLElement>('.om-account-menu-cta')!;
  expect(cta.textContent).toBe('Sign in again');
  cleanupMounted();

  accountState.account = { ...base, state: 'authorizing' };
  mountHost(<I18nProvider initialLocale="en"><ApplicationAccountMenu settings={null} openSettings={openSettings} /></I18nProvider>);
  expect(document.querySelector('.om-account-status-pill')).toBeNull();
  await click(document.querySelector('[aria-label="Account menu"]'));
  let accountItem = document.querySelector<HTMLElement>('.om-account-menu [role="menuitem"]')!;
  expect(accountItem.querySelector('.om-account-menu-status')?.textContent).toBe('Signing in…');
  expect(document.querySelector('.om-account-menu-banner')).toBeNull();
  cleanupMounted();

  accountState.account = { ...base, state: 'signed-in', user: { name: 'Ada', email: 'ada@example.test' } };
  mountHost(<I18nProvider initialLocale="en"><ApplicationAccountMenu settings={null} openSettings={openSettings} /></I18nProvider>);
  expect(document.querySelector('.om-account-status-pill')).toBeNull();
  const signedInTrigger = document.querySelector<HTMLButtonElement>('[aria-label="Account menu"]')!;
  expect(signedInTrigger.dataset.accountState).toBe('signed-in');
  expect(signedInTrigger.querySelector('.om-avatar')?.textContent).toBe('A');
  await click(signedInTrigger);
  accountItem = document.querySelector<HTMLElement>('.om-account-menu [role="menuitem"]')!;
  expect(accountItem.querySelector('strong')?.textContent).toBe('Ada');
  expect(accountItem.querySelector('.om-account-menu-status')?.textContent).toBe('ada@example.test');
  expect(document.querySelector('.om-account-menu-banner')).toBeNull();
  cleanupMounted();

  accountState.account = { ...base, state: 'signed-in', user: { email: 'ada@example.test' } };
  mountHost(<I18nProvider initialLocale="zh-CN"><ApplicationAccountMenu settings={null} openSettings={openSettings} /></I18nProvider>);
  await click(document.querySelector('[aria-label="账户菜单"]'));
  accountItem = document.querySelector<HTMLElement>('.om-account-menu [role="menuitem"]')!;
  expect(accountItem.querySelector('strong')?.textContent).toBe('ada@example.test');
  expect(accountItem.querySelector('.om-account-menu-status')?.textContent).toBe('已登录');
});
