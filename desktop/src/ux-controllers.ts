import { existsSync, statSync } from 'node:fs';
import type { DesktopUpdateState } from '../../shared/platform-host.ts';

function isZhLocale(locale?: string): boolean {
  return Boolean(locale && locale.toLowerCase().startsWith('zh'));
}

// ---------------------------------------------------------------------------
// #4 Renderer Crash Recovery Guard
// ---------------------------------------------------------------------------

export type RendererCrashDecision = {
  recover: boolean;
  isOom: boolean;
  isCrashLoop: boolean;
  crashCount: number;
};

const NON_RECOVERABLE_EXIT_REASONS = new Set(['clean-exit', 'killed']);

export function isRecoverableRendererExitReason(reason: string): boolean {
  return !NON_RECOVERABLE_EXIT_REASONS.has(reason);
}

/**
 * Tracks renderer process crashes inside a rolling window so the shell can
 * recover cleanly into the retry view while warning users if repeated crashes
 * indicate a crash loop.
 */
export class RendererCrashGuard {
  private readonly windowMs: number;
  private readonly loopThreshold: number;
  private readonly timestamps: number[] = [];

  constructor(options: { windowMs?: number; loopThreshold?: number } = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.loopThreshold = options.loopThreshold ?? 3;
  }

  recordExit(reason: string, now = Date.now()): RendererCrashDecision {
    if (!isRecoverableRendererExitReason(reason)) {
      return {
        recover: false,
        isOom: false,
        isCrashLoop: false,
        crashCount: 0,
      };
    }

    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
    this.timestamps.push(now);

    return {
      recover: true,
      isOom: reason === 'oom',
      isCrashLoop: this.timestamps.length >= this.loopThreshold,
      crashCount: this.timestamps.length,
    };
  }

  reset(): void {
    this.timestamps.length = 0;
  }
}

export function buildRendererCrashRetryInfo(
  decision: RendererCrashDecision,
  details: { reason: string; exitCode?: number },
  locale?: string,
): { badge: string; title: string; code: string; message: string; detail: string } {
  const zh = isZhLocale(locale);
  const code = decision.isOom ? 'RENDERER_OOM' : 'RENDERER_CRASH';
  const detail =
    typeof details.exitCode === 'number'
      ? `${details.reason} (exit ${details.exitCode})`
      : details.reason;

  if (decision.isCrashLoop) {
    return {
      badge: zh ? '工作区连续异常' : 'Repeated crash detected',
      title: zh ? 'OpenDesign 页面多次异常退出' : 'OpenDesign stopped unexpectedly several times',
      code,
      message: zh
        ? '建议先导出诊断日志反馈问题，再尝试重新加载工作区。'
        : 'Export diagnostic logs before reloading so we can investigate the cause.',
      detail,
    };
  }

  if (decision.isOom) {
    return {
      badge: zh ? '内存不足' : 'Out of memory',
      title: zh ? '工作区因内存不足已中断' : 'Workspace ran out of memory',
      code,
      message: zh
        ? '当前媒体预览或渲染占用内存过高，点击重试可重新恢复工作区。'
        : 'The active preview or export exceeded available memory. Reload to recover your workspace.',
      detail,
    };
  }

  return {
    badge: zh ? '工作区已中断' : 'Workspace interrupted',
    title: zh ? 'OpenDesign 页面意外退出' : 'OpenDesign encountered an unexpected error',
    code,
    message: zh
      ? '你的云端项目已自动保存，点击重试即可恢复工作区。'
      : 'Your cloud projects remain safely saved. Reload to restore your workspace.',
    detail,
  };
}

// ---------------------------------------------------------------------------
// #5 + #6 Unified Dock / Taskbar Progress Coordinator
// ---------------------------------------------------------------------------

export type TaskProgressValue = number | 'indeterminate';

type DownloadProgressEntry = {
  receivedBytes: number;
  totalBytes: number;
};

/**
 * Coordinates Electron's single BrowserWindow progress bar (`setProgressBar`)
 * across concurrent file downloads and renderer long-running jobs (AI media
 * generation, video exports) so neither clobbers the other.
 */
export class TaskProgressCoordinator {
  private readonly downloads = new Map<string, DownloadProgressEntry>();
  private readonly tasks = new Map<string, TaskProgressValue>();
  private readonly onChange: (value: number) => void;
  private lastEmitted = -1;

  constructor(onChange: (value: number) => void) {
    this.onChange = onChange;
  }

  upsertDownload(id: string, receivedBytes: number, totalBytes: number): void {
    this.downloads.set(id, {
      receivedBytes: Math.max(0, Number.isFinite(receivedBytes) ? receivedBytes : 0),
      totalBytes: Math.max(0, Number.isFinite(totalBytes) ? totalBytes : 0),
    });
    this.recompute();
  }

  removeDownload(id: string): void {
    if (this.downloads.delete(id)) {
      this.recompute();
    }
  }

  upsertTask(taskId: string, progress: TaskProgressValue | null): void {
    if (progress === null) {
      this.removeTask(taskId);
      return;
    }
    if (progress === 'indeterminate') {
      this.tasks.set(taskId, 'indeterminate');
    } else if (typeof progress === 'number' && Number.isFinite(progress)) {
      if (progress < 0) {
        this.removeTask(taskId);
        return;
      }
      this.tasks.set(taskId, Math.min(1, Math.max(0, progress)));
    }
    this.recompute();
  }

  removeTask(taskId: string): void {
    if (this.tasks.delete(taskId)) {
      this.recompute();
    }
  }

  clearTasks(): void {
    if (this.tasks.size > 0) {
      this.tasks.clear();
      this.recompute();
    }
  }

  clearAll(): void {
    const hadAny = this.downloads.size > 0 || this.tasks.size > 0;
    this.downloads.clear();
    this.tasks.clear();
    if (hadAny || this.lastEmitted !== -1) {
      this.emit(-1);
    }
  }

  getValue(): number {
    return this.lastEmitted;
  }

  private recompute(): void {
    if (this.downloads.size === 0 && this.tasks.size === 0) {
      this.emit(-1);
      return;
    }

    const determinateSamples: number[] = [];
    let hasIndeterminate = false;

    for (const dl of this.downloads.values()) {
      if (dl.totalBytes > 0) {
        determinateSamples.push(Math.min(1, dl.receivedBytes / dl.totalBytes));
      } else {
        hasIndeterminate = true;
      }
    }

    for (const taskProgress of this.tasks.values()) {
      if (taskProgress === 'indeterminate') {
        hasIndeterminate = true;
      } else {
        determinateSamples.push(taskProgress);
      }
    }

    if (determinateSamples.length > 0) {
      const avg = determinateSamples.reduce((sum, v) => sum + v, 0) / determinateSamples.length;
      const quantized = Math.min(1, Math.max(0.02, Math.round(avg * 100) / 100));
      this.emit(quantized);
      return;
    }

    if (hasIndeterminate) {
      this.emit(2);
      return;
    }

    this.emit(-1);
  }

  private emit(value: number): void {
    if (value === this.lastEmitted) return;
    this.lastEmitted = value;
    this.onChange(value);
  }
}

// ---------------------------------------------------------------------------
// #5 Download Directory Resolution
// ---------------------------------------------------------------------------

export function resolveDownloadDirectory(preferredDir: string | undefined, fallbackDir: string): string {
  if (preferredDir) {
    try {
      if (existsSync(preferredDir) && statSync(preferredDir).isDirectory()) {
        return preferredDir;
      }
    } catch {
      // Fall back to default downloads directory.
    }
  }
  return fallbackDir;
}

// ---------------------------------------------------------------------------
// #6 Bounded Power-Save Wake Lock Manager
// ---------------------------------------------------------------------------

export type PowerSaveBlockerBackend = {
  start: () => number;
  stop: (id: number) => void;
};

type WakeLockLease = {
  id: string;
  reason: string;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_WAKE_LOCK_TTL_MS = 30 * 60 * 1000;
const MIN_WAKE_LOCK_TTL_MS = 5_000;
const MAX_WAKE_LOCK_TTL_MS = 60 * 60 * 1000;

/**
 * Ref-counted, TTL-bounded wrapper around Electron `powerSaveBlocker`.
 * Guarantees long renders/exports/downloads prevent App Nap suspension while
 * automatically releasing orphaned leases on TTL expiry, navigation, or quit.
 */
export class WakeLockManager {
  private readonly backend: PowerSaveBlockerBackend;
  private readonly leases = new Map<string, WakeLockLease>();
  private blockerId: number | null = null;

  constructor(backend: PowerSaveBlockerBackend) {
    this.backend = backend;
  }

  acquire(leaseId: string, reason = 'background-task', ttlMs = DEFAULT_WAKE_LOCK_TTL_MS): { active: boolean; leaseCount: number } {
    const normalizedId = leaseId.trim();
    if (!normalizedId) {
      return { active: this.blockerId !== null, leaseCount: this.leases.size };
    }
    const existing = this.leases.get(normalizedId);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const boundedTtl = Math.min(
      MAX_WAKE_LOCK_TTL_MS,
      Math.max(MIN_WAKE_LOCK_TTL_MS, Math.round(Number.isFinite(ttlMs) ? ttlMs : DEFAULT_WAKE_LOCK_TTL_MS)),
    );
    const timer = setTimeout(() => {
      this.release(normalizedId);
    }, boundedTtl);
    timer.unref?.();

    this.leases.set(normalizedId, {
      id: normalizedId,
      reason,
      timer,
    });

    if (this.blockerId === null) {
      this.blockerId = this.backend.start();
    }

    return { active: this.blockerId !== null, leaseCount: this.leases.size };
  }

  release(leaseId: string): { active: boolean; leaseCount: number } {
    const existing = this.leases.get(leaseId);
    if (existing) {
      clearTimeout(existing.timer);
      this.leases.delete(leaseId);
    }
    this.syncBlocker();
    return { active: this.blockerId !== null, leaseCount: this.leases.size };
  }

  releasePrefix(prefix: string): number {
    let released = 0;
    for (const [id, lease] of this.leases.entries()) {
      if (id.startsWith(prefix)) {
        clearTimeout(lease.timer);
        this.leases.delete(id);
        released += 1;
      }
    }
    this.syncBlocker();
    return released;
  }

  releaseAll(): void {
    for (const lease of this.leases.values()) {
      clearTimeout(lease.timer);
    }
    this.leases.clear();
    this.syncBlocker();
  }

  isActive(): boolean {
    return this.blockerId !== null;
  }

  getActiveLeaseIds(): string[] {
    return [...this.leases.keys()];
  }

  private syncBlocker(): void {
    if (this.leases.size === 0 && this.blockerId !== null) {
      const id = this.blockerId;
      this.blockerId = null;
      try {
        this.backend.stop(id);
      } catch {
        // Ignore already-stopped powerSaveBlocker handles.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// #7 Updater Menu Presentation & Manual Feedback Formatter
// ---------------------------------------------------------------------------

export type UpdaterMenuPresentation = {
  label: string;
  action: 'check' | 'install';
  enabled: boolean;
};

export function resolveUpdaterMenuPresentation(
  state: DesktopUpdateState | null | undefined,
  locale?: string,
): UpdaterMenuPresentation {
  const zh = isZhLocale(locale);
  if (state?.status === 'downloaded') {
    const ver = state.availableVersion ? ` (v${state.availableVersion})` : '';
    return {
      label: zh ? `重启以更新${ver}…` : `Restart to Update${ver}…`,
      action: 'install',
      enabled: true,
    };
  }
  if (state?.status === 'downloading') {
    const pct =
      typeof state.progress === 'number' && Number.isFinite(state.progress)
        ? ` (${Math.round(state.progress)}%)`
        : '';
    return {
      label: zh ? `正在下载更新${pct}…` : `Downloading Update${pct}…`,
      action: 'check',
      enabled: false,
    };
  }
  if (state?.status === 'checking') {
    return {
      label: zh ? '正在检查更新…' : 'Checking for Updates…',
      action: 'check',
      enabled: false,
    };
  }
  if (state?.mandatory) {
    const ver = state.minRequiredVersion ? ` (v${state.minRequiredVersion})` : '';
    return {
      label: zh ? `需要更新${ver}…` : `Update Required${ver}…`,
      action: 'check',
      enabled: true,
    };
  }
  return {
    label: zh ? '检查更新…' : 'Check for Updates…',
    action: 'check',
    enabled: true,
  };
}

export type ManualUpdateFeedback = {
  type: 'info' | 'warning';
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  primaryAction: 'restart' | 'retry' | 'none';
};

export function formatManualUpdateFeedback(
  state: DesktopUpdateState,
  locale?: string,
): ManualUpdateFeedback | null {
  const zh = isZhLocale(locale);

  if (state.status === 'downloaded') {
    const ver = state.availableVersion ? `v${state.availableVersion}` : '';
    return {
      type: 'info',
      title: zh ? '更新已就绪' : 'Update Ready to Install',
      message: zh
        ? `OpenDesign ${ver} 已下载完成，是否立即重启并安装？`
        : `OpenDesign ${ver} has been downloaded. Restart now to install?`,
      buttons: zh ? ['稍后', '立即重启'] : ['Later', 'Restart Now'],
      defaultId: 1,
      cancelId: 0,
      primaryAction: 'restart',
    };
  }

  if (state.status === 'up-to-date') {
    return {
      type: 'info',
      title: zh ? '已是最新版本' : 'You’re Up to Date',
      message: zh
        ? `OpenDesign v${state.currentVersion} 已是当前频道的最新版本。`
        : `OpenDesign v${state.currentVersion} is the latest version available on this channel.`,
      buttons: [zh ? '好' : 'OK'],
      defaultId: 0,
      cancelId: 0,
      primaryAction: 'none',
    };
  }

  if (state.status === 'available') {
    const ver = state.availableVersion ? `v${state.availableVersion}` : '';
    return {
      type: 'info',
      title: zh ? '发现新版本' : 'Update Available',
      message: zh
        ? `发现 OpenDesign ${ver}，正在后台自动下载，下载完成后将提示你重启安装。`
        : `OpenDesign ${ver} is available and downloading in the background. You will be notified when it is ready to install.`,
      buttons: [zh ? '好' : 'OK'],
      defaultId: 0,
      cancelId: 0,
      primaryAction: 'none',
    };
  }

  if (state.status === 'unsupported') {
    return {
      type: 'info',
      title: zh ? '检查更新' : 'Check for Updates',
      message:
        state.message ||
        (zh
          ? '当前构建未启用自动更新。'
          : 'Automatic updates are not available for this build.'),
      buttons: [zh ? '好' : 'OK'],
      defaultId: 0,
      cancelId: 0,
      primaryAction: 'none',
    };
  }

  if (state.status === 'error') {
    return {
      type: 'warning',
      title: zh ? '检查更新失败' : 'Update Check Failed',
      message: zh
        ? '暂时无法连接到更新服务器，请检查网络连接后重试。'
        : 'Could not reach the update server. Check your connection and try again.',
      ...(state.message ? { detail: state.message } : {}),
      buttons: zh ? ['关闭', '重试'] : ['Close', 'Retry'],
      defaultId: 1,
      cancelId: 0,
      primaryAction: 'retry',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// #9 History Navigation Safety Guard
// ---------------------------------------------------------------------------

/**
 * Ensures Back / Forward gestures and shortcuts only navigate within allowed
 * Studio origins and never bounce users into local `file://` fallback pages or
 * transient `/auth/*` login handoff routes.
 */
export function isSafeHistoryNavigationTarget(
  rawUrl: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return false;
  }
  if (!allowedOrigins.has(parsed.origin)) {
    return false;
  }
  if (parsed.pathname === '/auth' || parsed.pathname.startsWith('/auth/')) {
    return false;
  }
  return true;
}
