// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18n';
import { MobileEditorDesktopGuide } from './MobileEditorDesktopGuide';

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
});
