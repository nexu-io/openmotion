import { Fragment, useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button } from 'open-design-ui/button';
import { useI18n } from '../i18n/I18n';
import { isDesktopApp, openBillingAndRefreshOnFocus } from '../utils/platformHost';
import { useAccountSummary } from './AccountSettings';
import magi2PosterUrl from './black-friday-modal/magi2-planet-poster.webp';
import magi2VideoUrl from './black-friday-modal/magi2-planet-6s.mp4';
import { blackFridayActive, newCampaignEntryId, pricingLinkTargetProps } from './campaignAttribution';
import { markExternalCheckoutPending } from './entitlementModalBus';
import type { CreativePage } from './exploreTracking';
import {
  MAGI2_MODAL_AUDIENCE_TIMEOUT_MS,
  MAGI2_MODAL_CAMPAIGN_ID,
  MAGI2_MODAL_COPY,
  buildMagi2ConsolePlanUrl,
  classifyMagi2Audience,
  isMagi2PreviewForced,
  isMagi2SuppressedByFatigue,
  markMagi2ModalSeen,
  readMagi2CountdownParts,
  setMagi2ModalOpenSignal,
} from './magi2LaunchModalConfig';
import styles from './Magi2LaunchModal.module.css';
import { trackMotion } from './tracking';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function Magi2LaunchModal({
  trackingPage,
  suppressed = false,
}: {
  trackingPage: CreativePage;
  suppressed?: boolean;
}) {
  const { locale } = useI18n();
  const forcePreview = isMagi2PreviewForced();
  const [initiallySuppressed] = useState(() => (forcePreview ? false : isMagi2SuppressedByFatigue()));
  const [dismissed, setDismissed] = useState(initiallySuppressed);
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [entryId, setEntryId] = useState(newCampaignEntryId);
  const [audienceTimedOut, setAudienceTimedOut] = useState(false);

  const canCheckAudience = !dismissed && !suppressed && (forcePreview || blackFridayActive());
  const { account, error } = useAccountSummary({ eager: canCheckAudience && !forcePreview });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hrsRef = useRef<HTMLSpanElement | null>(null);
  const minRef = useRef<HTMLSpanElement | null>(null);
  const secRef = useRef<HTMLSpanElement | null>(null);
  const msRef = useRef<HTMLSpanElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const settledRef = useRef(false);

  // Enforce the shared 5-second fail-closed audience deadline.
  useEffect(() => {
    if (!canCheckAudience || forcePreview || settledRef.current) return;
    const timer = window.setTimeout(() => {
      if (!settledRef.current) {
        settledRef.current = true;
        setAudienceTimedOut(true);
      }
    }, MAGI2_MODAL_AUDIENCE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [canCheckAudience, forcePreview]);

  const closeModal = useCallback(
    (trackClose = false, method: 'pointer' | 'keyboard' = 'pointer') => {
      setDismissed(true);
      if (!forcePreview) markMagi2ModalSeen();
      setOpen(false);
      setPlaying(false);
      try { videoRef.current?.pause(); } catch { /* ignore */ }
      if (trackClose) {
        void trackMotion('ui_click', {
          page_name: trackingPage,
          area: 'campaign_banner',
          element: 'close_banner',
          campaign_id: MAGI2_MODAL_CAMPAIGN_ID,
          hook_id: 'bf_banner',
          interaction_method: method,
        });
      }
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = window.setTimeout(
        () => setMounted(false),
        prefersReducedMotion() ? 0 : 280,
      );
    },
    [forcePreview, trackingPage],
  );

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  // Decide eligibility once account resolves within the 5s window (or immediately when preview is forced).
  useEffect(() => {
    if (!canCheckAudience) {
      if (mounted) {
        setOpen(false);
        setPlaying(false);
        setMounted(false);
      }
      return;
    }

    if (forcePreview) {
      if (mounted) return;
      const timer = window.setTimeout(() => {
        settledRef.current = true;
        setMounted(true);
      }, 120);
      return () => window.clearTimeout(timer);
    }

    if (audienceTimedOut || error) {
      settledRef.current = true;
      return;
    }

    const status = classifyMagi2Audience(account);
    if (status === 'paid') {
      settledRef.current = true;
      if (mounted) closeModal(false);
      return;
    }

    if ((status === 'guest' || status === 'free') && !settledRef.current) {
      settledRef.current = true;
      markMagi2ModalSeen();
      setMounted(true);
      void trackMotion('surface_view', {
        page_name: trackingPage,
        area: 'campaign_banner',
        element: 'modal',
        campaign_id: MAGI2_MODAL_CAMPAIGN_ID,
        hook_id: 'bf_banner',
      });
    }
  }, [account, audienceTimedOut, canCheckAudience, closeModal, error, forcePreview, mounted, trackingPage]);

  useEffect(() => {
    setMagi2ModalOpenSignal(mounted);
    return () => setMagi2ModalOpenSignal(false);
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeModal(true, 'keyboard');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mounted, closeModal]);

  useEffect(() => {
    if (!mounted) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const renderCountdown = () => {
      const [h, m, s, cs] = readMagi2CountdownParts(Date.now(), forcePreview);
      if (hrsRef.current) hrsRef.current.textContent = String(h).padStart(2, '0');
      if (minRef.current) minRef.current.textContent = String(m).padStart(2, '0');
      if (secRef.current) secRef.current.textContent = String(s).padStart(2, '0');
      if (msRef.current) msRef.current.textContent = String(cs).padStart(2, '0');
    };

    const playVideoIfAllowed = () => {
      const video = videoRef.current;
      if (!video || prefersReducedMotion() || document.hidden) return;
      try {
        const result = video.play();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch { /* ignore */ }
    };

    renderCountdown();

    const rafId = window.requestAnimationFrame(() => {
      const reduced = prefersReducedMotion();
      setOpen(true);
      setPlaying(!reduced && !document.hidden);
      playVideoIfAllowed();
    });

    const intervalMs = prefersReducedMotion() ? 1000 : 40;
    const clockTimer = window.setInterval(() => {
      if (document.hidden) return;
      if (!forcePreview && !blackFridayActive()) {
        closeModal(false);
        return;
      }
      renderCountdown();
    }, intervalMs);

    const onVisibilityChange = () => {
      const video = videoRef.current;
      if (document.hidden) {
        setPlaying(false);
        try { video?.pause(); } catch { /* ignore */ }
      } else {
        setPlaying(!prefersReducedMotion());
        playVideoIfAllowed();
        renderCountdown();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearInterval(clockTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      try { videoRef.current?.pause(); } catch { /* ignore */ }
      document.body.style.overflow = previousOverflow;
    };
  }, [mounted, forcePreview, closeModal]);

  if (!mounted || typeof document === 'undefined') {
    return null;
  }

  const copy = MAGI2_MODAL_COPY[locale] ?? MAGI2_MODAL_COPY.en;
  const ctaHref = buildMagi2ConsolePlanUrl(entryId, { consoleUrl: account?.consoleUrl });
  const [initH, initM, initS, initCs] = readMagi2CountdownParts(Date.now(), forcePreview);

  const handleCtaClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const clickedEntryId = entryId;
    const method = event.detail === 0 ? ('keyboard' as const) : ('pointer' as const);
    markExternalCheckoutPending('bf_banner', clickedEntryId);
    void trackMotion('ui_click', {
      page_name: trackingPage,
      area: 'campaign_banner',
      element: 'claim_offer',
      campaign_id: MAGI2_MODAL_CAMPAIGN_ID,
      entry_id: clickedEntryId,
      hook_id: 'bf_banner',
      interaction_method: method,
    });
    const targetUrl = buildMagi2ConsolePlanUrl(clickedEntryId, { consoleUrl: account?.consoleUrl });
    event.currentTarget.href = targetUrl;
    window.setTimeout(() => setEntryId(newCampaignEntryId()), 0);
    if (isDesktopApp() && (event.button === 0 || event.button === 1)) {
      event.preventDefault();
      void openBillingAndRefreshOnFocus(targetUrl);
    }
    closeModal(false);
  };

  return createPortal(
    <div
      className={styles.backdrop}
      data-open={open ? 'true' : 'false'}
      data-testid="magi2-launch-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={copy.dialogLabel}
      aria-labelledby="om-magi2-modal-heading"
      onClick={event => {
        if (event.target === event.currentTarget) closeModal(true, 'pointer');
      }}
    >
      <section
        className={styles.modal}
        data-script={copy.script}
        data-playing={playing ? 'true' : 'false'}
        data-testid="magi2-launch-modal"
      >
        <div className={styles.mediaPane}>
          <div className={styles.videoStage}>
            <video
              ref={videoRef}
              className={styles.video}
              data-testid="magi2-launch-modal-video"
              src={magi2VideoUrl}
              poster={magi2PosterUrl}
              muted
              loop
              playsInline
              preload="metadata"
              tabIndex={-1}
            />
            <div className={styles.videoScrim} aria-hidden="true" />
          </div>
        </div>

        <div className={styles.contentPane}>
          <Button
            variant="plain"
            type="button"
            className={styles.close}
            aria-label={copy.closeLabel}
            data-testid="magi2-launch-modal-close"
            onClick={event => closeModal(true, event.detail === 0 ? 'keyboard' : 'pointer')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </Button>

          <div className={styles.heroCopy}>
            <div className={styles.eyebrow} data-testid="magi2-launch-modal-eyebrow">
              {copy.eyebrow}
            </div>
            <h2 id="om-magi2-modal-heading" className={styles.headline} data-testid="magi2-launch-modal-headline">
              {copy.headline}
            </h2>
            <p className={styles.desc} data-testid="magi2-launch-modal-desc">
              {copy.description.map((segment, index) =>
                segment.strong ? (
                  <strong key={`${index}-${segment.text}`}>{segment.text}</strong>
                ) : (
                  <Fragment key={`${index}-${segment.text}`}>{segment.text}</Fragment>
                ),
              )}
            </p>
          </div>

          <div className={styles.actionGroup}>
            <div className={styles.ctaStack}>
              <a
                className={styles.cta}
                href={ctaHref}
                data-testid="magi2-launch-modal-cta"
                {...pricingLinkTargetProps()}
                onClick={handleCtaClick}
                onAuxClick={event => {
                  if (event.button === 1) handleCtaClick(event);
                }}
              >
                <span className={styles.ctaText}>{copy.cta}</span>
                <svg
                  className={styles.ctaArrow}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M5 12h14m-6-6 6 6-6 6" />
                </svg>
              </a>
            </div>

            <time
              className={styles.countdown}
              data-testid="magi2-launch-modal-clock"
              role="timer"
              aria-live="off"
            >
              <span className={styles.countdownLabel}>{copy.countdownPrefix}</span>
              <span className={styles.countdownTime}>
                <span className={styles.digitSeg} ref={hrsRef}>{String(initH).padStart(2, '0')}</span>
                <span className={styles.colon} aria-hidden="true">:</span>
                <span className={styles.digitSeg} ref={minRef}>{String(initM).padStart(2, '0')}</span>
                <span className={styles.colon} aria-hidden="true">:</span>
                <span className={styles.digitSeg} ref={secRef}>{String(initS).padStart(2, '0')}</span>
                <span className={styles.msGroup}>
                  <span className={styles.dot} aria-hidden="true">.</span>
                  <span className={styles.digitSeg} ref={msRef} data-testid="magi2-launch-modal-ms">{String(initCs).padStart(2, '0')}</span>
                </span>
              </span>
            </time>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
