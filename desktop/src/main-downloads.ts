import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import type { DesktopPreferencesStore } from './prefs.ts';
import type { DesktopUpdaterController } from './updater.ts';
import {
  formatManualUpdateFeedback,
  resolveDownloadDirectory,
  type TaskProgressCoordinator,
  type WakeLockManager,
} from './ux-controllers.ts';

export type SessionDownloadControllerDeps = {
  desktopPrefs: DesktopPreferencesStore;
  wakeLockManager: WakeLockManager;
  progressCoordinator: TaskProgressCoordinator;
  isZhAppLocale: () => boolean;
  emitPreferencesChanged: () => void;
  focusOrRestoreMainWindow: () => void;
  showDesktopNotification: (options: {
    title: string;
    body?: string;
    whenUnfocusedOnly?: boolean;
    onClick?: () => void;
  }) => unknown;
};

export function createSessionDownloadController(deps: SessionDownloadControllerDeps): {
  attach: (win: BrowserWindow) => void;
} {
  const downloadHandledSessions = new WeakSet<Electron.Session>();
  let downloadSequence = 0;

  function attach(win: BrowserWindow): void {
    const targetSession = win.webContents.session;
    if (downloadHandledSessions.has(targetSession)) return;
    downloadHandledSessions.add(targetSession);

    targetSession.on('will-download', (_event, item) => {
      const downloadId = `dl-${++downloadSequence}`;
      const filename = item.getFilename() || 'download';
      try {
        const preferredDir = resolveDownloadDirectory(
          deps.desktopPrefs.get().lastDownloadDir,
          app.getPath('downloads'),
        );
        item.setSaveDialogOptions({
          defaultPath: path.join(preferredDir, filename),
        });
      } catch {
        // Ignore save dialog option errors on restricted environments.
      }

      deps.wakeLockManager.acquire(`download:${downloadId}`, 'file-download');
      deps.progressCoordinator.upsertDownload(
        downloadId,
        item.getReceivedBytes(),
        item.getTotalBytes(),
      );

      item.on('updated', (_ev, state) => {
        if (state === 'progressing' && !item.isPaused()) {
          deps.progressCoordinator.upsertDownload(
            downloadId,
            item.getReceivedBytes(),
            item.getTotalBytes(),
          );
        } else if (state === 'interrupted') {
          deps.progressCoordinator.removeDownload(downloadId);
        }
      });

      item.once('done', (_ev, state) => {
        deps.wakeLockManager.release(`download:${downloadId}`);
        deps.progressCoordinator.removeDownload(downloadId);
        const savePath = item.getSavePath();
        if (state === 'completed' && savePath) {
          deps.desktopPrefs.update({ lastDownloadDir: path.dirname(savePath) });
          deps.emitPreferencesChanged();
          const zh = deps.isZhAppLocale();
          deps.showDesktopNotification({
            title: zh ? '文件已保存' : 'Download Complete',
            body: path.basename(savePath),
            whenUnfocusedOnly: false,
            onClick: () => {
              try {
                shell.showItemInFolder(savePath);
              } catch {
                deps.focusOrRestoreMainWindow();
              }
            },
          });
        }
      });
    });
  }

  return { attach };
}

export type ManualUpdateFeedbackDeps = {
  updater: DesktopUpdaterController;
  getMainWindow: () => BrowserWindow | null;
  getEffectiveAppLocale: () => string;
  isShuttingDown: () => boolean;
  isManualUpdateCheckPending: () => boolean;
  setManualUpdateCheckPending: (pending: boolean) => void;
  installDownloadedUpdate: () => Promise<{ ok: boolean; error?: string }>;
};

export function createManualUpdateFeedbackPresenter(deps: ManualUpdateFeedbackDeps): {
  maybePresent: (state: ReturnType<DesktopUpdaterController['getState']>) => Promise<void>;
} {
  let manualUpdateDialogOpen = false;

  async function maybePresent(
    state: ReturnType<DesktopUpdaterController['getState']>,
  ): Promise<void> {
    if (!deps.isManualUpdateCheckPending() || manualUpdateDialogOpen || deps.isShuttingDown()) {
      return;
    }
    const feedback = formatManualUpdateFeedback(state, deps.getEffectiveAppLocale());
    if (!feedback) return;
    deps.setManualUpdateCheckPending(false);
    manualUpdateDialogOpen = true;
    try {
      const mainWindow = deps.getMainWindow();
      const parent =
        mainWindow && !mainWindow.isDestroyed()
          ? mainWindow
          : BrowserWindow.getFocusedWindow() ?? undefined;
      const options = {
        type: feedback.type,
        title: feedback.title,
        message: feedback.message,
        ...(feedback.detail ? { detail: feedback.detail } : {}),
        buttons: feedback.buttons,
        defaultId: feedback.defaultId,
        cancelId: feedback.cancelId,
        noLink: true,
      };
      const { response } = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
      if (feedback.primaryAction === 'restart' && response === feedback.defaultId) {
        await deps.installDownloadedUpdate();
      } else if (feedback.primaryAction === 'retry' && response === feedback.defaultId) {
        deps.setManualUpdateCheckPending(true);
        const retryState = await deps.updater.checkForUpdates();
        void maybePresent(retryState);
      }
    } finally {
      manualUpdateDialogOpen = false;
    }
  }

  return { maybePresent };
}
