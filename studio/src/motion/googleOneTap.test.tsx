// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validPending, validProperties } from '../../../tracking/core.ts';
import { studioEvents } from '../../../tracking/events.ts';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { useToast } from '../hooks/useToast';
import { I18nProvider } from '../i18n/I18n';
import {
  collectOneTapAttribution,
  GOOGLE_GIS_LOAD_TIMEOUT_MS,
  GOOGLE_GIS_SCRIPT_URL,
  MOTION_ONETAP_DELAY_MS,
  MotionGoogleOneTap,
  ONETAP_ANCHOR_ID,
  ONETAP_ATTRIBUTION_STORAGE_ENTRY,
  ONETAP_SUPPRESSED_ONCE_KEY,
  ONETAP_SYNC_STORAGE_KEY,
  persistOneTapLandingAttribution,
  resetOneTapStateForTests,
  retryMotionOneTap,
  suppressOneTapAfterConfirmedLogout,
  type GoogleAccountsIdInitializeConfig,
  type GooglePromptMomentNotification,
} from './googleOneTap';
import { getMotionTrackingUserId, setMotionTrackingUserId } from './tracking';
import { setMotionTrackingConsented } from './trackingIdentity';
import { WorkspaceGoogleOneTap } from './WorkspaceFrame';

const tracked: Array<{ event: string; properties: Record<string, unknown> }> = [];
vi.mock('./tracking', async importOriginal => {
  const actual = await importOriginal<typeof import('./tracking')>();
  return {
    ...actual,
    trackMotion: vi.fn(async (event: string, properties: Record<string, unknown>) => {
      tracked.push({ event, properties });
      return 'queued';
    }),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  tracked.length = 0;
  resetOneTapStateForTests();
  setMotionTrackingUserId(null);
  setMotionTrackingConsented(false);
  sessionStorage.clear();
  localStorage.clear();
  document.cookie = 'od_attr=; max-age=0; path=/';
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  delete window.google;
  delete window.__OPENMOTION_HOST__;
  setViewportWidth(1280);
  history.replaceState(null, '', '/templates?ref=INVITE1&utm_source=twitter&utm_campaign=opengame');
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  resetOneTapStateForTests();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.google;
  delete window.__OPENMOTION_HOST__;
});

function mountOneTap(props: Partial<Parameters<typeof MotionGoogleOneTap>[0]> = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const fullProps: Parameters<typeof MotionGoogleOneTap>[0] = {
    account: { state: 'signed-out', consoleUrl: 'https://open-design.ai/cloud', authMode: 'oidc' },
    accountError: false,
    bfBannerVisible: false,
    refreshAccount: vi.fn(async () => {}),
    ...props,
  };
  act(() => {
    root!.render(<MotionGoogleOneTap {...fullProps} />);
  });
  return { container, props: fullProps };
}

it('skips Google One Tap completely inside the Electron desktop app', async () => {
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
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);

  mountOneTap();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MOTION_ONETAP_DELAY_MS + 1000);
  });

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(document.querySelector(`script[src="${GOOGLE_GIS_SCRIPT_URL}"]`)).toBeNull();
  expect(document.getElementById(ONETAP_ANCHOR_ID)).toBeNull();
});

it('delays 2000ms, loads fixed GIS URL, positions desktop anchor for Black Friday banner, and completes in-place login', async () => {
  expect(MOTION_ONETAP_DELAY_MS).toBe(2000);
  let initConfig: GoogleAccountsIdInitializeConfig | null = null;
  let promptListener: ((n: GooglePromptMomentNotification) => void) | undefined;

  const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/auth/one-tap/challenge') {
      return Response.json({
        challengeId: 'otc_web_1',
        nonce: 'nonce_web_1',
        clientId: 'gid-client-1',
        expiresAt: '2026-11-24T12:00:00.000Z',
      });
    }
    if (url === '/auth/one-tap') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.challengeId).toBe('otc_web_1');
      expect(body.idToken).toBe('jwt_google_token');
      expect(body.referralCode).toBe('INVITE1');
      expect(body.attribution).toMatchObject({
        utmSource: 'twitter',
        utmCampaign: 'opengame',
        landingPath: '/templates',
      });
      return Response.json({
        authenticated: true,
        user: {
          id: 'om_u1',
          appUserId: 'usr_app_999',
          email: 'ada@example.com',
          displayName: 'Ada',
        },
        activeWorkspaceId: 'ws_1',
        isNewUser: true,
        planTier: 'free',
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchSpy);

  const refreshAccount = vi.fn(async () => {});
  const accountChanged = vi.fn();
  window.addEventListener('motion:account-changed', accountChanged);

  const { container } = mountOneTap({ bfBannerVisible: true, refreshAccount });

  // Before 2500ms delay -> no challenge call yet
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MOTION_ONETAP_DELAY_MS - 1);
  });
  expect(fetchSpy).not.toHaveBeenCalled();

  // Trigger at 2500ms -> challenge fetched + GIS script appended with exact constant URL
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(fetchSpy).toHaveBeenCalledWith('/auth/one-tap/challenge', expect.objectContaining({ method: 'POST' }));

  const scriptEl = document.querySelector<HTMLScriptElement>(`script[src="${GOOGLE_GIS_SCRIPT_URL}"]`);
  expect(scriptEl).not.toBeNull();

  // Simulate GIS script loaded
  window.google = {
    accounts: {
      id: {
        initialize: vi.fn((cfg: GoogleAccountsIdInitializeConfig) => {
          initConfig = cfg;
        }),
        prompt: vi.fn(listener => {
          promptListener = listener;
        }),
        disableAutoSelect: vi.fn(),
        cancel: vi.fn(),
      },
    },
  };

  await act(async () => {
    scriptEl!.dispatchEvent(new Event('load'));
    await Promise.resolve();
    await Promise.resolve();
  });

  // Desktop anchor exists at top: 112px when Black Friday banner is visible
  const anchor = document.getElementById(ONETAP_ANCHOR_ID)!;
  expect(anchor).not.toBeNull();
  expect(anchor.style.right).toBe('16px');
  expect(anchor.style.top).toBe('112px');

  // Re-render with Black Friday banner hidden -> anchor shifts to 64px
  act(() => {
    root!.render(
      <MotionGoogleOneTap
        account={{ state: 'signed-out', consoleUrl: 'https://open-design.ai/cloud', authMode: 'oidc' }}
        accountError={false}
        bfBannerVisible={false}
        refreshAccount={refreshAccount}
      />,
    );
  });
  expect(anchor.style.top).toBe('64px');

  // Verify GIS init config contract
  expect(initConfig).not.toBeNull();
  expect(initConfig!.client_id).toBe('gid-client-1');
  expect(initConfig!.nonce).toBe('nonce_web_1');
  expect(initConfig!.auto_select).toBe(false);
  expect(initConfig!.cancel_on_tap_outside).toBe(false);
  expect(initConfig!.prompt_parent_id).toBe(ONETAP_ANCHOR_ID);
  expect('use_fedcm_for_prompt' in (initConfig as object)).toBe(false);

  // Trigger FedCM-compatible moment notification (no reason -> 'unknown')
  promptListener?.({ isDismissedMoment: () => true });

  // Trigger GIS credential callback -> POST /auth/one-tap -> refreshes account/summary + dispatches motion:account-changed
  await act(async () => {
    initConfig!.callback({ credential: 'jwt_google_token', select_by: 'user' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(getMotionTrackingUserId()).toBe('usr_app_999');
  expect(refreshAccount).toHaveBeenCalledTimes(1);
  expect(accountChanged).toHaveBeenCalledTimes(1);
  expect(document.getElementById(ONETAP_ANCHOR_ID)).toBeNull();

  // Verify every emitted event passes tracking registry validation
  const eventNames = tracked.map(item => item.event);
  expect(eventNames).toEqual([
    'onetap_prompt_attempt',
    'onetap_prompt_observed',
    'onetap_credential_received',
    'onetap_login_success',
  ]);
  for (const row of tracked) {
    expect(
      validProperties(studioEvents, row.event as keyof typeof studioEvents, row.properties),
      JSON.stringify(row),
    ).toBe(true);
    expect(
      validPending(studioEvents, {
        event: row.event,
        event_id: crypto.randomUUID(),
        occurred_at: new Date().toISOString(),
        entrypoint: 'studio',
        device_timezone: 'UTC',
        utc_offset_minutes: 0,
        properties: row.properties,
        app_user_id: 'usr_app_999',
      }),
    ).toBe(true);
  }
  expect(tracked[1].properties).toMatchObject({ outcome: 'dismissed', reason: 'unknown' });
  expect(tracked[3].properties).toMatchObject({
    surface: 'motion_web',
    is_new_user: true,
    plan_tier: 'free',
    post_login_action: 'in_place',
    ref: 'INVITE1',
    utm_source: 'twitter',
    utm_campaign: 'opengame',
  });

  window.removeEventListener('motion:account-changed', accountChanged);
  expect(container).toBeTruthy();
});

it('omits prompt_parent_id on mobile viewports (< 768px) and reports script_load_failed on 5000ms timeout', async () => {
  setViewportWidth(390);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        challengeId: 'otc_mob',
        nonce: 'nonce_mob',
        clientId: 'gid-mob',
        expiresAt: '2026-11-24T12:00:00.000Z',
      }),
    ),
  );

  mountOneTap();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MOTION_ONETAP_DELAY_MS);
    await Promise.resolve();
    await Promise.resolve();
  });

  // Never dispatch 'load' on script -> still waiting at 4999ms, times out at 5000ms
  await act(async () => {
    await vi.advanceTimersByTimeAsync(GOOGLE_GIS_LOAD_TIMEOUT_MS - 1);
    await Promise.resolve();
  });
  expect(tracked).toHaveLength(0);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
  });

  expect(document.getElementById(ONETAP_ANCHOR_ID)).toBeNull();
  expect(tracked).toHaveLength(1);
  expect(tracked[0].event).toBe('onetap_prompt_observed');
  expect(tracked[0].properties).toMatchObject({
    surface: 'motion_web',
    outcome: 'script_load_failed',
    reason: 'script_load_failed',
  });
});

it('suppresses once after confirmed logout, cancels queued prompts, and discards late GIS callbacks', async () => {
  let capturedInit: GoogleAccountsIdInitializeConfig | null = null;
  const disableAutoSelect = vi.fn();
  const cancel = vi.fn();
  window.google = {
    accounts: {
      id: {
        initialize: vi.fn(cfg => {
          capturedInit = cfg;
        }),
        prompt: vi.fn(),
        disableAutoSelect,
        cancel,
      },
    },
  };

  const fetchSpy = vi.fn(async (url: string) => {
    if (url === '/auth/one-tap/challenge') {
      return Response.json({
        challengeId: 'otc_late',
        nonce: 'nonce_late',
        clientId: 'gid-late',
        expiresAt: '2026-11-24T12:00:00.000Z',
      });
    }
    throw new Error(`Should not exchange after logout: ${url}`);
  });
  vi.stubGlobal('fetch', fetchSpy);

  mountOneTap();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MOTION_ONETAP_DELAY_MS);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(capturedInit).not.toBeNull();

  // Confirmed logout fires before a late GIS credential callback arrives
  suppressOneTapAfterConfirmedLogout();
  expect(sessionStorage.getItem(ONETAP_SUPPRESSED_ONCE_KEY)).toBe('1');
  expect(disableAutoSelect).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);

  // Late GIS callback must be silently discarded (never calls POST /auth/one-tap)
  await act(async () => {
    capturedInit!.callback({ credential: 'stale_late_jwt', select_by: 'user' });
    await Promise.resolve();
  });
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  // First remount consumes od_onetap_suppressed_once without prompting
  act(() => root!.unmount());
  tracked.length = 0;
  mountOneTap();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MOTION_ONETAP_DELAY_MS + 100);
  });
  expect(sessionStorage.getItem(ONETAP_SUPPRESSED_ONCE_KEY)).toBeNull();
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(tracked.map(e => e.event)).toEqual(['onetap_prompt_attempt', 'onetap_prompt_observed']);
  expect(tracked[0].properties.suppressed).toBe(true);
  expect(tracked[1].properties).toMatchObject({
    outcome: 'suppressed_after_logout',
    reason: 'suppressed_after_logout',
  });

  // Subsequent mount (manual refresh) resumes prompting normally
  act(() => root!.unmount());
  mountOneTap();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MOTION_ONETAP_DELAY_MS);
    await Promise.resolve();
  });
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

it('reports onetap_login_failed and invokes onError without clearing drafts when backend rejects login', async () => {
  let capturedInit: GoogleAccountsIdInitializeConfig | null = null;
  window.google = {
    accounts: {
      id: {
        initialize: vi.fn(cfg => {
          capturedInit = cfg;
        }),
        prompt: vi.fn(),
      },
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/auth/one-tap/challenge') {
        return Response.json({
          challengeId: 'otc_ban',
          nonce: 'nonce_ban',
          clientId: 'gid-ban',
          expiresAt: '2026-11-24T12:00:00.000Z',
        });
      }
      return Response.json({ code: 'ACCOUNT_BANNED', message: 'Your account is suspended.' }, { status: 403 });
    }),
  );

  const onError = vi.fn();
  mountOneTap({ onError });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MOTION_ONETAP_DELAY_MS);
    await Promise.resolve();
    await Promise.resolve();
  });

  await act(async () => {
    capturedInit!.callback({ credential: 'banned_jwt', select_by: 'user' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(onError).toHaveBeenCalledWith('Your account is suspended.', 'ACCOUNT_BANNED');
  const failed = tracked.find(item => item.event === 'onetap_login_failed');
  expect(failed?.properties).toMatchObject({
    surface: 'motion_web',
    error_code: 'ACCOUNT_BANNED',
  });
  expect(validProperties(studioEvents, 'onetap_login_failed', failed!.properties)).toBe(true);
});

it('resolves full od_* product entry attribution by URL -> localStorage -> od_attr priority and enforces consent gate on odDeviceId', () => {
  localStorage.setItem(
    'od_attr',
    JSON.stringify({
      utm_source: 'cookie_src',
      utm_medium: 'od_attr_med',
      od_entry_id: 'entry_attr',
      od_conversion_source: 'pricing_banner',
    }),
  );
  history.replaceState(
    null,
    '',
    '/explore?utm_source=url_src&od_origin=open_design&od_entry_source=openmotion_manage_subscription&od_entry_at=2026-11-24T01:30:00.000Z&od_campaign_id=black_friday_2026&od_placement_id=hero_slot&od_device_id=dev_123',
  );
  persistOneTapLandingAttribution();

  // Navigate to clean page with no query params -> persisted localStorage + od_attr fallback still resolves all fields
  history.replaceState(null, '', '/templates');
  setMotionTrackingConsented(false);
  const unconsented = collectOneTapAttribution();
  expect(unconsented.attribution).toMatchObject({
    utmSource: 'url_src',
    utmMedium: 'od_attr_med',
    landingPath: '/explore',
    odEntry: {
      sourceProduct: 'open_design',
      entryId: 'entry_attr',
      sourceDetail: 'openmotion_manage_subscription',
      entryOccurredAt: '2026-11-24T01:30:00.000Z',
      campaignId: 'black_friday_2026',
      placementId: 'hero_slot',
      conversionSource: 'pricing_banner',
    },
  });
  expect(unconsented.attribution.odEntry).not.toHaveProperty('odDeviceId');
  const unconsentedStored = localStorage.getItem(ONETAP_ATTRIBUTION_STORAGE_ENTRY);
  expect(unconsentedStored).toBeTruthy();
  expect(unconsentedStored).not.toContain('dev_123');

  // With explicit tracking consent active on landing -> odDeviceId is persisted and transmitted with consent flag
  setMotionTrackingConsented(true);
  history.replaceState(
    null,
    '',
    '/explore?utm_source=url_src&od_origin=open_design&od_entry_source=openmotion_manage_subscription&od_entry_at=2026-11-24T01:30:00.000Z&od_campaign_id=black_friday_2026&od_placement_id=hero_slot&od_device_id=dev_123',
  );
  persistOneTapLandingAttribution();
  history.replaceState(null, '', '/templates');
  const consented = collectOneTapAttribution();
  expect(consented.attribution.odEntry).toMatchObject({
    sourceProduct: 'open_design',
    entryId: 'entry_attr',
    sourceDetail: 'openmotion_manage_subscription',
    entryOccurredAt: '2026-11-24T01:30:00.000Z',
    campaignId: 'black_friday_2026',
    placementId: 'hero_slot',
    conversionSource: 'pricing_banner',
    odDeviceId: 'dev_123',
    odDeviceIdConsent: true,
  });
});

it('consumes cross-origin od_onetap_suppress=1 on first landing, cleans the URL, and resumes prompting after refresh', async () => {
  history.replaceState(null, '', '/templates?od_onetap_suppress=1&utm_source=logout');
  const fetchSpy = vi.fn(async () =>
    Response.json({
      challengeId: 'otc_after_refresh',
      nonce: 'nonce_after_refresh',
      clientId: 'gid-refresh',
      expiresAt: '2026-11-24T12:00:00.000Z',
    }),
  );
  vi.stubGlobal('fetch', fetchSpy);

  // First load: suppressed once and query param stripped cleanly
  mountOneTap();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MOTION_ONETAP_DELAY_MS + 100);
  });
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(window.location.search).toBe('?utm_source=logout');
  expect(tracked.map(e => e.event)).toEqual(['onetap_prompt_attempt', 'onetap_prompt_observed']);
  expect(tracked[1].properties).toMatchObject({
    outcome: 'suppressed_after_logout',
    reason: 'suppressed_after_logout',
  });

  // Subsequent mount (simulated refresh): resumes prompting normally
  act(() => root!.unmount());
  mountOneTap();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MOTION_ONETAP_DELAY_MS);
    await Promise.resolve();
  });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

it('degrades silently on pre-display challenge failure, shows localized failure alert + Go-to-Login CTA on post-click failure, and preserves drafts/filters (ERR-06/07)', async () => {
  let challengeSeq = 0;
  let capturedInit: GoogleAccountsIdInitializeConfig | null = null;
  window.google = {
    accounts: {
      id: {
        initialize: vi.fn(cfg => {
          capturedInit = cfg;
        }),
        prompt: vi.fn(),
        disableAutoSelect: vi.fn(),
        cancel: vi.fn(),
      },
    },
  };

  let exchangeMode: 'invalid' | 'banned' = 'invalid';
  let accountSummaryFetches = 0;
  const fetchSpy = vi.fn(async (url: string) => {
    if (String(url).includes('account/summary')) {
      accountSummaryFetches += 1;
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (url === '/auth/one-tap/challenge') {
      challengeSeq += 1;
      if (challengeSeq === 1) {
        return Response.json(
          { code: 'AUTH_UNAVAILABLE', message: 'One Tap temporarily unavailable' },
          { status: 503 },
        );
      }
      return Response.json({
        challengeId: `otc_ui_retry_${challengeSeq}`,
        nonce: `nonce_ui_retry_${challengeSeq}`,
        clientId: 'gid-ui-retry',
        expiresAt: '2026-11-24T12:00:00.000Z',
      });
    }
    if (url === '/auth/one-tap') {
      if (exchangeMode === 'banned') {
        return Response.json(
          { code: 'ACCOUNT_BANNED', message: 'This account has been banned.' },
          { status: 403 },
        );
      }
      return Response.json(
        { code: 'INVALID_ID_TOKEN', message: 'Invalid Google ID token.' },
        { status: 401 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchSpy);

  const loginNavigations: string[] = [];
  function StudioErrorRecoveryHarness() {
    const toast = useToast();
    const [draft, setDraft] = useState('My unsaved storyboard brief');
    const [filter, setFilter] = useState('cinema');
    return (
      <I18nProvider initialLocale="zh-CN">
        <WorkspaceGoogleOneTap
          bfBannerVisible={false}
          hostChrome={false}
          showToast={toast.showToast}
          dismissToast={toast.dismissToast}
          navigateToLogin={url => loginNavigations.push(url)}
        />
        <StudioToastViewport {...toast} />
        <textarea
          aria-label="Draft brief"
          value={draft}
          onChange={e => setDraft(e.target.value)}
        />
        <select
          aria-label="Category filter"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        >
          <option value="all">All</option>
          <option value="cinema">Cinema</option>
        </select>
      </I18nProvider>
    );
  }

  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(<StudioErrorRecoveryHarness />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(accountSummaryFetches).toBeGreaterThanOrEqual(1);

  // 1. Pre-display challenge 503 MUST degrade silently without rendering any alert (ERR-06)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MOTION_ONETAP_DELAY_MS);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(challengeSeq).toBe(1);
  expect(document.body.querySelector('[role="alert"]')).toBeNull();

  // 2. Trigger fresh prompt and simulate post-click ordinary verification failure -> localized copy + 「去登录」 CTA (ERR-06/07)
  await act(async () => {
    retryMotionOneTap();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(challengeSeq).toBe(2);
  expect(capturedInit).not.toBeNull();

  await act(async () => {
    capturedInit!.callback({ credential: 'jwt_invalid', select_by: 'user' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  const alertEl = document.body.querySelector('[role="alert"]');
  expect(alertEl?.textContent).toContain('登录失败，请重试或选择其他方式登录');
  const goLoginBtn = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    btn => btn.textContent?.includes('去登录'),
  );
  expect(goLoginBtn).toBeTruthy();

  await act(async () => {
    goLoginBtn!.click();
  });
  expect(loginNavigations).toHaveLength(1);
  expect(loginNavigations[0]).toMatch(/^\/auth\/login\?returnTo=/);

  // 3. Post-click ACCOUNT_BANNED -> displays banned copy (ERR-06)
  exchangeMode = 'banned';
  await act(async () => {
    capturedInit!.callback({ credential: 'jwt_banned', select_by: 'user' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
  });
  const bannedAlertText = document.body.querySelector('[role="alert"]')?.textContent ?? '';
  expect(bannedAlertText).toContain('账号已临时停用');
  expect(bannedAlertText).toContain('异常支付风险');
  expect(bannedAlertText).toContain('support@open-design.ai');
  expect(bannedAlertText).toContain('去登录');

  // Draft and filter state stay 100% intact across failures
  expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Draft brief"]')?.value).toBe(
    'My unsaved storyboard brief',
  );
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="Category filter"]')?.value).toBe(
    'cinema',
  );
});

it('restores One Tap eligibility immediately on manual page reload after in-page logout (SHOW-04)', async () => {
  sessionStorage.setItem(ONETAP_SUPPRESSED_ONCE_KEY, '1');
  const getEntriesSpy = vi
    .spyOn(performance, 'getEntriesByType')
    .mockReturnValue([{ type: 'reload' } as PerformanceEntry]);
  window.google = {
    accounts: {
      id: {
        initialize: vi.fn(),
        prompt: vi.fn(),
        disableAutoSelect: vi.fn(),
        cancel: vi.fn(),
      },
    },
  };
  const fetchSpy = vi.fn(async (url: string) => {
    if (url === '/auth/one-tap/challenge') {
      return Response.json({
        challengeId: 'otc_reload_ok',
        nonce: 'nonce_reload_ok',
        clientId: 'gid-reload',
        expiresAt: '2026-11-24T12:00:00.000Z',
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchSpy);

  try {
    mountOneTap();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MOTION_ONETAP_DELAY_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sessionStorage.getItem(ONETAP_SUPPRESSED_ONCE_KEY)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith('/auth/one-tap/challenge', expect.objectContaining({ method: 'POST' }));
  } finally {
    getEntriesSpy.mockRestore();
  }
});

it('parses real od-landing compact od_attr cookie keys (s/m/c/ct/tm/lp) and treats ref as organic referrer without forwarding as referralCode', () => {
  history.replaceState(null, '', '/explore');
  document.cookie = `od_attr=${encodeURIComponent(
    JSON.stringify({ s: 'x_launch', m: 'social', c: 'bf2026', ct: 'hero', tm: 'motion', lp: '/zh/motion/' }),
  )}; path=/`;
  const compact = collectOneTapAttribution();
  expect(compact.attribution.utmSource).toBe('x_launch');
  expect(compact.attribution.utmMedium).toBe('social');
  expect(compact.attribution.utmCampaign).toBe('bf2026');
  expect(compact.attribution.utmContent).toBe('hero');
  expect(compact.attribution.utmTerm).toBe('motion');
  expect(compact.attribution.landingPath).toBe('/zh/motion/');
  expect(compact.referralCode).toBeUndefined();

  // Organic referrer fallback when `s` is absent: `ref` is referrer hostname, NEVER an invite referralCode
  document.cookie = `od_attr=${encodeURIComponent(JSON.stringify({ ref: 'google.com', lp: '/pricing/' }))}; path=/`;
  const organic = collectOneTapAttribution();
  expect(organic.attribution.utmSource).toBe('google.com');
  expect(organic.attribution.utmMedium).toBe('referrer');
  expect(organic.attribution.landingPath).toBe('/pricing/');
  expect(organic.referralCode).toBeUndefined();
});

it('supports cross-tab logout cancellation and in-place retry with a fresh challenge', async () => {
  let challengeSeq = 0;
  let capturedInit: GoogleAccountsIdInitializeConfig | null = null;
  const disableAutoSelect = vi.fn();
  window.google = {
    accounts: {
      id: {
        initialize: vi.fn(cfg => {
          capturedInit = cfg;
        }),
        prompt: vi.fn(),
        disableAutoSelect,
        cancel: vi.fn(),
      },
    },
  };

  let failFirstExchange = true;
  const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/auth/one-tap/challenge') {
      challengeSeq += 1;
      return Response.json({
        challengeId: `otc_retry_${challengeSeq}`,
        nonce: `nonce_retry_${challengeSeq}`,
        clientId: 'gid-retry',
        expiresAt: '2026-11-24T12:00:00.000Z',
      });
    }
    if (url === '/auth/one-tap') {
      const body = JSON.parse(String(init?.body)) as { challengeId: string };
      if (failFirstExchange) {
        failFirstExchange = false;
        return Response.json({ code: 'AUTH_UNAVAILABLE', message: 'Temporary outage' }, { status: 503 });
      }
      expect(body.challengeId).toBe('otc_retry_2');
      return Response.json({
        authenticated: true,
        user: { id: 'om_u2', appUserId: 'usr_app_retry', email: 'retry@example.com', displayName: 'Retry' },
        activeWorkspaceId: 'ws_2',
        isNewUser: false,
        planTier: 'plus',
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchSpy);

  const onError = vi.fn();
  const refreshAccount = vi.fn(async () => {});
  mountOneTap({ onError, refreshAccount });

  await act(async () => {
    await vi.advanceTimersByTimeAsync(MOTION_ONETAP_DELAY_MS);
    await Promise.resolve();
    await Promise.resolve();
  });

  // First attempt fails transiently with 503
  await act(async () => {
    capturedInit!.callback({ credential: 'jwt_1', select_by: 'user' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(onError).toHaveBeenCalledWith(
    'Sign-in failed. Please try again or choose another sign-in method.',
    'AUTH_UNAVAILABLE',
  );

  // Trigger in-place retry -> fetches a fresh challenge (otc_retry_2) and succeeds
  act(() => {
    retryMotionOneTap();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(challengeSeq).toBe(2);

  await act(async () => {
    capturedInit!.callback({ credential: 'jwt_2', select_by: 'user' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(refreshAccount).toHaveBeenCalledTimes(1);
  expect(getMotionTrackingUserId()).toBe('usr_app_retry');

  // Cross-tab logout storage event cancels local runtime and disables auto-select
  window.dispatchEvent(
    new StorageEvent('storage', { key: ONETAP_SYNC_STORAGE_KEY, newValue: String(Date.now()) }),
  );
  expect(disableAutoSelect).toHaveBeenCalled();
});
