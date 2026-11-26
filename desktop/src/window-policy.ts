/**
 * K2 — Thin Shell Window, Navigation & Popup Security Policy.
 *
 * Pure, deterministic policy evaluators for Electron's `will-navigate`,
 * `will-redirect`, and `setWindowOpenHandler` hooks.
 *
 * Security invariants:
 * - Main window only renders same-origin Studio URLs (plus explicitly validated
 *   in-scope origins), or allowlisted auth origins ONLY while an explicit
 *   in-window login fallback is active.
 * - Billing / subscription / account portal URLs always open in the system
 *   browser so Studio can refresh entitlements when the window regains focus.
 * - Popups (`about:blank` for render preview / presenter view, and same-origin
 *   Studio popups) are explicitly stripped of the privileged preload bridge
 *   (`preload: undefined`, `contextIsolation: true`, `nodeIntegration: false`,
 *   `sandbox: true`).
 * - Dangerous schemes (`javascript:`, `file:`, `data:`, `blob:`, `vbscript:`)
 *   and credential-bearing URLs are always denied.
 */

import type { BrowserWindowConstructorOptions, HandlerDetails, WindowOpenHandlerResponse } from 'electron';
import { isUrlInAllowedDomainScope } from '../../shared/desktop-builtin-rules.ts';
import type { HostReleaseChannel } from '../../shared/desktop-contract.ts';
import type { SignedConfigPayload } from '../../shared/signed-config.ts';

export const POPUP_HARDENED_WEB_PREFERENCES = {
  preload: undefined,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} as const;

export type PopupOverrideBrowserWindowOptions = Pick<BrowserWindowConstructorOptions, 'webPreferences'> & {
  webPreferences: {
    preload: undefined;
    contextIsolation: true;
    nodeIntegration: false;
    sandbox: true;
  };
};

export type WindowPolicyConfig = {
  /** Primary Studio origin (e.g. "https://motion.open-design.ai"). */
  studioOrigin: string;
  /** Release channel controlling built-in domain bounds (default: "stable"). */
  channel?: HostReleaseChannel;
  /** Allow http://127.0.0.1 / http://localhost ONLY when channel === "dev". */
  allowLocalDevLoopback?: boolean;
  /**
   * Optional user-selected test/dev Studio origin (explicitly validated by the
   * test/dev environment switcher). Strictly ignored when `channel === 'stable'`.
   */
  explicitTestStudioOrigin?: string;
  /** Optional extra origins from signed config; filtered through built-in domain scope. */
  allowedOrigins?: readonly string[];
  /** Signed config `windowPolicy` section. */
  windowPolicy?: SignedConfigPayload['windowPolicy'];
  /**
   * Explicit IdP origins permitted ONLY while `inWindowAuthFallbackActive` is true
   * (e.g. external enterprise OIDC/SSO IdP when system-browser handoff fails).
   */
  explicitIdpAuthOrigins?: readonly string[];
  /** True only during an explicit in-window login fallback session. */
  inWindowAuthFallbackActive?: boolean;
  /** Optional additional billing/account portal hostnames. */
  billingHostnames?: readonly string[];
  /** Optional additional billing/account portal path prefixes. */
  billingPathPrefixes?: readonly string[];
};

export type NavigationPolicyReason =
  | 'same-origin-studio'
  | 'allowed-origin'
  | 'auth-fallback-origin'
  | 'billing-external'
  | 'external-url'
  | 'disallowed-scheme'
  | 'invalid-url';

export type NavigationPolicyDecision = {
  action: 'allow' | 'deny';
  reason: NavigationPolicyReason;
  openExternal: boolean;
  externalUrl?: string;
  isBillingOrAccountPortal: boolean;
};

export type WindowOpenPolicyReason =
  | 'blank-popup'
  | 'blank-popup-disabled'
  | 'same-origin-popup'
  | 'allowed-popup-origin'
  | 'billing-external'
  | 'external-popup'
  | 'disallowed-scheme'
  | 'invalid-url';

export type WindowOpenPolicyDecision =
  | {
      action: 'allow';
      reason: 'blank-popup' | 'same-origin-popup' | 'allowed-popup-origin';
      openExternal: false;
      isBillingOrAccountPortal: false;
      overrideBrowserWindowOptions: PopupOverrideBrowserWindowOptions;
    }
  | {
      action: 'deny';
      reason:
        | 'blank-popup-disabled'
        | 'billing-external'
        | 'external-popup'
        | 'disallowed-scheme'
        | 'invalid-url';
      openExternal: boolean;
      externalUrl?: string;
      isBillingOrAccountPortal: boolean;
    };

const EXTERNAL_ALLOWED_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);
const WEB_PROTOCOLS = new Set(['https:', 'http:']);

const DEFAULT_EXPLICIT_BILLING_HOSTS = new Set([
  'billing.stripe.com',
  'checkout.stripe.com',
  'invoice.stripe.com',
  'buy.stripe.com',
  'checkout.paddle.com',
  'billing.open-design.ai',
  'pay.open-design.ai',
]);

const DEFAULT_ACCOUNT_PORTAL_HOSTS = new Set([
  'account.open-design.ai',
  'accounts.open-design.ai',
]);

export const DEFAULT_FALLBACK_AUTH_ORIGINS_STABLE: readonly string[] = [
  'https://accounts.open-design.ai',
  'https://open-design.ai',
  'https://www.open-design.ai',
  'https://api.open-design.ai',
] as const;

const DEFAULT_FALLBACK_AUTH_HOSTS_TEST = [
  'vela-api.powerformer.net',
  'open-design.powerformer.net',
  'sso.powerformer.com',
] as const;

export const DEFAULT_FALLBACK_AUTH_ORIGINS_TEST: readonly string[] = [
  ...DEFAULT_FALLBACK_AUTH_HOSTS_TEST.map(host => `https://${host}`),
  ...DEFAULT_FALLBACK_AUTH_ORIGINS_STABLE,
] as const;

/**
 * Built-in first-party OIDC / login origins permitted in the main BrowserWindow
 * ONLY while `inWindowAuthFallbackActive` is true (with privileged IPC disabled).
 */
export function resolveDefaultFallbackAuthOrigins(channel: HostReleaseChannel): readonly string[] {
  return channel === 'stable'
    ? DEFAULT_FALLBACK_AUTH_ORIGINS_STABLE
    : DEFAULT_FALLBACK_AUTH_ORIGINS_TEST;
}

const DEFAULT_BILLING_EXACT_HOSTS = new Set([
  ...DEFAULT_EXPLICIT_BILLING_HOSTS,
  ...DEFAULT_ACCOUNT_PORTAL_HOSTS,
]);

const DEFAULT_BILLING_HOST_PREFIXES = ['billing.', 'checkout.', 'pay.'] as const;
const DEFAULT_BILLING_HOST_SUFFIXES = ['.paddle.com', '.lemonsqueezy.com'] as const;

const DEFAULT_BILLING_PATH_PREFIXES = [
  '/billing',
  '/checkout',
  '/subscription',
  '/subscriptions',
  '/plans',
  '/pricing',
  '/upgrade',
  '/customer-portal',
  '/account/billing',
  '/account/subscription',
  '/account/portal',
  '/settings/billing',
  '/portal/billing',
  '/stripe/portal',
] as const;

function parseSafeUrl(rawUrl: string): URL | null {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed)) return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

function normalizeOrigin(rawOrigin: string): string | null {
  const parsed = parseSafeUrl(rawOrigin);
  if (!parsed) return null;
  if (!WEB_PROTOCOLS.has(parsed.protocol)) return null;
  if (parsed.username || parsed.password) return null;
  return parsed.origin;
}

function isLocalLoopbackHttpUrl(parsed: URL): boolean {
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

function collectValidatedDomainOrigins(
  rawOrigins: readonly string[] | undefined,
  options: { channel: HostReleaseChannel; allowLocalDevLoopback: boolean },
): Set<string> {
  const result = new Set<string>();
  if (!rawOrigins) return result;
  for (const candidate of rawOrigins) {
    if (!isUrlInAllowedDomainScope(candidate, options)) continue;
    const origin = normalizeOrigin(candidate);
    if (origin) result.add(origin);
  }
  return result;
}

function collectValidatedExplicitIdpOrigins(
  rawOrigins: readonly string[] | undefined,
  options: { channel: HostReleaseChannel; allowLocalDevLoopback: boolean },
): Set<string> {
  const result = new Set<string>();
  if (!rawOrigins) return result;
  for (const candidate of rawOrigins) {
    const parsed = parseSafeUrl(candidate);
    if (!parsed || parsed.username || parsed.password) continue;
    if (parsed.protocol === 'https:') {
      result.add(parsed.origin);
      continue;
    }
    if (options.channel === 'dev' && options.allowLocalDevLoopback && isLocalLoopbackHttpUrl(parsed)) {
      result.add(parsed.origin);
    }
  }
  return result;
}

export function buildPopupOverrideOptions(): PopupOverrideBrowserWindowOptions {
  return {
    webPreferences: {
      preload: undefined,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

/**
 * Checks whether a URL uses an allowed external-browser protocol (`https:`, `http:`, `mailto:`)
 * without embedded credentials or control characters.
 */
export function isAllowedExternalUrl(rawUrl: string): boolean {
  const parsed = parseSafeUrl(rawUrl);
  if (!parsed) return false;
  if (!EXTERNAL_ALLOWED_PROTOCOLS.has(parsed.protocol)) return false;
  if (WEB_PROTOCOLS.has(parsed.protocol) && (parsed.username || parsed.password)) {
    return false;
  }
  return true;
}

function isExplicitBillingOnlyUrl(
  parsed: URL,
  options?: {
    extraHostnames?: readonly string[];
    extraPathPrefixes?: readonly string[];
  },
): boolean {
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (DEFAULT_EXPLICIT_BILLING_HOSTS.has(host)) {
    return true;
  }
  if (DEFAULT_BILLING_HOST_PREFIXES.some(prefix => host.startsWith(prefix))) {
    return true;
  }
  if (DEFAULT_BILLING_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    return true;
  }
  if (options?.extraHostnames?.some(entry => host === entry.trim().toLowerCase().replace(/\.$/, ''))) {
    return true;
  }

  const normalizedPath = parsed.pathname.toLowerCase().replace(/\/+$/, '') || '/';
  const prefixes = options?.extraPathPrefixes
    ? [...DEFAULT_BILLING_PATH_PREFIXES, ...options.extraPathPrefixes]
    : DEFAULT_BILLING_PATH_PREFIXES;

  for (const rawPrefix of prefixes) {
    const prefix = rawPrefix.trim().toLowerCase().replace(/\/+$/, '');
    if (!prefix) continue;
    if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
      return true;
    }
  }

  for (const billingParam of ['billing', 'checkout', 'subscription', 'upgrade'] as const) {
    if (parsed.searchParams.has(billingParam)) {
      return true;
    }
  }

  return false;
}

/**
 * Identifies billing, checkout, subscription, and external account-portal URLs.
 * Main-window navigations and popups to these URLs are routed to the system browser,
 * and Studio can use this signal to refresh entitlements on window focus return.
 */
export function isBillingOrAccountPortalUrl(
  rawUrl: string,
  options?: {
    extraHostnames?: readonly string[];
    extraPathPrefixes?: readonly string[];
  },
): boolean {
  const parsed = parseSafeUrl(rawUrl);
  if (!parsed || !WEB_PROTOCOLS.has(parsed.protocol)) return false;
  if (parsed.username || parsed.password) return false;

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (DEFAULT_BILLING_EXACT_HOSTS.has(host)) {
    return true;
  }
  return isExplicitBillingOnlyUrl(parsed, options);
}

/**
 * Evaluates whether the main BrowserWindow may navigate (or redirect) to `rawUrl`.
 */
export function evaluateNavigationPolicy(
  rawUrl: string,
  config: WindowPolicyConfig,
): NavigationPolicyDecision {
  const parsed = parseSafeUrl(rawUrl);
  if (!parsed) {
    return {
      action: 'deny',
      reason: 'invalid-url',
      openExternal: false,
      isBillingOrAccountPortal: false,
    };
  }

  if (parsed.protocol === 'mailto:') {
    return {
      action: 'deny',
      reason: 'external-url',
      openExternal: true,
      externalUrl: parsed.href,
      isBillingOrAccountPortal: false,
    };
  }

  if (!WEB_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password) {
    return {
      action: 'deny',
      reason: 'disallowed-scheme',
      openExternal: false,
      isBillingOrAccountPortal: false,
    };
  }

  const channel = config.channel ?? 'stable';
  const allowLocalDevLoopback = Boolean(config.allowLocalDevLoopback && channel === 'dev');
  const scopeOptions = { channel, allowLocalDevLoopback };
  const explicitTestOrigin =
    channel !== 'stable' && config.explicitTestStudioOrigin
      ? normalizeOrigin(config.explicitTestStudioOrigin)
      : null;

  const billingOptions = {
    extraHostnames: config.billingHostnames,
    extraPathPrefixes: config.billingPathPrefixes,
  };

  // Explicit billing / checkout / subscription URLs ALWAYS open in the system browser,
  // even while in-window auth fallback is active.
  if (isExplicitBillingOnlyUrl(parsed, billingOptions)) {
    return {
      action: 'deny',
      reason: 'billing-external',
      openExternal: true,
      externalUrl: parsed.href,
      isBillingOrAccountPortal: true,
    };
  }

  // While in-window auth fallback is active, allow allowlisted auth origins (including
  // OIDC redirects to accounts.open-design.ai when explicitly allowlisted) before the
  // general account-portal external redirect rule.
  if (config.inWindowAuthFallbackActive) {
    const signedAuthOrigins = collectValidatedDomainOrigins(
      config.windowPolicy?.allowedAuthOrigins,
      scopeOptions,
    );
    const idpAuthOrigins = collectValidatedExplicitIdpOrigins(
      config.explicitIdpAuthOrigins,
      scopeOptions,
    );
    if (signedAuthOrigins.has(parsed.origin) || idpAuthOrigins.has(parsed.origin)) {
      return {
        action: 'allow',
        reason: 'auth-fallback-origin',
        openExternal: false,
        isBillingOrAccountPortal: false,
      };
    }
  }

  const isBilling = isBillingOrAccountPortalUrl(parsed.href, billingOptions);
  if (isBilling) {
    return {
      action: 'deny',
      reason: 'billing-external',
      openExternal: true,
      externalUrl: parsed.href,
      isBillingOrAccountPortal: true,
    };
  }

  const studioOrigin = normalizeOrigin(config.studioOrigin);
  if (explicitTestOrigin && parsed.origin === explicitTestOrigin) {
    return {
      action: 'allow',
      reason: 'same-origin-studio',
      openExternal: false,
      isBillingOrAccountPortal: false,
    };
  }
  if (studioOrigin && parsed.origin === studioOrigin) {
    return {
      action: 'allow',
      reason: 'same-origin-studio',
      openExternal: false,
      isBillingOrAccountPortal: false,
    };
  }

  const allowedOrigins = collectValidatedDomainOrigins(config.allowedOrigins, scopeOptions);
  if (allowedOrigins.has(parsed.origin)) {
    return {
      action: 'allow',
      reason: 'allowed-origin',
      openExternal: false,
      isBillingOrAccountPortal: false,
    };
  }

  return {
    action: 'deny',
    reason: 'external-url',
    openExternal: true,
    externalUrl: parsed.href,
    isBillingOrAccountPortal: false,
  };
}

/**
 * Evaluates Electron's `setWindowOpenHandler` request for `rawUrl`.
 * Allowed popups (`about:blank` and same-origin/allowlisted Studio popups)
 * ALWAYS receive hardened `overrideBrowserWindowOptions` with `preload: undefined`.
 */
export function evaluateWindowOpenPolicy(
  rawUrl: string,
  config: WindowPolicyConfig,
): WindowOpenPolicyDecision {
  if (typeof rawUrl !== 'string') {
    return {
      action: 'deny',
      reason: 'invalid-url',
      openExternal: false,
      isBillingOrAccountPortal: false,
    };
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return {
      action: 'deny',
      reason: 'invalid-url',
      openExternal: false,
      isBillingOrAccountPortal: false,
    };
  }

  if (trimmed.toLowerCase() === 'about:blank') {
    if (config.windowPolicy?.allowBlankPopups === false) {
      return {
        action: 'deny',
        reason: 'blank-popup-disabled',
        openExternal: false,
        isBillingOrAccountPortal: false,
      };
    }
    return {
      action: 'allow',
      reason: 'blank-popup',
      openExternal: false,
      isBillingOrAccountPortal: false,
      overrideBrowserWindowOptions: buildPopupOverrideOptions(),
    };
  }

  const parsed = parseSafeUrl(trimmed);
  if (!parsed) {
    return {
      action: 'deny',
      reason: 'invalid-url',
      openExternal: false,
      isBillingOrAccountPortal: false,
    };
  }

  if (parsed.protocol === 'mailto:') {
    return {
      action: 'deny',
      reason: 'external-popup',
      openExternal: true,
      externalUrl: parsed.href,
      isBillingOrAccountPortal: false,
    };
  }

  if (!WEB_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password) {
    return {
      action: 'deny',
      reason: 'disallowed-scheme',
      openExternal: false,
      isBillingOrAccountPortal: false,
    };
  }

  const isBilling = isBillingOrAccountPortalUrl(parsed.href, {
    extraHostnames: config.billingHostnames,
    extraPathPrefixes: config.billingPathPrefixes,
  });
  if (isBilling) {
    return {
      action: 'deny',
      reason: 'billing-external',
      openExternal: true,
      externalUrl: parsed.href,
      isBillingOrAccountPortal: true,
    };
  }

  const channel = config.channel ?? 'stable';
  const allowLocalDevLoopback = Boolean(config.allowLocalDevLoopback && channel === 'dev');
  const scopeOptions = { channel, allowLocalDevLoopback };
  const explicitTestOrigin =
    channel !== 'stable' && config.explicitTestStudioOrigin
      ? normalizeOrigin(config.explicitTestStudioOrigin)
      : null;

  const studioOrigin = normalizeOrigin(config.studioOrigin);
  if (explicitTestOrigin && parsed.origin === explicitTestOrigin) {
    return {
      action: 'allow',
      reason: 'same-origin-popup',
      openExternal: false,
      isBillingOrAccountPortal: false,
      overrideBrowserWindowOptions: buildPopupOverrideOptions(),
    };
  }
  if (studioOrigin && parsed.origin === studioOrigin) {
    return {
      action: 'allow',
      reason: 'same-origin-popup',
      openExternal: false,
      isBillingOrAccountPortal: false,
      overrideBrowserWindowOptions: buildPopupOverrideOptions(),
    };
  }

  const allowedPopupOrigins = collectValidatedDomainOrigins(
    config.windowPolicy?.allowedPopupOrigins,
    scopeOptions,
  );
  if (allowedPopupOrigins.has(parsed.origin)) {
    return {
      action: 'allow',
      reason: 'allowed-popup-origin',
      openExternal: false,
      isBillingOrAccountPortal: false,
      overrideBrowserWindowOptions: buildPopupOverrideOptions(),
    };
  }

  return {
    action: 'deny',
    reason: 'external-popup',
    openExternal: true,
    externalUrl: parsed.href,
    isBillingOrAccountPortal: false,
  };
}

/**
 * Converts a `WindowOpenPolicyDecision` to the exact response object expected
 * by Electron's `webContents.setWindowOpenHandler`.
 */
export function toElectronWindowOpenResult(
  decision: WindowOpenPolicyDecision,
): WindowOpenHandlerResponse {
  if (decision.action === 'allow') {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: decision.overrideBrowserWindowOptions,
    };
  }
  return { action: 'deny' };
}

export type PolicyWebContentsLike = {
  on: (
    event: 'will-navigate' | 'will-redirect',
    listener: (event: { preventDefault: () => void }, url: string) => void,
  ) => unknown;
  setWindowOpenHandler: (handler: (details: Pick<HandlerDetails, 'url'>) => WindowOpenHandlerResponse) => void;
};

export type AttachWindowPoliciesOptions = {
  getConfig: () => WindowPolicyConfig;
  openExternal: (
    url: string,
    context: { source: 'navigation' | 'redirect' | 'popup'; isBillingOrAccountPortal: boolean },
  ) => Promise<unknown> | unknown;
  onDecision?: (
    kind: 'navigation' | 'redirect' | 'popup',
    url: string,
    decision: NavigationPolicyDecision | WindowOpenPolicyDecision,
  ) => void;
};

/**
 * Attaches navigation, redirect, and window-open security guards to a main
 * Electron `WebContents` instance.
 */
export function attachWindowNavigationPolicies(
  webContents: PolicyWebContentsLike,
  options: AttachWindowPoliciesOptions,
): void {
  const handleNavigation = (
    kind: 'navigation' | 'redirect',
    event: { preventDefault: () => void },
    url: string,
  ): void => {
    const decision = evaluateNavigationPolicy(url, options.getConfig());
    options.onDecision?.(kind, url, decision);
    if (decision.action === 'deny') {
      event.preventDefault();
      if (decision.openExternal && decision.externalUrl) {
        void options.openExternal(decision.externalUrl, {
          source: kind,
          isBillingOrAccountPortal: decision.isBillingOrAccountPortal,
        });
      }
    }
  };

  webContents.on('will-navigate', (event, url) => {
    handleNavigation('navigation', event, url);
  });

  webContents.on('will-redirect', (event, url) => {
    handleNavigation('redirect', event, url);
  });

  webContents.setWindowOpenHandler(({ url }) => {
    const decision = evaluateWindowOpenPolicy(url, options.getConfig());
    options.onDecision?.('popup', url, decision);
    if (decision.action === 'deny' && decision.openExternal && decision.externalUrl) {
      void options.openExternal(decision.externalUrl, {
        source: 'popup',
        isBillingOrAccountPortal: decision.isBillingOrAccountPortal,
      });
    }
    return toElectronWindowOpenResult(decision);
  });
}
