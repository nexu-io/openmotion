import {
  DEFAULT_DESKTOP_DOWNLOAD_URL,
  DEFAULT_UPDATE_BASE_URL,
  isUrlInAllowedDomainScope,
} from '../../shared/desktop-builtin-rules.ts';
import type { HostReleaseChannel } from '../../shared/desktop-contract.ts';
import type { DesktopUpdateState } from '../../shared/platform-host.ts';

export type UpdateFeedChannel = 'stable' | 'test';

export type GenericUpdateFeedOptions = {
  provider: 'generic';
  url: string;
  channel: UpdateFeedChannel;
};

export type AutoUpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease?: boolean;
  channel?: string | null;
  setFeedURL: (options: GenericUpdateFeedOptions) => void;
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  checkForUpdates: () => Promise<any>;
  downloadUpdate: () => Promise<any>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
};

export type DesktopUpdaterControllerOptions = {
  currentVersion: string;
  isPackaged: boolean;
  channel?: HostReleaseChannel;
  feedUrl?: string;
  allowLocalDevLoopback?: boolean;
  autoDownload?: boolean;
  autoInstallOnAppQuit?: boolean;
  loadAutoUpdater?: () => Promise<AutoUpdaterLike>;
  /** @deprecated Retained for call-site compatibility during thin-shell migration; unused. */
  onOpenReleasePage?: (url: string) => void;
};

export function normalizeSemver(raw: string): string {
  return raw.trim().replace(/^v/i, '');
}

/**
 * Compares two semver strings (e.g. "0.2.1" vs "0.2.0" or "0.2.1-beta.1").
 * Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (value: string) => {
    const clean = normalizeSemver(value).split('+')[0] ?? '';
    const [corePart = '', prePart = ''] = clean.split('-', 2);
    const core = corePart.split('.').map(part => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
    while (core.length < 3) core.push(0);
    return { core, pre: prePart };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!left.pre && right.pre) return 1;
  if (left.pre && !right.pre) return -1;
  if (!left.pre && !right.pre) return 0;
  const leftParts = left.pre.split('.');
  const rightParts = right.pre.split('.');
  const len = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < len; i++) {
    const segA = leftParts[i];
    const segB = rightParts[i];
    if (segA === undefined) return -1;
    if (segB === undefined) return 1;
    if (segA === segB) continue;
    const isNumA = /^\d+$/.test(segA);
    const isNumB = /^\d+$/.test(segB);
    if (isNumA && isNumB) {
      const diff = Number.parseInt(segA, 10) - Number.parseInt(segB, 10);
      if (diff !== 0) return diff;
    } else if (isNumA !== isNumB) {
      return isNumA ? -1 : 1;
    } else {
      const cmp = segA.localeCompare(segB);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

export function normalizeUpdateChannel(channel?: HostReleaseChannel): UpdateFeedChannel {
  return channel === 'test' || channel === 'dev' ? 'test' : 'stable';
}

/**
 * Resolves the active release channel for Electron startup.
 * Packaged builds prefer signed-bundle metadata (`openmotionChannel` in
 * `package.json`, then `app-update.yml` channel/url) before falling back to
 * the semver prerelease heuristic, so `test` builds with a clean semver
 * version (e.g. `0.2.1`) do not silently downgrade to `stable`.
 */
export function resolvePackagedReleaseChannel(options: {
  isPackaged: boolean;
  version: string;
  envChannel?: string;
  packageChannel?: string;
  appUpdateYmlContent?: string;
}): HostReleaseChannel {
  if (!options.isPackaged) {
    const normalizedEnv = options.envChannel?.trim().toLowerCase();
    if (normalizedEnv === 'stable' || normalizedEnv === 'test' || normalizedEnv === 'dev') {
      return normalizedEnv;
    }
    return 'dev';
  }

  const normalizedPkg = options.packageChannel?.trim().toLowerCase();
  if (normalizedPkg === 'stable' || normalizedPkg === 'test') {
    return normalizedPkg;
  }

  if (options.appUpdateYmlContent) {
    const channelMatch = /^\s*channel\s*:\s*['"]?(test|stable)['"]?\s*$/im.exec(
      options.appUpdateYmlContent,
    );
    if (channelMatch?.[1]) {
      return channelMatch[1].toLowerCase() as UpdateFeedChannel;
    }
    const urlMatch = /^\s*url\s*:\s*['"]?([^\s'"]+)['"]?\s*$/im.exec(options.appUpdateYmlContent);
    if (urlMatch?.[1]) {
      if (/\/test(?:\/|$)/i.test(urlMatch[1])) return 'test';
      if (/\/stable(?:\/|$)/i.test(urlMatch[1])) return 'stable';
    }
  }

  return options.version.includes('-') ? 'test' : 'stable';
}

export function resolveUpdateFeedConfig(options?: {
  channel?: HostReleaseChannel;
  feedUrl?: string;
  allowLocalDevLoopback?: boolean;
}): GenericUpdateFeedOptions {
  const scopeChannel: HostReleaseChannel = options?.channel ?? 'stable';
  const feedChannel = normalizeUpdateChannel(scopeChannel);
  const allowLocalDevLoopback = Boolean(options?.allowLocalDevLoopback);
  const rawOverride = options?.feedUrl?.trim();

  if (rawOverride) {
    if (/[\r\n\0]/.test(rawOverride)) {
      throw new Error('Update feed URL must be single-line text without control characters');
    }
    if (!isUrlInAllowedDomainScope(rawOverride, { channel: scopeChannel, allowLocalDevLoopback })) {
      throw new Error(
        `Update feed URL is outside allowed domain scope for channel "${scopeChannel}": ${rawOverride}`,
      );
    }
    return {
      provider: 'generic',
      url: rawOverride.replace(/\/+$/, ''),
      channel: feedChannel,
    };
  }

  const defaultUrl = `${DEFAULT_UPDATE_BASE_URL.replace(/\/+$/, '')}/${feedChannel}`;
  if (!isUrlInAllowedDomainScope(defaultUrl, { channel: scopeChannel, allowLocalDevLoopback })) {
    throw new Error(
      `Default update feed URL is outside allowed domain scope for channel "${scopeChannel}": ${defaultUrl}`,
    );
  }
  return {
    provider: 'generic',
    url: defaultUrl,
    channel: feedChannel,
  };
}

export function resolveElectronAutoUpdater(mod: unknown): AutoUpdaterLike {
  const candidate =
    (mod as any)?.autoUpdater ??
    (mod as any)?.default?.autoUpdater ??
    (mod as any)?.['module.exports']?.autoUpdater;
  if (
    !candidate ||
    typeof candidate.checkForUpdates !== 'function' ||
    typeof candidate.setFeedURL !== 'function'
  ) {
    throw new Error('electron-updater autoUpdater export is unavailable');
  }
  return candidate as AutoUpdaterLike;
}

export type DesktopMinimumVersionPolicy = {
  minRequiredVersion?: string;
  reason?: string;
  downloadUrl?: string;
};

const MAX_RELEASE_NOTES_LENGTH = 4000;
const SEMVER_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function decodeBasicHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function htmlOrMarkdownToPlainText(raw: string): string {
  const withoutScripts = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const withBreaks = withoutScripts
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ')
    .replace(/<\/\s*(?:p|div|li|ul|ol|h[1-6]|tr|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeBasicHtmlEntities(withBreaks)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Normalizes `electron-updater` `info.releaseNotes` (which may be a string,
 * HTML fragment, or array of `{ version, note }` items) into safe bounded
 * plain text suitable for rendering in Studio without `innerHTML`.
 */
export function sanitizeReleaseNotes(raw: unknown): string | undefined {
  let combined = '';
  if (typeof raw === 'string') {
    combined = htmlOrMarkdownToPlainText(raw);
  } else if (Array.isArray(raw)) {
    const sections: string[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const version =
        typeof (entry as { version?: unknown }).version === 'string'
          ? (entry as { version: string }).version.trim()
          : '';
      const noteRaw = (entry as { note?: unknown }).note;
      const note = typeof noteRaw === 'string' ? htmlOrMarkdownToPlainText(noteRaw) : '';
      if (!note) continue;
      if (version && raw.length > 1) {
        sections.push(`v${normalizeSemver(version)}\n${note}`);
      } else {
        sections.push(note);
      }
    }
    combined = sections.join('\n\n').trim();
  }
  if (!combined) return undefined;
  if (combined.length > MAX_RELEASE_NOTES_LENGTH) {
    return `${combined.slice(0, MAX_RELEASE_NOTES_LENGTH - 1).trimEnd()}…`;
  }
  return combined;
}

function resolveSafeReleaseNotesUrl(
  info: unknown,
  channel: HostReleaseChannel,
  allowLocalDevLoopback: boolean,
): string | undefined {
  const candidate = (info as { releaseNotesUrl?: unknown } | null | undefined)?.releaseNotesUrl;
  if (typeof candidate !== 'string') return undefined;
  const trimmed = candidate.trim();
  if (!trimmed) return undefined;
  return isUrlInAllowedDomainScope(trimmed, { channel, allowLocalDevLoopback }) ? trimmed : undefined;
}

function formatUpdateError(error: unknown, feedConfig: GenericUpdateFeedOptions): string {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  if (!raw) {
    return `Update check failed for generic feed ${feedConfig.url}`;
  }
  if (/ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|Cannot find channel|latest(?:-[a-z0-9-]+)?\.yml|stable(?:-[a-z0-9-]+)?\.yml|test(?:-[a-z0-9-]+)?\.yml|app-update\.yml|HttpError:\s*404|status code 404/i.test(raw)) {
    return `Update feed manifest not found at ${feedConfig.url}: ${raw}`;
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_|fetch failed/i.test(raw)) {
    return `Update feed unreachable at ${feedConfig.url}: ${raw}`;
  }
  return raw;
}

export class DesktopUpdaterController {
  private readonly isPackaged: boolean;
  private readonly scopeChannel: HostReleaseChannel;
  private readonly allowLocalDevLoopback: boolean;
  private readonly feedConfig: GenericUpdateFeedOptions;
  private readonly autoDownload: boolean;
  private readonly autoInstallOnAppQuit: boolean;
  private readonly loadAutoUpdater: () => Promise<AutoUpdaterLike>;
  private readonly listeners = new Set<(state: DesktopUpdateState) => void>();
  private state: DesktopUpdateState;
  private updaterPromise: Promise<AutoUpdaterLike> | null = null;
  private attached = false;

  constructor(options: DesktopUpdaterControllerOptions) {
    this.isPackaged = options.isPackaged;
    this.scopeChannel = options.channel ?? 'stable';
    this.allowLocalDevLoopback = Boolean(options.allowLocalDevLoopback);
    this.feedConfig = resolveUpdateFeedConfig({
      channel: this.scopeChannel,
      feedUrl: options.feedUrl,
      allowLocalDevLoopback: this.allowLocalDevLoopback,
    });
    this.autoDownload = options.autoDownload ?? true;
    this.autoInstallOnAppQuit = options.autoInstallOnAppQuit ?? true;
    this.loadAutoUpdater =
      options.loadAutoUpdater ??
      (async () => {
        const mod = await import('electron-updater');
        return resolveElectronAutoUpdater(mod);
      });
    this.state = {
      status: options.isPackaged ? 'idle' : 'unsupported',
      currentVersion: options.currentVersion,
    };
  }

  getFeedConfig(): GenericUpdateFeedOptions {
    return { ...this.feedConfig };
  }

  getState(): DesktopUpdateState {
    return { ...this.state };
  }

  /**
   * Applies the minimum supported desktop shell version policy (typically from
   * the Ed25519 signed config). When `currentVersion < minRequiredVersion`,
   * sets `mandatory: true` so Studio can display a non-dismissable update gate.
   */
  setMinimumVersionPolicy(policy: DesktopMinimumVersionPolicy | null | undefined): DesktopUpdateState {
    const rawMin = typeof policy?.minRequiredVersion === 'string' ? policy.minRequiredVersion.trim() : '';
    const minRequiredVersion = rawMin && SEMVER_PATTERN.test(rawMin) ? normalizeSemver(rawMin) : undefined;
    const mandatory = Boolean(
      minRequiredVersion && compareSemver(this.state.currentVersion, minRequiredVersion) < 0,
    );
    const rawReason = typeof policy?.reason === 'string'
      ? policy.reason.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, 500)
      : '';
    const mandatoryReason = mandatory && rawReason ? rawReason : undefined;

    const rawDownloadUrl = typeof policy?.downloadUrl === 'string' ? policy.downloadUrl.trim() : '';
    const safeDownloadUrl =
      rawDownloadUrl &&
      isUrlInAllowedDomainScope(rawDownloadUrl, {
        channel: this.scopeChannel,
        allowLocalDevLoopback: this.allowLocalDevLoopback,
      })
        ? rawDownloadUrl
        : undefined;
    const downloadUrl = safeDownloadUrl ?? (mandatory ? DEFAULT_DESKTOP_DOWNLOAD_URL : undefined);

    if (
      Boolean(this.state.mandatory) === mandatory &&
      this.state.minRequiredVersion === minRequiredVersion &&
      this.state.mandatoryReason === mandatoryReason &&
      this.state.downloadUrl === downloadUrl
    ) {
      return this.getState();
    }

    return this.setState({
      mandatory: mandatory || undefined,
      minRequiredVersion,
      mandatoryReason,
      downloadUrl,
    });
  }

  subscribe(listener: (state: DesktopUpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(patch: Partial<DesktopUpdateState>): DesktopUpdateState {
    this.state = {
      ...this.state,
      ...patch,
      currentVersion: this.state.currentVersion,
    };
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Ignore subscriber errors.
      }
    }
    return snapshot;
  }

  private async getUpdater(): Promise<AutoUpdaterLike> {
    if (!this.updaterPromise) {
      this.updaterPromise = this.loadAutoUpdater().catch(error => {
        this.updaterPromise = null;
        throw error;
      });
    }
    const updater = await this.updaterPromise;
    if (!this.attached) {
      this.attached = true;
      updater.autoDownload = this.isPackaged ? this.autoDownload : false;
      updater.autoInstallOnAppQuit = this.isPackaged ? this.autoInstallOnAppQuit : false;
      updater.allowPrerelease = this.feedConfig.channel === 'test';
      updater.channel = this.feedConfig.channel;
      updater.setFeedURL({
        provider: 'generic',
        url: this.feedConfig.url,
        channel: this.feedConfig.channel,
      });

      updater.on('checking-for-update', () => {
        this.setState({ status: 'checking', message: undefined });
      });
      updater.on('update-available', (info: any) => {
        this.setState({
          status: 'available',
          availableVersion: typeof info?.version === 'string' ? info.version : undefined,
          releaseNotes: sanitizeReleaseNotes(info?.releaseNotes),
          releaseNotesUrl: resolveSafeReleaseNotesUrl(
            info,
            this.scopeChannel,
            this.allowLocalDevLoopback,
          ),
          checkedAt: new Date().toISOString(),
          message: undefined,
        });
      });
      updater.on('update-not-available', () => {
        this.setState({
          status: 'up-to-date',
          availableVersion: undefined,
          progress: undefined,
          releaseNotes: undefined,
          releaseNotesUrl: undefined,
          checkedAt: new Date().toISOString(),
          message: undefined,
        });
      });
      updater.on('download-progress', (progress: any) => {
        const percent =
          typeof progress?.percent === 'number'
            ? Math.max(0, Math.min(100, Math.round(progress.percent)))
            : undefined;
        this.setState({ status: 'downloading', progress: percent, message: undefined });
      });
      updater.on('update-downloaded', (info: any) => {
        const nextNotes = sanitizeReleaseNotes(info?.releaseNotes);
        const nextNotesUrl = resolveSafeReleaseNotesUrl(
          info,
          this.scopeChannel,
          this.allowLocalDevLoopback,
        );
        this.setState({
          status: 'downloaded',
          availableVersion:
            typeof info?.version === 'string' ? info.version : this.state.availableVersion,
          releaseNotes: nextNotes ?? this.state.releaseNotes,
          releaseNotesUrl: nextNotesUrl ?? this.state.releaseNotesUrl,
          progress: 100,
          message: undefined,
        });
      });
      updater.on('error', (error: unknown) => {
        this.setState({
          status: 'error',
          message: formatUpdateError(error, this.feedConfig),
        });
      });
    }
    return updater;
  }

  async checkForUpdates(): Promise<DesktopUpdateState> {
    if (!this.isPackaged) {
      return this.setState({
        status: 'unsupported',
        checkedAt: new Date().toISOString(),
        message: 'Auto-update is available in packaged desktop releases.',
      });
    }
    this.setState({ status: 'checking', message: undefined, checkedAt: new Date().toISOString() });
    try {
      const updater = await this.getUpdater();
      await updater.checkForUpdates();
      return this.getState();
    } catch (error) {
      return this.setState({
        status: 'error',
        message: formatUpdateError(error, this.feedConfig),
      });
    }
  }

  async downloadUpdate(): Promise<DesktopUpdateState> {
    if (!this.isPackaged) {
      return this.setState({
        status: 'unsupported',
        message: 'Auto-update is available in packaged desktop releases.',
      });
    }
    if (this.state.status === 'downloaded') {
      return this.getState();
    }
    this.setState({ status: 'downloading', progress: this.state.progress ?? 0, message: undefined });
    try {
      const updater = await this.getUpdater();
      await updater.downloadUpdate();
      return this.getState();
    } catch (error) {
      return this.setState({
        status: 'error',
        message: formatUpdateError(error, this.feedConfig),
      });
    }
  }

  async installUpdateNow(beforeQuit?: () => Promise<void> | void): Promise<{ ok: boolean; error?: string }> {
    if (!this.isPackaged) {
      return { ok: false, error: 'Auto-update is available in packaged desktop releases.' };
    }
    try {
      const updater = await this.getUpdater();
      await beforeQuit?.();
      updater.quitAndInstall(false, true);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
