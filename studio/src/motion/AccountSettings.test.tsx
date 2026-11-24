// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider, type Locale } from '../i18n/I18n';
import { AccountSettings, type CloudAccountSummary, type PersonalAccessTokenRecord } from './AccountSettings';

const hooks = vi.hoisted(() => ({
  summary: undefined as unknown,
  tokens: [] as PersonalAccessTokenRecord[],
  request: vi.fn(),
}));
vi.mock('./gatewayClient', () => ({ gatewayRequest: hooks.request }));
vi.mock('./useProviderDirectory', () => ({ notifyProvidersChanged: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open(
  account: Partial<CloudAccountSummary> & Record<string, unknown>,
  locale: Locale = 'en',
  section: 'account' | 'subscription' = 'account',
  tokens: PersonalAccessTokenRecord[] = [],
) {
  hooks.summary = { consoleUrl: 'https://open-design.ai/cloud', ...account };
  hooks.tokens = tokens;
  hooks.request.mockImplementation(async (path: string, method = 'GET', body?: Record<string, unknown>) => {
    if (path.startsWith('account/summary')) return hooks.summary;
    if (path === 'connections' && method === 'GET') return { connections: [] };
    if (path === 'tokens' && method === 'GET') return { tokens: hooks.tokens };
    if (path === 'tokens' && method === 'POST') {
      const created: PersonalAccessTokenRecord = {
        id: 'pat-new',
        name: String(body?.name ?? 'CI'),
        tokenPrefix: 'om_pat_abcd',
        scopes: ['projects:read', 'projects:write', 'assets:read', 'assets:write', 'exports:write', 'media:generate', 'mcp:tools'],
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: '2026-11-20T00:00:00.000Z',
      };
      hooks.tokens = [created, ...hooks.tokens];
      // Matches flat CreatedPatResult returned by POST /motion-api/tokens (src/auth/pat.ts)
      return {
        id: created.id,
        name: created.name,
        tokenPrefix: created.tokenPrefix,
        token: 'om_pat_abcd_secret_once',
        scopes: created.scopes,
        expiresAt: created.expiresAt,
        createdAt: created.createdAt,
      };
    }
    if (path.startsWith('tokens/') && method === 'DELETE') {
      const id = path.slice('tokens/'.length);
      hooks.tokens = hooks.tokens.filter(item => item.id !== id);
      return { ok: true, id };
    }
    if (path === 'account/workspaces/switch' && method === 'POST') {
      return { ok: true };
    }
    return hooks.summary;
  });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<I18nProvider initialLocale={locale}><AccountSettings subscription={section === 'subscription'} openProviders={() => {}} /></I18nProvider>));
  return container;
}

const findButton = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label);

it('shows Local Dev Mode banner when AUTH_MODE=dev and hides OIDC sign-out', async () => {
  const page = await open({
    authenticated: true,
    authMode: 'dev',
    authMethod: 'dev_bypass',
    user: { id: 'u1', email: 'dev@localhost', displayName: 'Local Developer' },
    activeWorkspace: { id: 'ws-dev', slug: 'default', name: 'Local Workspace', role: 'owner' },
    workspaces: [{ id: 'ws-dev', slug: 'default', name: 'Local Workspace', role: 'owner' }],
  });
  expect(page.querySelector('[data-dev-mode="true"]')?.textContent).toContain('AUTH_MODE=dev');
  expect(page.textContent).toContain('Local Dev Mode');
  expect(findButton(page, 'Sign out')).toBeUndefined();
});

it('switches workspaces and signs out cleanly in OIDC mode', async () => {
  const fetchSpy = vi.fn(async () => {
    hooks.summary = { authenticated: false, authMode: 'oidc', consoleUrl: 'https://open-design.ai/cloud' };
    return Response.json({ ok: true });
  });
  vi.stubGlobal('fetch', fetchSpy);
  const page = await open({
    authenticated: true,
    authMode: 'oidc',
    authMethod: 'session_cookie',
    user: { id: 'u1', email: 'ada@example.test', displayName: 'Ada' },
    activeWorkspace: { id: 'ws-1', slug: 'studio-a', name: 'Studio A', role: 'owner' },
    workspaces: [
      { id: 'ws-1', slug: 'studio-a', name: 'Studio A', role: 'owner' },
      { id: 'ws-2', slug: 'studio-b', name: 'Studio B', role: 'editor' },
    ],
    billing: { plan: 'pro', mediaEntitlement: 'included', balanceUsd: 12 },
  });
  expect(page.textContent).toContain('Studio A');
  expect(page.textContent).toContain('Studio B');
  await act(async () => findButton(page, 'Switch workspace')!.click());
  expect(hooks.request).toHaveBeenCalledWith('account/workspaces/switch', 'POST', { workspaceId: 'ws-2' });
  await act(async () => findButton(page, 'Sign out')!.click());
  expect(fetchSpy).toHaveBeenCalledWith('/auth/logout', expect.objectContaining({ method: 'POST' }));
  expect(page.querySelector('.om-plan-guide')).not.toBeNull();
});

it('creates, copies once, and revokes Personal Access Tokens (PAT)', async () => {
  const copy = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  const page = await open({
    authenticated: true,
    authMode: 'oidc',
    authMethod: 'session_cookie',
    user: { id: 'u1', email: 'ada@example.test', displayName: 'Ada' },
  });
  const input = page.querySelector<HTMLInputElement>('input[aria-label="Token name"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Cursor Laptop');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => page.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  const createCall = hooks.request.mock.calls.find(([p, m]) => p === 'tokens' && m === 'POST');
  expect(createCall?.[2]).toEqual({ name: 'Cursor Laptop', expiresInDays: 90 });
  expect(page.textContent).toContain('media:generate');
  expect(page.textContent).toContain('mcp:tools');
  expect(page.textContent).not.toContain('mcp:read');
  expect(page.querySelector('[data-pat-created="true"]')?.textContent).toContain('om_pat_abcd_secret_once');
  expect(page.querySelector('[data-pat-created="true"]')?.textContent).toContain('Cursor Laptop');
  await act(async () => findButton(page, 'Copy token')!.click());
  expect(copy).toHaveBeenCalledWith('om_pat_abcd_secret_once');
  await act(async () => findButton(page, 'Revoke')!.click());
  expect(hooks.request).toHaveBeenCalledWith('tokens/pat-new', 'DELETE');
});

it('shows the account email once, under the name only when the account has a different one', async () => {
  const identity = async (user: CloudAccountSummary['user']) => {
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
  const page = await open({ state: 'signed-in', user: { email: 'ada@example.test' }, billingUnavailable: true }, 'zh-CN', 'subscription');
  expect(page.textContent).toContain('暂时无法读取订阅和余额。账户模型不受影响，可以照常使用。');
});

it('passes a fresh subscription entry on ordinary and middle clicks without account credentials', async () => {
  const page = await open({ state: 'signed-in', user: { email: 'ada@example.test' }, plan: 'plus', balance: '12.00' });
  const link = [...page.querySelectorAll<HTMLAnchorElement>('a')].find(a => a.textContent?.includes('Manage subscription'))!;
  link.addEventListener('click', event => event.preventDefault());
  link.addEventListener('auxclick', event => event.preventDefault());
  const ids = new Set<string>();
  for (const [type, mouseButton] of [['click', 0], ['click', 0], ['auxclick', 1]] as const) {
    const before = Date.now();
    await act(async () => { link.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: mouseButton })); });
    const prepared = link.href;
    await act(async () => { link.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: mouseButton, detail: 1 })); });
    expect(link.href).toBe(prepared);
    const url = new URL(link.href), params = url.searchParams;
    expect(url.origin + url.pathname).toBe('https://open-design.ai/cloud/dashboard');
    expect([...params.keys()].sort()).toEqual(['billing', 'od_entry_at', 'od_entry_id', 'od_entry_source', 'od_origin']);
    expect(params.get('billing')).toBe('plan');
    expect(params.get('od_origin')).toBe('openmotion');
    expect(params.get('od_entry_source')).toBe('openmotion_manage_subscription');
    expect(params.get('od_entry_id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const at = params.get('od_entry_at')!;
    expect(new Date(at).toISOString()).toBe(at);
    expect(Date.parse(at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(at)).toBeLessThanOrEqual(Date.now());
    ids.add(params.get('od_entry_id')!);
  }
  expect(ids.size).toBe(3);
  await act(async () => { link.click(); });
  expect(ids.has(new URL(link.href).searchParams.get('od_entry_id')!)).toBe(false);
  expect(link.target).toBe('_blank'); expect(link.rel).toBe('noreferrer');
});

it('replaces missing billing metrics with a dashboard link on 403 and restores them on retry', async () => {
  const page = await open({ state: 'signed-in', billingUnavailable: true, billingError: { status: 403 } }, 'zh-CN', 'subscription');
  expect(page.textContent).toContain('账单服务拒绝了本次查询');
  expect(page.querySelector('.om-account-metrics')).toBeNull();
  const url = new URL(page.querySelector('a')!.href);
  expect(url.origin + url.pathname).toBe('https://open-design.ai/cloud/dashboard');
  expect(url.searchParams.get('billing')).toBe('plan');
  expect(url.searchParams.get('od_origin')).toBe('openmotion');
  hooks.summary = { state: 'signed-in', plan: 'pro', balance: '0.00', consoleUrl: 'https://open-design.ai/cloud' };
  await act(async () => page.querySelector<HTMLButtonElement>('button[aria-busy]')!.click());
  expect(page.querySelector('.om-account-metrics')?.textContent).toContain('$0.00');
  expect(page.textContent).not.toContain('账单服务拒绝了本次查询');
});

it.each(['account', 'subscription'] as const)('shows the same sign-in benefits on the %s page', async section => {
  const page = await open({ state: 'signed-out' }, 'zh-CN', section);
  expect(page.querySelector('.om-plan-guide h2')?.textContent).toBe('登录 OpenDesign，开始多模态生成');
  expect(page.querySelector('.om-plan-guide .om-badge')?.textContent).toBe('Plus 及以上');
  expect(page.querySelector('.om-plan-guide .om-button')?.textContent).toBe('使用 OpenDesign 登录');
  expect([...page.querySelectorAll('.om-account-capabilities li')].map(item => item.textContent)).toEqual(['图片', '视频', '配音', '音乐']);
  expect(page.querySelector('[data-guide="upgrade"]')).toBeNull();
});

it('offers Free and Go accounts an upgrade through the registered entry source, and nothing to paid plans', async () => {
  for (const plan of ['free', 'go']) {
    const page = await open({ state: 'signed-in', user: { email: 'ada@example.test' }, plan, balance: '0.00' }, 'en', 'subscription');
    const [upgrade, manage] = page.querySelectorAll<HTMLAnchorElement>('[data-guide="upgrade"] a');
    expect(page.querySelector('.om-plan-name')?.textContent).toBe(plan === 'free' ? 'Free plan' : 'Go');
    expect(new URL(upgrade.href).searchParams.get('od_entry_source')).toBe('openmotion_manage_subscription');
    expect(upgrade.textContent).toContain('Upgrade to Plus');
    expect(new URL(manage.href).searchParams.get('od_entry_source')).toBe('openmotion_manage_subscription');
    expect(page.querySelector('.om-account-summary h2')?.textContent).toBe('Connected to OpenDesign');
  }
  const paid = await open({ state: 'signed-in', user: { email: 'ada@example.test' }, plan: 'plus', balance: '12.00' }, 'en', 'subscription');
  expect(paid.querySelector('[data-guide="upgrade"]')).toBeNull();
  expect(paid.querySelector('[data-desktop-billing-hint="true"]')).toBeNull();
});

it('shows a calm account-verification hint before external billing links in desktop app mode', async () => {
  window.__OPENMOTION_HOST__ = {
    info: async () => ({
      hostKind: 'desktop',
      shellVersion: '0.2.1',
      contractVersion: '1.0',
      platform: 'darwin',
      arch: 'arm64',
      releaseChannel: 'stable',
      isPackaged: true,
    }),
    capabilities: async () => [],
    invoke: async () => ({ ok: true, data: {} }),
    subscribe: () => () => {},
  };
  try {
    const freePage = await open(
      { state: 'signed-in', user: { email: 'ada@example.test' }, plan: 'free', balance: '0.00' },
      'en',
      'subscription',
    );
    const upgradeHint = freePage.querySelector('[data-desktop-billing-hint="true"]');
    expect(upgradeHint).not.toBeNull();
    expect(upgradeHint?.textContent).toContain('ada@example.test');
    expect(upgradeHint?.textContent).toContain('Refresh');

    const paidPage = await open(
      { state: 'signed-in', user: { email: 'ada@example.test' }, plan: 'plus', balance: '12.00' },
      'zh-CN',
      'subscription',
    );
    const paidHint = paidPage.querySelector('[data-desktop-billing-hint="true"]');
    expect(paidHint).not.toBeNull();
    expect(paidHint?.textContent).toContain('ada@example.test');
    expect(paidHint?.textContent).toContain('刷新');
  } finally {
    delete window.__OPENMOTION_HOST__;
  }
});

it('routes upgrade links through /auth/upgrade-handoff with attribution in OIDC web mode and suppresses One Tap on confirmed sign-out', async () => {
  sessionStorage.clear();
  const disableAutoSelect = vi.fn();
  window.google = {
    accounts: {
      id: {
        initialize: vi.fn(),
        prompt: vi.fn(),
        disableAutoSelect,
        cancel: vi.fn(),
      },
    },
  };
  try {
    const page = await open(
      {
        authenticated: true,
        authMode: 'oidc',
        authMethod: 'session_cookie',
        user: { id: 'u1', appUserId: 'usr_app_1', email: 'ada@example.test', displayName: 'Ada' },
        billing: { plan: 'free', mediaEntitlement: 'not-included', balanceUsd: 0 },
      },
      'en',
      'subscription',
    );
    const [upgrade, manage] = page.querySelectorAll<HTMLAnchorElement>('[data-guide="upgrade"] a');
    const upgradeUrl = new URL(upgrade.href);
    expect(upgradeUrl.pathname).toBe('/auth/upgrade-handoff');
    expect(upgradeUrl.searchParams.get('billing')).toBe('plan');
    expect(upgradeUrl.searchParams.get('od_origin')).toBe('openmotion');
    expect(upgradeUrl.searchParams.get('od_entry_source')).toBe('openmotion_manage_subscription');
    expect(upgradeUrl.searchParams.get('od_entry_id')).toBeTruthy();
    expect(upgradeUrl.searchParams.get('od_entry_at')).toBeTruthy();

    const manageUrl = new URL(manage.href);
    expect(manageUrl.pathname).toBe('/auth/upgrade-handoff');
    expect(manageUrl.searchParams.get('od_entry_source')).toBe('openmotion_manage_subscription');

    // Failed logout does NOT write suppression flag
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 500 })));
    await act(async () => findButton(page, 'Sign out')!.click());
    expect(sessionStorage.getItem('od_onetap_suppressed_once')).toBeNull();
    expect(disableAutoSelect).not.toHaveBeenCalled();

    // Confirmed logout writes od_onetap_suppressed_once and calls disableAutoSelect
    vi.stubGlobal('fetch', vi.fn(async () => {
      hooks.summary = { authenticated: false, authMode: 'oidc', consoleUrl: 'https://open-design.ai/cloud' };
      return Response.json({ ok: true });
    }));
    await act(async () => findButton(page, 'Sign out')!.click());
    expect(sessionStorage.getItem('od_onetap_suppressed_once')).toBe('1');
    expect(disableAutoSelect).toHaveBeenCalledTimes(1);
  } finally {
    sessionStorage.clear();
    delete window.google;
  }
});
