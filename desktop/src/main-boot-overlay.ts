import { type BrowserWindow, WebContentsView } from 'electron';
import path from 'node:path';
import { getDesktopWindowBackgroundColor } from './platform.ts';

export type BootOverlayControllerDeps = {
  distDir: string;
  getMainWindow: () => BrowserWindow | null;
  getCurrentTheme: () => 'light' | 'dark';
  isShuttingDown: () => boolean;
};

export type BootOverlayController = {
  attach: (win: BrowserWindow, onReady: () => void) => void;
  dismiss: (options?: { immediate?: boolean }) => void;
  scheduleDismiss: (delayMs?: number) => void;
  teardownImmediate: () => void;
};

/**
 * Manages the embedded `WebContentsView` splash overlay rendered on top of the
 * main BrowserWindow during cold start so there is no separate jump-resizing
 * splash window.
 */
export function createBootOverlayController(
  deps: BootOverlayControllerDeps,
): BootOverlayController {
  let bootOverlayView: WebContentsView | null = null;
  let bootOverlayDismissing = false;
  let bootOverlayDismissTimer: ReturnType<typeof setTimeout> | null = null;
  let bootOverlaySyncCleanup: (() => void) | null = null;

  function teardownImmediate(): void {
    if (bootOverlayDismissTimer) {
      clearTimeout(bootOverlayDismissTimer);
      bootOverlayDismissTimer = null;
    }
    if (bootOverlaySyncCleanup) {
      bootOverlaySyncCleanup();
      bootOverlaySyncCleanup = null;
    }
    const view = bootOverlayView;
    bootOverlayView = null;
    bootOverlayDismissing = false;
    if (!view) return;
    const mainWindow = deps.getMainWindow();
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.contentView.removeChildView(view);
      }
    } catch {
      // Ignore teardown races if the parent window is already closing.
    }
    try {
      if (!view.webContents.isDestroyed()) {
        view.webContents.close();
      }
    } catch {
      // Ignore webContents close errors during shutdown.
    }
  }

  function dismiss(options: { immediate?: boolean } = {}): void {
    if (!bootOverlayView) return;
    if (bootOverlayDismissTimer) {
      clearTimeout(bootOverlayDismissTimer);
      bootOverlayDismissTimer = null;
    }
    const mainWindow = deps.getMainWindow();
    if (options.immediate || deps.isShuttingDown() || !mainWindow || mainWindow.isDestroyed()) {
      teardownImmediate();
      return;
    }
    if (bootOverlayDismissing) return;
    bootOverlayDismissing = true;
    const view = bootOverlayView;
    if (!view.webContents.isDestroyed()) {
      void view.webContents
        .executeJavaScript(
          'window.__omSplashStopLogo && window.__omSplashStopLogo(); document.body && document.body.setAttribute("data-leaving", "true");',
        )
        .catch(() => {});
    }
    bootOverlayDismissTimer = setTimeout(() => {
      teardownImmediate();
    }, 140);
  }

  function scheduleDismiss(delayMs = 200): void {
    if (!bootOverlayView || bootOverlayDismissing || bootOverlayDismissTimer) return;
    bootOverlayDismissTimer = setTimeout(() => {
      bootOverlayDismissTimer = null;
      dismiss();
    }, delayMs);
  }

  function attach(win: BrowserWindow, onReady: () => void): void {
    teardownImmediate();
    const currentTheme = deps.getCurrentTheme();
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(deps.distDir, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    view.setBackgroundColor(getDesktopWindowBackgroundColor(currentTheme));
    bootOverlayView = view;

    const syncBounds = () => {
      if (win.isDestroyed() || bootOverlayView !== view) return;
      const { width, height } = win.getContentBounds();
      view.setBounds({ x: 0, y: 0, width: Math.max(0, width), height: Math.max(0, height) });
    };

    win.contentView.addChildView(view);
    syncBounds();

    win.on('resize', syncBounds);
    win.on('maximize', syncBounds);
    win.on('unmaximize', syncBounds);
    win.on('enter-full-screen', syncBounds);
    win.on('leave-full-screen', syncBounds);
    bootOverlaySyncCleanup = () => {
      if (win.isDestroyed()) return;
      win.off('resize', syncBounds);
      win.off('maximize', syncBounds);
      win.off('unmaximize', syncBounds);
      win.off('enter-full-screen', syncBounds);
      win.off('leave-full-screen', syncBounds);
    };

    view.webContents.once('did-finish-load', () => {
      syncBounds();
      onReady();
    });

    void view.webContents
      .loadFile(path.join(deps.distDir, 'splash.html'), {
        query: { theme: currentTheme, embedded: '1' },
      })
      .catch(() => {
        teardownImmediate();
        onReady();
      });
  }

  return {
    attach,
    dismiss,
    scheduleDismiss,
    teardownImmediate,
  };
}
