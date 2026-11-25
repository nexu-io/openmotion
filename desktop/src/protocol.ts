/**
 * R5 — Custom `openmotion://` Protocol Registration & Safe Deep-Link Router.
 *
 * Security boundaries:
 * - Registers `openmotion://` (`DESKTOP_PROTOCOL_SCHEME`) as the OS protocol handler.
 * - Strictly parses and validates incoming deep-link URLs, rejecting malformed URLs,
 *   unexpected schemes, credentials/ports, control characters, unsupported actions,
 *   and untrusted or duplicated query parameters.
 * - Handles `openmotion://open` to activate/focus the main desktop window.
 * - Records validated, sanitized deep-link events in a bounded ring buffer for
 *   diagnostics and future extensions without ever storing raw untrusted payloads.
 */

import path from 'node:path';
import { DESKTOP_PROTOCOL_SCHEME } from '../../shared/desktop-builtin-rules.ts';
import type { HostReleaseChannel } from '../../shared/desktop-contract.ts';
import {
  isEnvironmentSwitcherEnabled,
  validateTestEnvironmentUrl,
  type TestEnvironmentValidationOptions,
} from './env-switcher.ts';

export const DESKTOP_PROTOCOL_PREFIX = `${DESKTOP_PROTOCOL_SCHEME}://` as const;
export const MAX_DESKTOP_DEEP_LINK_LENGTH = 2048;
export const DEFAULT_MAX_RECORDED_EVENTS = 50;

export type DesktopDeepLinkAction = 'open';

export type ParsedDesktopDeepLink = {
  ok: true;
  scheme: typeof DESKTOP_PROTOCOL_SCHEME;
  action: DesktopDeepLinkAction;
  params: Readonly<Record<string, string>>;
  normalizedUrl: string;
  receivedAt: string;
};

export type DesktopDeepLinkRejectReason =
  | 'empty'
  | 'too-long'
  | 'control-chars'
  | 'malformed-url'
  | 'invalid-scheme'
  | 'disallowed-credentials-or-port'
  | 'unsupported-action'
  | 'untrusted-parameter'
  | 'invalid-parameter-value';

export type RejectedDesktopDeepLink = {
  ok: false;
  reason: DesktopDeepLinkRejectReason;
  message: string;
};

export type DesktopDeepLinkParseResult = ParsedDesktopDeepLink | RejectedDesktopDeepLink;

const SAFE_TOKEN_PARAM_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SAFE_STUDIO_PATH_RE = /^\/[a-zA-Z0-9/_\-.]{0,255}$/;
const ALLOWED_OPEN_PARAMS = new Set(['source', 'path', 'tab']);

function reject(reason: DesktopDeepLinkRejectReason, message: string): RejectedDesktopDeepLink {
  return { ok: false, reason, message };
}

function validateSafeOpenParam(key: string, value: string): boolean {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return false;
  if (key === 'source' || key === 'tab') {
    return SAFE_TOKEN_PARAM_RE.test(value);
  }
  if (key === 'path') {
    if (!SAFE_STUDIO_PATH_RE.test(value)) return false;
    if (value.includes('..') || value.includes('//') || value.includes(':\\')) return false;
    return true;
  }
  return false;
}

export type ParseDesktopDeepLinkOptions = {
  now?: () => Date;
  /**
   * When true on `test` or `dev` channels, permits an `env` query parameter
   * validated against `validateTestEnvironmentUrl`. Ignored on `stable`.
   */
  allowEnvParam?: boolean;
  envValidation?: TestEnvironmentValidationOptions;
  channel?: HostReleaseChannel;
};

/**
 * Safely parses and validates an incoming `openmotion://` deep-link URL.
 */
export function parseDesktopDeepLink(
  rawUrl: string,
  options?: ParseDesktopDeepLinkOptions,
): DesktopDeepLinkParseResult {
  if (typeof rawUrl !== 'string') {
    return reject('empty', 'Deep-link URL must be a non-empty string');
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return reject('empty', 'Deep-link URL is empty');
  }

  if (trimmed.length > MAX_DESKTOP_DEEP_LINK_LENGTH) {
    return reject('too-long', `Deep-link URL exceeds ${MAX_DESKTOP_DEEP_LINK_LENGTH} characters`);
  }

  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    return reject('control-chars', 'Deep-link URL contains disallowed control characters');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return reject('malformed-url', 'Deep-link URL is malformed');
  }

  if (parsed.protocol.toLowerCase() !== `${DESKTOP_PROTOCOL_SCHEME}:`) {
    return reject('invalid-scheme', `Expected ${DESKTOP_PROTOCOL_SCHEME}: scheme`);
  }

  if (parsed.username || parsed.password || parsed.port) {
    return reject(
      'disallowed-credentials-or-port',
      'Deep-link URL must not include credentials or an explicit port',
    );
  }

  if (parsed.hash) {
    return reject('untrusted-parameter', 'Deep-link URL fragments are not permitted');
  }

  const actionHost = parsed.hostname.toLowerCase();
  const normalizedPathname = parsed.pathname.replace(/\/+$/, '');

  if (actionHost !== 'open' || (normalizedPathname !== '' && normalizedPathname !== '/')) {
    return reject('unsupported-action', `Unsupported deep-link action: ${actionHost || '<empty>'}`);
  }

  const envChannel: HostReleaseChannel = options?.envValidation?.channel ?? options?.channel ?? 'stable';
  const envParamAllowed = Boolean(options?.allowEnvParam && isEnvironmentSwitcherEnabled(envChannel));
  const sanitizedParams: Record<string, string> = {};
  const seenKeys = new Set<string>();
  for (const [key, value] of parsed.searchParams.entries()) {
    const isEnvKey = key === 'env' && envParamAllowed;
    if (!ALLOWED_OPEN_PARAMS.has(key) && !isEnvKey) {
      return reject('untrusted-parameter', `Untrusted deep-link parameter: ${key}`);
    }
    if (seenKeys.has(key)) {
      return reject('untrusted-parameter', `Duplicate deep-link parameter: ${key}`);
    }
    seenKeys.add(key);
    const cleanValue = value.trim();
    if (isEnvKey) {
      const checked = validateTestEnvironmentUrl(
        cleanValue,
        options?.envValidation ?? { channel: envChannel },
      );
      if (!checked.ok) {
        return reject('invalid-parameter-value', checked.reason);
      }
      sanitizedParams[key] = checked.normalizedUrl;
      continue;
    }
    if (!validateSafeOpenParam(key, cleanValue)) {
      return reject('invalid-parameter-value', `Invalid value for deep-link parameter "${key}"`);
    }
    sanitizedParams[key] = cleanValue;
  }

  const canonical = new URL(`${DESKTOP_PROTOCOL_SCHEME}://open`);
  for (const key of Object.keys(sanitizedParams).sort()) {
    canonical.searchParams.set(key, sanitizedParams[key]);
  }

  return {
    ok: true,
    scheme: DESKTOP_PROTOCOL_SCHEME,
    action: 'open',
    params: Object.freeze(sanitizedParams),
    normalizedUrl: canonical.toString(),
    receivedAt: (options?.now ? options.now() : new Date()).toISOString(),
  };
}

/**
 * Extracts the first `openmotion://` deep-link candidate from process `argv`
 * (used on Windows and Linux during initial launch and `second-instance`).
 */
export function extractDeepLinkFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    const trimmed = arg.trim();
    if (trimmed.toLowerCase().startsWith(DESKTOP_PROTOCOL_PREFIX)) {
      return trimmed;
    }
  }
  return null;
}

export type ElectronProtocolAppLike = {
  setAsDefaultProtocolClient: (protocol: string, execPath?: string, args?: string[]) => boolean;
};

export type RegisterProtocolOptions = {
  defaultApp?: boolean;
  execPath?: string;
  argv?: readonly string[];
};

/**
 * Registers the `openmotion://` custom protocol handler with the OS via Electron's `app`.
 */
export function registerDesktopProtocolClient(
  appLike: ElectronProtocolAppLike,
  options?: RegisterProtocolOptions,
): { registered: boolean; scheme: typeof DESKTOP_PROTOCOL_SCHEME } {
  const isDefaultApp = options?.defaultApp ?? Boolean((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp);
  const execPath = options?.execPath ?? process.execPath;
  const argv = options?.argv ?? process.argv;

  let registered = false;
  if (isDefaultApp && argv.length >= 2 && argv[1]) {
    registered = appLike.setAsDefaultProtocolClient(
      DESKTOP_PROTOCOL_SCHEME,
      execPath,
      [path.resolve(argv[1])],
    );
  } else {
    registered = appLike.setAsDefaultProtocolClient(DESKTOP_PROTOCOL_SCHEME);
  }

  return {
    registered: Boolean(registered),
    scheme: DESKTOP_PROTOCOL_SCHEME,
  };
}

export type DesktopProtocolRouterOptions = {
  /** Invoked when a valid `openmotion://open` deep link arrives. */
  onActivateMainWindow?: (link: ParsedDesktopDeepLink) => void;
  /** Optional hook notified when a malformed or untrusted URL is rejected. */
  onRejected?: (rejection: RejectedDesktopDeepLink, rawUrl: string) => void;
  /** Maximum number of validated events retained in memory (default: 50). */
  maxRecordedEvents?: number;
  /** Clock override for deterministic testing. */
  now?: () => Date;
  /** Permit validated `env` deep-link parameter on test/dev builds. */
  allowEnvParam?: boolean;
  /** Validation options for `env` deep-link parameter. */
  envValidation?: TestEnvironmentValidationOptions;
};

/**
 * Validates, dispatches, and records safe `openmotion://` deep-link events.
 */
export class DesktopProtocolRouter {
  private readonly onActivateMainWindow?: (link: ParsedDesktopDeepLink) => void;
  private readonly onRejected?: (rejection: RejectedDesktopDeepLink, rawUrl: string) => void;
  private readonly maxRecordedEvents: number;
  private readonly now?: () => Date;
  private readonly allowEnvParam: boolean;
  private readonly envValidation?: TestEnvironmentValidationOptions;
  private readonly recordedEvents: ParsedDesktopDeepLink[] = [];
  private readonly listeners = new Set<(link: ParsedDesktopDeepLink) => void>();

  constructor(options: DesktopProtocolRouterOptions = {}) {
    this.onActivateMainWindow = options.onActivateMainWindow;
    this.onRejected = options.onRejected;
    this.maxRecordedEvents = Math.max(1, options.maxRecordedEvents ?? DEFAULT_MAX_RECORDED_EVENTS);
    this.now = options.now;
    this.allowEnvParam = Boolean(options.allowEnvParam);
    this.envValidation = options.envValidation;
  }

  handleUrl(rawUrl: string): DesktopDeepLinkParseResult {
    const result = parseDesktopDeepLink(rawUrl, {
      ...(this.now ? { now: this.now } : {}),
      ...(this.allowEnvParam ? { allowEnvParam: true } : {}),
      ...(this.envValidation ? { envValidation: this.envValidation } : {}),
    });
    if (!result.ok) {
      this.onRejected?.(result, rawUrl);
      return result;
    }

    if (this.recordedEvents.length >= this.maxRecordedEvents) {
      this.recordedEvents.shift();
    }
    this.recordedEvents.push(result);

    if (result.action === 'open') {
      this.onActivateMainWindow?.(result);
    }

    for (const listener of this.listeners) {
      try {
        listener(result);
      } catch {
        // Isolate subscriber exceptions from protocol dispatch.
      }
    }

    return result;
  }

  handleArgv(argv: readonly string[]): DesktopDeepLinkParseResult | null {
    const candidate = extractDeepLinkFromArgv(argv);
    if (!candidate) return null;
    return this.handleUrl(candidate);
  }

  getRecordedEvents(): readonly ParsedDesktopDeepLink[] {
    return [...this.recordedEvents];
  }

  clearRecordedEvents(): void {
    this.recordedEvents.length = 0;
  }

  subscribe(listener: (link: ParsedDesktopDeepLink) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
