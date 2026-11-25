// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18n';
import { MobileEditorDesktopGuide } from './MobileEditorDesktopGuide';
import { WorkspaceFrame, useWorkspaceChrome } from './WorkspaceFrame';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('MobileEditorDesktopGuide', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  it('copies the current editor URL and notifies via toast feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const onExplore = vi.fn();
    const onCopyFeedback = vi.fn();
    const href = 'https://openmotion.example.com/editor/proj-123';
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <I18nProvider initialLocale="en">
            <MobileEditorDesktopGuide href={href} onExplore={onExplore} onCopyFeedback={onCopyFeedback} />
          </I18nProvider>,
        );
      });

      expect(container.querySelector('.om-mobile-editor-guide-title')?.textContent).toBe('Edit on desktop');
      expect(container.querySelector('.om-mobile-editor-guide-url-text')?.textContent).toBe(href);

      const buttons = [...container.querySelectorAll<HTMLButtonElement>('.om-mobile-editor-guide-actions button')];
      expect(buttons).toHaveLength(2);
      expect(buttons[0].textContent).toContain('Copy link');
      expect(buttons[1].textContent).toContain('Back to Explore');

      await act(async () => {
        buttons[0].click();
        await Promise.resolve();
      });

      expect(writeText).toHaveBeenCalledWith(href);
      expect(onCopyFeedback).toHaveBeenCalledWith('Link copied. Open it on your computer.', 'info');
      expect(buttons[0].textContent).toContain('Link copied');

      await act(async () => {
        buttons[1].click();
      });
      expect(onExplore).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it('reports an error toast when clipboard writing fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    document.execCommand = vi.fn().mockReturnValue(false);
    const onCopyFeedback = vi.fn();
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <I18nProvider initialLocale="en">
            <MobileEditorDesktopGuide
              href="https://openmotion.example.com/editor/proj-456"
              onExplore={vi.fn()}
              onCopyFeedback={onCopyFeedback}
            />
          </I18nProvider>,
        );
      });

      const copyButton = container.querySelector<HTMLButtonElement>('.om-mobile-editor-guide-actions button');
      expect(copyButton).not.toBeNull();

      await act(async () => {
        copyButton!.click();
        await Promise.resolve();
      });

      expect(onCopyFeedback).toHaveBeenCalledWith(
        'Could not copy link. Copy the address from your browser bar.',
        'error',
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it('marks workspace chrome inactive so playback pauses when resizing from desktop to mobile', async () => {
    const originalWidth = window.innerWidth;
    const originalMatchMedia = window.matchMedia;
    const listeners = new Map<string, Set<() => void>>();
    const mediaState = new Map<string, boolean>([
      ['(max-width: 767px)', false],
      ['(max-width: 639px)', false],
    ]);

    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        get matches() {
          return mediaState.get(query) ?? false;
        },
        media: query,
        addEventListener: (_: string, fn: () => void) => {
          if (!listeners.has(query)) listeners.set(query, new Set());
          listeners.get(query)!.add(fn);
        },
        removeEventListener: (_: string, fn: () => void) => {
          listeners.get(query)?.delete(fn);
        },
      }),
    });

    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ activeId: 'proj-1', projects: [{ id: 'proj-1', title: 'Demo' }] })));
    history.replaceState(null, '', '/editor/proj-1');

    const observedSettingsOpen: boolean[] = [];
    function PlaybackLifecycleProbe() {
      const chrome = useWorkspaceChrome();
      useEffect(() => {
        observedSettingsOpen.push(Boolean(chrome.settingsOpen));
      }, [chrome.settingsOpen]);
      return <div data-testid="mounted-editor">Editor</div>;
    }

    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <I18nProvider initialLocale="en">
            <WorkspaceFrame projectId="proj-1" waitForSaves={async () => {}}>
              <PlaybackLifecycleProbe />
            </WorkspaceFrame>
          </I18nProvider>,
        );
      });

      expect(observedSettingsOpen.at(-1)).toBe(false);
      expect(container.querySelector('.om-mobile-editor-guide')).toBeNull();
      expect(container.querySelector('[data-testid="mounted-editor"]')).not.toBeNull();

      // Resize into mobile phone viewport (< 640px).
      await act(async () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
        mediaState.set('(max-width: 767px)', true);
        mediaState.set('(max-width: 639px)', true);
        listeners.get('(max-width: 639px)')?.forEach(fn => fn());
      });

      expect(observedSettingsOpen.at(-1)).toBe(true);
      expect(container.querySelector('.om-mobile-editor-guide')).not.toBeNull();
      expect(container.querySelector('.motion-workspace-content')?.hasAttribute('hidden')).toBe(true);
      expect(container.querySelector('[data-testid="mounted-editor"]')).not.toBeNull();

      // Resize back to desktop viewport (>= 768px).
      await act(async () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
        mediaState.set('(max-width: 767px)', false);
        mediaState.set('(max-width: 639px)', false);
        listeners.get('(max-width: 639px)')?.forEach(fn => fn());
      });

      expect(observedSettingsOpen.at(-1)).toBe(false);
      expect(container.querySelector('.om-mobile-editor-guide')).toBeNull();
      expect(container.querySelector('.motion-workspace-content')?.hasAttribute('hidden')).toBe(false);
    } finally {
      act(() => root.unmount());
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: originalWidth });
      Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: originalMatchMedia });
      history.replaceState(null, '', '/');
    }
  });
});
