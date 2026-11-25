// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_CAPABILITIES,
  hostOk,
  type UniversalHostBridge,
} from '../../../shared/desktop-contract';
import type { DesktopUpdateState } from '../../../shared/platform-host';
import { I18nProvider } from '../i18n/I18n';
import { invalidateHostCapabilities } from '../utils/platformHost';
import { DesktopUpdatePrompt, parseReleaseNotesBlocks } from './DesktopUpdatePrompt';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  delete window.__OPENMOTION_HOST__;
  vi.restoreAllMocks();
});

function installMockDesktopUpdater(initialState: DesktopUpdateState) {
  let state: DesktopUpdateState = { ...initialState };
  const listeners = new Set<(payload: unknown) => void>();
  const invokeSpy = vi.fn(async (capability: string, method: string, params?: unknown) => {
    if (capability === HOST_CAPABILITIES.UPDATER && method === 'getState') {
      return hostOk(state);
    }
    if (capability === HOST_CAPABILITIES.UPDATER && method === 'checkForUpdates') {
      return hostOk(state);
    }
    if (capability === HOST_CAPABILITIES.UPDATER && method === 'downloadUpdate') {
      return hostOk(state);
    }
    if (capability === HOST_CAPABILITIES.UPDATER && method === 'installNow') {
      return hostOk({ ok: true });
    }
    if (capability === HOST_CAPABILITIES.WINDOW && method === 'openExternal') {
      return hostOk({ ok: true, url: (params as { url?: string } | undefined)?.url });
    }
    return hostOk({});
  });

  const bridge: UniversalHostBridge = {
    info: async () => ({
      shellVersion: state.currentVersion,
      platform: 'darwin',
      arch: 'arm64',
      channel: 'stable',
      bridgeKind: 'electron',
    }),
    capabilities: async () => [
      { name: HOST_CAPABILITIES.UPDATER, version: '1.0.0', status: 'available' },
      { name: HOST_CAPABILITIES.WINDOW, version: '1.0.0', status: 'available' },
    ],
    invoke: invokeSpy as UniversalHostBridge['invoke'],
    subscribe: (capability, event, handler) => {
      if (capability === HOST_CAPABILITIES.UPDATER && event === 'state') {
        listeners.add(handler);
      }
      return () => {
        listeners.delete(handler);
      };
    },
  };

  window.__OPENMOTION_HOST__ = bridge;
  invalidateHostCapabilities(bridge);

  return {
    invokeSpy,
    emitState(next: DesktopUpdateState) {
      state = { ...next };
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
}

describe('parseReleaseNotesBlocks', () => {
  it('parses headings, bullet lists, and paragraphs into safe blocks', () => {
    const blocks = parseReleaseNotesBlocks(
      '## Highlights\n- Faster rendering\n* Better stability\n\nThank you for updating.',
    );
    expect(blocks).toEqual([
      { kind: 'heading', text: 'Highlights' },
      { kind: 'list', items: ['Faster rendering', 'Better stability'] },
      { kind: 'paragraph', text: 'Thank you for updating.' },
    ]);
  });
});

describe('DesktopUpdatePrompt', () => {
  it('renders nothing on Web when no desktop bridge is present', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <I18nProvider initialLocale="en">
          <DesktopUpdatePrompt />
        </I18nProvider>,
      );
    });

    expect(container.querySelector('.om-desktop-update-banner')).toBeNull();
    expect(document.querySelector('.om-desktop-mandatory-dialog')).toBeNull();
  });

  it('shows non-intrusive banner for downloading and reappears when ready with release notes dialog', async () => {
    const mock = installMockDesktopUpdater({
      status: 'downloading',
      currentVersion: '0.2.2',
      availableVersion: '0.2.3',
      progress: 62,
      releaseNotes: '## What changed\n- Improved timeline scrubbing\n- Fixed export crash',
      releaseNotesUrl: 'https://releases.open-design.ai/open-motion/desktop/stable/0.2.3',
    });

    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <I18nProvider initialLocale="en">
          <DesktopUpdatePrompt />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const banner = container.querySelector('.om-desktop-update-banner');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('62%');

    // Dismissing the downloading banner hides it during download.
    const dismissButton = banner!.querySelector<HTMLButtonElement>('button[aria-label="Later"]')!;
    await act(async () => {
      dismissButton.click();
    });
    expect(container.querySelector('.om-desktop-update-banner')).toBeNull();

    // Transitioning to downloaded re-surfaces the banner so the user can restart.
    await act(async () => {
      mock.emitState({
        status: 'downloaded',
        currentVersion: '0.2.2',
        availableVersion: '0.2.3',
        progress: 100,
        releaseNotes: '## What changed\n- Improved timeline scrubbing\n- Fixed export crash',
        releaseNotesUrl: 'https://releases.open-design.ai/open-motion/desktop/stable/0.2.3',
      });
    });

    const readyBanner = container.querySelector('.om-desktop-update-banner');
    expect(readyBanner).not.toBeNull();
    expect(readyBanner?.textContent).toContain('v0.2.3');

    // Open release notes preview dialog from the banner.
    const whatsNewBtn = Array.from(readyBanner!.querySelectorAll('button')).find(btn =>
      btn.textContent?.includes("What's new"),
    )!;
    await act(async () => {
      whatsNewBtn.click();
    });

    const notesDialog = document.querySelector('.om-desktop-update-dialog');
    expect(notesDialog).not.toBeNull();
    expect(notesDialog?.textContent).toContain('Improved timeline scrubbing');
    expect(notesDialog?.textContent).toContain('Fixed export crash');
    expect(notesDialog?.querySelector('script')).toBeNull();

    // Click View full release notes -> calls window.openExternal with releaseNotesUrl.
    const fullNotesBtn = Array.from(notesDialog!.querySelectorAll('button')).find(btn =>
      btn.textContent?.includes('View full release notes'),
    )!;
    await act(async () => {
      fullNotesBtn.click();
    });
    expect(mock.invokeSpy).toHaveBeenCalledWith(HOST_CAPABILITIES.WINDOW, 'openExternal', {
      url: 'https://releases.open-design.ai/open-motion/desktop/stable/0.2.3',
    });

    // Click Restart and install update -> calls updater.installNow.
    const installBtn = Array.from(notesDialog!.querySelectorAll('button')).find(btn =>
      btn.textContent?.includes('Restart and install update'),
    )!;
    await act(async () => {
      installBtn.click();
    });
    expect(mock.invokeSpy).toHaveBeenCalledWith(HOST_CAPABILITIES.UPDATER, 'installNow');
  });

  it('renders a non-dismissable mandatory update gate with manual download fallback', async () => {
    const mock = installMockDesktopUpdater({
      status: 'downloading',
      currentVersion: '0.2.0',
      availableVersion: '0.3.0',
      progress: 45,
      mandatory: true,
      minRequiredVersion: '0.3.0',
      mandatoryReason: 'Protocol upgrade required for cloud sync.',
      downloadUrl: 'https://releases.open-design.ai/open-motion/desktop/stable',
    });

    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <I18nProvider initialLocale="en">
          <DesktopUpdatePrompt />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const gate = document.querySelector('.om-desktop-mandatory-dialog');
    expect(gate).not.toBeNull();
    expect(gate?.getAttribute('role')).toBe('alertdialog');
    expect(gate?.textContent).toContain('Update required');
    expect(gate?.textContent).toContain('v0.2.0');
    expect(gate?.textContent).toContain('v0.3.0');
    expect(gate?.textContent).toContain('Protocol upgrade required for cloud sync.');
    expect(gate?.textContent).toContain('45%');
    // No close button on mandatory gate.
    expect(gate?.querySelector('button[aria-label="Close"]')).toBeNull();

    // Pressing Escape does not dismiss the mandatory update modal.
    await act(async () => {
      gate!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('.om-desktop-mandatory-dialog')).not.toBeNull();

    // Manual download fallback opens the verified downloadUrl.
    const manualBtn = Array.from(gate!.querySelectorAll('button')).find(btn =>
      btn.textContent?.includes('Download manually'),
    )!;
    await act(async () => {
      manualBtn.click();
    });
    expect(mock.invokeSpy).toHaveBeenCalledWith(HOST_CAPABILITIES.WINDOW, 'openExternal', {
      url: 'https://releases.open-design.ai/open-motion/desktop/stable',
    });

    // Once downloaded, primary CTA switches to Restart and install update.
    await act(async () => {
      mock.emitState({
        status: 'downloaded',
        currentVersion: '0.2.0',
        availableVersion: '0.3.0',
        progress: 100,
        mandatory: true,
        minRequiredVersion: '0.3.0',
        mandatoryReason: 'Protocol upgrade required for cloud sync.',
        downloadUrl: 'https://releases.open-design.ai/open-motion/desktop/stable',
      });
    });

    const restartBtn = Array.from(gate!.querySelectorAll('button')).find(btn =>
      btn.textContent?.includes('Restart and install update'),
    )!;
    expect(restartBtn).toBeDefined();
    await act(async () => {
      restartBtn.click();
    });
    expect(mock.invokeSpy).toHaveBeenCalledWith(HOST_CAPABILITIES.UPDATER, 'installNow');
  });
});
