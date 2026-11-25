// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18n';
import {
  AUTH_PENDING_DRAFT_KEY,
  AuthRecoveryNotice,
  HOME_DRAFT_STORAGE_KEY,
  classifyAuthHttpError,
  clearAuthPendingDraft,
  consumeAuthCancelledFromUrl,
  markAuthenticatedSession,
  notifyAuthRecovery,
  readAuthPendingDraft,
  readPersistedStudioDrafts,
  saveAuthPendingDraft,
  savePersistedStudioDraft,
} from './authRecovery';
import { WORKSPACE_LOCATION_CHANGED } from '../utils/workspaceHistory';
import { assetRequest } from './assetClient';
import { AssetBrowserContent, useAssetBrowser } from './AssetBrowser';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('authRecovery (A01 / A03)', () => {
  it('classifies 401 auth_required and 503 auth_unavailable distinctly', () => {
    expect(classifyAuthHttpError(401, { code: 'UNAUTHORIZED', errorCode: 'auth_required' })?.kind).toBe('auth_required');
    expect(classifyAuthHttpError(503, { code: 'AUTH_UNAVAILABLE', errorCode: 'auth_unavailable' })?.kind).toBe('auth_unavailable');
    expect(classifyAuthHttpError(500, { code: 'INTERNAL_ERROR' })).toBeNull();
  });

  it('preserves draft & idempotency key on 401 auth_required, keeps draft on cancel, and navigates to /auth/login on sign in', async () => {
    window.localStorage.setItem(HOME_DRAFT_STORAGE_KEY, 'My unsaved prompt');
    const onLoginNavigate = vi.fn();

    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <AuthRecoveryNotice onLoginNavigate={onLoginNavigate} />
        </I18nProvider>,
      );
    });

    const savedDraft = saveAuthPendingDraft({
      action: 'use_template',
      templateId: 'tpl-hero',
      instruction: 'Launch trailer',
      returnTo: '/?templates=1&template=tpl-hero',
    });

    await act(async () => {
      notifyAuthRecovery({
        kind: 'auth_required',
        status: 401,
        message: 'Session expired',
        returnTo: savedDraft.returnTo,
        draft: savedDraft,
      });
    });

    const banner = host.querySelector('[data-kind="auth_required"]');
    expect(banner?.textContent).toContain('Your session has expired');

    // Clicking Sign in again navigates to /auth/login?returnTo=... while keeping draft preserved.
    const signInBtn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Sign in again'))!;
    await act(async () => signInBtn.click());
    expect(onLoginNavigate).toHaveBeenCalledWith(
      `/auth/login?returnTo=${encodeURIComponent('/?templates=1&template=tpl-hero')}`,
    );
    expect(window.localStorage.getItem(HOME_DRAFT_STORAGE_KEY)).toBe('My unsaved prompt');
    expect(readAuthPendingDraft()?.idempotencyKey).toBe(savedDraft.idempotencyKey);

    // Clicking Cancel dismisses the prompt without deleting drafts.
    const cancelBtn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!;
    await act(async () => cancelBtn.click());
    expect(host.querySelector('[data-kind="auth_required"]')).toBeNull();
    expect(window.localStorage.getItem(HOME_DRAFT_STORAGE_KEY)).toBe('My unsaved prompt');
    expect(readAuthPendingDraft()?.templateId).toBe('tpl-hero');
  });

  it('shows non-destructive retry banner on 503 auth_unavailable without prompting re-login', async () => {
    const onRetry = vi.fn();
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <AuthRecoveryNotice onRetry={onRetry} />
        </I18nProvider>,
      );
    });

    await act(async () => {
      notifyAuthRecovery({
        kind: 'auth_unavailable',
        status: 503,
        message: 'AMR unreachable',
      });
    });

    const banner = host.querySelector('[data-kind="auth_unavailable"]');
    expect(banner?.textContent).toContain('Temporarily unable to verify your login status');
    expect(banner?.textContent).not.toContain('Sign in again');

    const retryBtn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    await act(async () => retryBtn.click());
    expect(onRetry).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-kind="auth_unavailable"]')).toBeNull();
  });

  it('restores saved draft after login and resumes once with the exact preserved idempotencyKey', async () => {
    const draft = saveAuthPendingDraft({
      action: 'use_template',
      templateId: 'tpl-123',
      instruction: 'Promo video',
      homeDraftSnapshot: 'Promo video',
    });
    // Simulate localStorage cleared during redirect — restoreHomeDraftIfMissing must recover it.
    window.localStorage.removeItem(HOME_DRAFT_STORAGE_KEY);

    const onResume = vi.fn(async () => true);
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <AuthRecoveryNotice onResumePendingDraft={onResume} />
        </I18nProvider>,
      );
    });

    expect(window.localStorage.getItem(HOME_DRAFT_STORAGE_KEY)).toBe('Promo video');
    const continueBtn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Continue')!;
    await act(async () => continueBtn.click());

    expect(onResume).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: draft.idempotencyKey,
      templateId: 'tpl-123',
      instruction: 'Promo video',
    }));
    expect(window.sessionStorage.getItem(AUTH_PENDING_DRAFT_KEY)).toBeNull();
    clearAuthPendingDraft();
  });

  it('localizes zh-CN recovery banners, distinguishes guest vs expired session, and only mentions drafts when present (OPEND-5650)', async () => {
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="zh-CN">
          <AuthRecoveryNotice />
        </I18nProvider>,
      );
    });

    // 1. Fresh guest without any draft -> localized guest sign-in prompt (no English, no expired session, no draft claim).
    await act(async () => {
      notifyAuthRecovery({
        kind: 'auth_required',
        status: 401,
        message: 'Authentication required',
        sessionExpired: false,
      });
    });
    let banner = host.querySelector('[data-kind="auth_required"]')!;
    expect(banner.getAttribute('data-auth-state')).toBe('guest');
    expect(banner.textContent).toContain('请先使用 OpenDesign 登录以继续。');
    expect(banner.textContent).not.toContain('Your session has expired');
    expect(banner.textContent).not.toContain('草稿');
    expect(banner.textContent).toContain('使用 OpenDesign 登录');

    // 2. Fresh guest WITH a preserved studio draft -> mentions preserved input in Chinese.
    savePersistedStudioDraft('design/text-to-image', { modality: 'image', prompt: 'sunset neon skyline', references: [] });
    await act(async () => {
      notifyAuthRecovery({
        kind: 'auth_required',
        status: 401,
        message: 'Authentication required',
        sessionExpired: false,
      });
    });
    banner = host.querySelector('[data-kind="auth_required"]')!;
    expect(banner.textContent).toContain('请先使用 OpenDesign 登录以继续，你输入的内容已保留。');

    // 3. Real session expiration WITHOUT draft -> localized expired prompt without claiming a draft exists.
    window.sessionStorage.clear();
    markAuthenticatedSession(true);
    const classifiedExpired = classifyAuthHttpError(401, {
      code: 'UNAUTHORIZED',
      errorCode: 'auth_required',
      sessionExpired: true,
      error: 'Session expired or revoked',
    });
    expect(classifiedExpired?.sessionExpired).toBe(true);
    await act(async () => {
      notifyAuthRecovery(classifiedExpired!);
    });
    banner = host.querySelector('[data-kind="auth_required"]')!;
    expect(banner.getAttribute('data-auth-state')).toBe('expired');
    expect(banner.textContent).toContain('登录状态已过期，请重新登录后继续。');
    expect(banner.textContent).not.toContain('草稿');
    expect(banner.textContent).toContain('重新登录');

    // 4. Navigating to another workspace page clears the banner so it never leaks onto Templates.
    await act(async () => {
      window.dispatchEvent(new Event(WORKSPACE_LOCATION_CHANGED));
    });
    expect(host.querySelector('[data-kind="auth_required"]')).toBeNull();
  });

  it('strips auth_cancelled=1, keeps studio drafts intact, and suppresses autoResume on cancel (OPEND-5647)', () => {
    window.history.replaceState(null, '', '/create/image?tab=draft&auth_cancelled=1');
    savePersistedStudioDraft('design/text-to-image', { modality: 'image', prompt: 'cyberpunk portrait', references: [] });
    saveAuthPendingDraft({
      action: 'use_template',
      templateId: 'custom-agents',
      returnTo: '/explore?template=custom-agents',
      autoResume: true,
    });

    expect(consumeAuthCancelledFromUrl()).toBe(true);
    expect(window.location.search).toBe('?tab=draft');
    expect(readAuthPendingDraft()).toBeNull();
    expect(readPersistedStudioDrafts<{ prompt: string }>()['design/text-to-image']?.prompt).toBe('cyberpunk portrait');
  });

  it('renders localized Chinese guest sign-in guide in AssetBrowser on 401 without firing global auth recovery banner (OPEND-5650)', async () => {
    const recoveryEvents: Event[] = [];
    const listener = (event: Event) => recoveryEvents.push(event);
    window.addEventListener('motion:auth-recovery', listener);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ code: 'UNAUTHORIZED', errorCode: 'auth_required', sessionExpired: false, error: 'Authentication required' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    function Harness() {
      const browser = useAssetBrowser({ kind: 'all', active: true });
      return <AssetBrowserContent browser={browser} onOpen={() => {}} />;
    }

    try {
      await act(async () => {
        root.render(
          <I18nProvider initialLocale="zh-CN">
            <Harness />
          </I18nProvider>,
        );
      });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });

      const guide = host.querySelector('[data-guest-auth-guide="true"]');
      expect(guide).not.toBeNull();
      expect(guide?.textContent).toContain('登录后查看你的资产');
      expect(guide?.textContent).toContain('使用 OpenDesign 登录');
      expect(host.textContent).not.toContain('无法加载资产');
      expect(recoveryEvents).toHaveLength(0);

      // Direct read-only jobs call also suppresses the global recovery banner.
      await expect(assetRequest({ action: 'jobs' })).rejects.toThrow();
      expect(recoveryEvents).toHaveLength(0);
    } finally {
      window.removeEventListener('motion:auth-recovery', listener);
    }
  });
});
