import { useEffect, useRef, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';

export type MobileEditorDesktopGuideProps = {
  href: string;
  onExplore: () => void;
  onCopyFeedback: (message: string, tone: 'info' | 'error') => void;
};

async function writeClipboardText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy textarea copy for mobile WebViews / restricted contexts.
    }
  }
  if (typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.append(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

export function MobileEditorDesktopGuide({
  href,
  onExplore,
  onCopyFeedback,
}: MobileEditorDesktopGuideProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setCopied(false);
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    };
  }, [href]);

  const handleCopyLink = async () => {
    const ok = await writeClipboardText(href);
    if (ok) {
      setCopied(true);
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        resetTimerRef.current = null;
      }, 2000);
      onCopyFeedback(t('Link copied. Open it on your computer.'), 'info');
    } else {
      onCopyFeedback(t('Could not copy link. Copy the address from your browser bar.'), 'error');
    }
  };

  return (
    <section className="om-mobile-editor-guide" aria-labelledby="om-mobile-editor-guide-title">
      <div className="om-mobile-editor-guide-content">
        <div className="om-mobile-editor-guide-badge" aria-hidden="true">
          <RemixIcon name="computer-line" size={28} />
        </div>
        <h1 id="om-mobile-editor-guide-title" className="om-mobile-editor-guide-title">
          {t('Edit on desktop')}
        </h1>
        <p className="om-mobile-editor-guide-copy">
          {t('The OpenMotion editor works best on a desktop browser. Copy this link to open it on your computer, or return to Explore.')}
        </p>
        <div className="om-mobile-editor-guide-url" title={href}>
          <RemixIcon name="link" size={14} className="om-mobile-editor-guide-url-icon" />
          <span className="om-mobile-editor-guide-url-text">{href}</span>
        </div>
        <div className="om-mobile-editor-guide-actions">
          <Button
            type="button"
            variant="primary"
            size="lg"
            className="om-mobile-editor-guide-action"
            onClick={() => void handleCopyLink()}
          >
            <RemixIcon name={copied ? 'check-line' : 'file-copy-line'} size={16} />
            {t(copied ? 'Link copied' : 'Copy link')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="om-mobile-editor-guide-action"
            onClick={onExplore}
          >
            {t('Back to Explore')}
          </Button>
        </div>
      </div>
    </section>
  );
}
