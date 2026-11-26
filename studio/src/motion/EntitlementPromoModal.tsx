import { useEffect, useRef, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { useI18n } from '../i18n/I18n';
import { buildLoginUrl } from './AccountSettings';
import { campaignPricingUrl, newCampaignEntryId, useBlackFridayActive } from './campaignAttribution';
import {
  entitlementAttributionFields,
  markExternalCheckoutPending,
  type EntitlementAttributionContext,
  type EntitlementHookId,
  type EntitlementModalMode,
} from './entitlementModalBus';
import { PromoClip, usePromoPlayback } from './EntitlementPromoMedia';
import { trackMotion } from './tracking';
import './EntitlementPromoModal.css';

const MEDIA_BASE = '/editor-assets/epm-';
const mediaUrl = (name: string) => `${MEDIA_BASE}${name}`;
/** Show the starter trial credits banner for guest sign-in (without image-generation claims). */
const SHOW_STARTER_GIFT_BAR = true;

const LEFT_TILES = [
  { v: 'bar-chart-skyline.webm', c: 'Data motion' },
  { i: 'game-lanternfall-thumb.webp', c: 'Games' },
  { v: 'motion-hero.mp4', c: 'Promo film' },
  { v: 'remix-linear-loops.mp4', c: 'Viral remix' },
] as const;

const RIGHT_TILES = [
  { v: 'glide.webm', c: 'Brand film' },
  { i: 'graphic-1-thumb.webp', c: 'Product poster' },
  { v: 'gradients-haze.webm', c: 'Motion backdrop' },
  { v: 'jake-figma-draw.mp4', c: 'Product demo' },
  { i: 'game-style-voxel.webp', c: '3D style' },
] as const;

const OpenDesignLogo = () => (
  <svg width="24" height="24" viewBox="0 0 291 291" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M145.5 0C225.857 0 291 65.1426 291 145.5C291 225.857 225.857 291 145.5 291H19.3581C8.64385 291 0.000681982 282.358 0.000616442 271.644C0.000417939 239.193 1.50624e-09 174.523 0 145.5C0 65.1426 65.1426 5.2069e-06 145.5 0ZM145.501 29.1004C81.2147 29.1004 29.1004 81.2147 29.1004 145.501C29.1005 209.786 81.2147 261.9 145.501 261.9C209.786 261.9 261.9 209.786 261.9 145.501C261.9 81.2147 209.786 29.1004 145.501 29.1004Z"
      fill="currentColor"
    />
    <path
      d="M137.934 215.04L94.3119 100.247C92.9002 96.5317 96.5286 92.8895 100.219 94.3172L215.067 138.749C219.793 140.578 218.491 147.633 213.427 147.633H146.769V213.4C146.769 218.499 139.744 219.804 137.934 215.04Z"
      fill="currentColor"
    />
  </svg>
);

export interface EntitlementPromoModalProps {
  open: boolean;
  mode: EntitlementModalMode;
  hookId: EntitlementHookId;
  entryId?: string;
  attribution?: EntitlementAttributionContext;
  returnTo?: string;
  onClose: () => void;
}

export function EntitlementPromoModal({
  open,
  mode,
  hookId,
  entryId: initialEntryId,
  attribution,
  returnTo,
  onClose,
}: EntitlementPromoModalProps) {
  const { t, locale } = useI18n();
  const blackFridayActive = useBlackFridayActive();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [entryId, setEntryId] = useState(() => initialEntryId ?? newCampaignEntryId());
  const [busy, setBusy] = useState(false);
  const playable = usePromoPlayback(dialogRef, open);
  const attrFields = entitlementAttributionFields(attribution);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      const nextEntry = initialEntryId ?? newCampaignEntryId();
      setEntryId(nextEntry);
      if (!dialog.open) dialog.showModal();
      void trackMotion('surface_view', {
        page_name: 'studio',
        area: 'entitlement_modal',
        element: 'modal',
        hook_id: hookId,
        entry_id: nextEntry,
        ...attrFields,
      });
    } else {
      if (dialog.open) dialog.close();
      setBusy(false);
    }
  }, [open, mode, hookId, initialEntryId]);

  if (!open) return null;

  const isGuest = mode === 'guest';
  const renderClip = (file: string, priority: 'high' | 'auto' | 'low' = 'auto', slot = file) => (
    <PromoClip src={mediaUrl(file)} slot={slot} playable={playable.has(slot)} priority={priority} />
  );

  const handleClose = () => {
    void trackMotion('ui_click', {
      page_name: 'studio',
      area: 'entitlement_modal',
      element: 'close_detail',
      hook_id: hookId,
      entry_id: entryId,
      ...attrFields,
    });
    onClose();
  };

  const handlePrimaryCta = () => {
    if (busy) return;
    setBusy(true);
    void trackMotion('ui_click', {
      page_name: 'studio',
      area: 'entitlement_modal',
      element: isGuest ? 'sign_in' : 'view_plans',
      hook_id: hookId,
      entry_id: entryId,
      ...attrFields,
    });
    if (isGuest) {
      window.location.assign(buildLoginUrl(returnTo, { hookId, entryId }));
      return;
    }
    markExternalCheckoutPending(hookId, entryId, attribution);
    const pricingUrl = campaignPricingUrl(locale, 'openmotion_header_pricing', entryId);
    const page = window.open(pricingUrl, '_blank');
    if (page) page.opener = null;
    setBusy(false);
    onClose();
  };

  const renderSide = (list: ReadonlyArray<{ v?: string; i?: string; c: string }>, side: 'left' | 'right') => (
    <div className={`om-epm-side ${side === 'right' ? 'is-right' : ''}`} aria-hidden="true">
      <div className="om-epm-track">
        {[...list, ...list].map((item, idx) => (
          <div className="om-epm-tile" key={`${side}-${idx}`}>
            {item.v ? (
              renderClip(item.v, 'low', `${side}-${idx}`)
            ) : (
              <img src={mediaUrl(item.i!)} alt="" loading="lazy" fetchPriority="low" />
            )}
            <span className="om-epm-chip">{t(item.c)}</span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <dialog
      ref={dialogRef}
      className="om-epm-dialog"
      onCancel={e => { e.preventDefault(); handleClose(); }}
    >
      <div className="om-epm-mask" onClick={e => { if (e.target === e.currentTarget) handleClose(); }}>
        <div className="om-epm-modal" role="dialog" aria-modal="true" aria-labelledby="om-epm-title">
          {renderSide(LEFT_TILES, 'left')}
          <div className="om-epm-main">
            <Button variant="plain" type="button" className="om-epm-close" onClick={handleClose} aria-label={t('Close')}>×</Button>

                <div className="om-epm-hero">
                  <div className="om-epm-mark"><OpenDesignLogo /><span>OpenDesign</span></div>
                  <h1 className="om-epm-h1" id="om-epm-title">
                    {isGuest ? (
                      <>{t('Sign in to continue')} <span className="om-epm-pl">{t('creating')}</span></>
                    ) : (
                      <>{t('Upgrade to OpenDesign')} <span className="om-epm-pl">Plus</span></>
                    )}
                  </h1>

                  {isGuest ? (
                    SHOW_STARTER_GIFT_BAR ? (
                      <div className="om-epm-giftbar">
                        <div className="om-epm-gm">
                          <b>{t('Sign in for starter trial credits')}</b>
                          <span>{t('Create your first game, website, or motion video in one prompt')}</span>
                        </div>
                        <div className="om-epm-fan">
                          <img src={mediaUrl('graphic-1.webp')} alt="" />
                          <img src={mediaUrl('game-setting-cyberpunk.webp')} alt="" />
                          <img src={mediaUrl('graphic-2.webp')} alt="" />
                        </div>
                      </div>
                    ) : null
                  ) : blackFridayActive ? (
                    <div className="om-epm-price"><b>$14</b> {t('/mo · annual promo')}</div>
                  ) : null}

                  <Button variant="plain" type="button" className="om-epm-cta" disabled={busy} onClick={() => handlePrimaryCta()}>
                    {busy ? t('Connecting…') : isGuest ? t('Sign in now') : t('Upgrade now')}
                  </Button>
                </div>

                <div className="om-epm-grid">
                  <div className="om-epm-card">
                    <div className="om-epm-vis">{renderClip('hadal-play.mp4', 'high')}</div>
                    <h4>{t('Playable games')}</h4>
                    <p>{t('One prompt, playable on mobile')}</p>
                  </div>
                  <div className="om-epm-card">
                    <div className="om-epm-vis"><img className="om-epm-kb" src={mediaUrl('card-media.webp')} fetchPriority="high" loading="lazy" alt="" /></div>
                    <h4>{t('Images, video & audio')}</h4>
                    <p>{t('Covers, characters, promos & music')}</p>
                  </div>
                  <div className="om-epm-card">
                    <div className="om-epm-vis">{renderClip('top1-figma.mp4')}</div>
                    <h4>{t('Remix viral videos')}</h4>
                    <p>{t('Paste a link to recreate & export MP4')}</p>
                  </div>
                  <div className="om-epm-card">
                    <div className="om-epm-vis is-crop">{renderClip('happy-faces-landing-page.webm')}</div>
                    <h4>{t('Prototypes & websites')}</h4>
                    <p>{t('Build and share with one click')}</p>
                  </div>

                  <div className="om-epm-models">
                    <div className="om-epm-strip">
                      <div className="om-epm-strip-cell">
                        <div className="om-epm-code">{`// Claude Opus 5.5\nconst game = new Game({\n  title: 'Abyss Run',\n  player: Submarine(),\n});\ngame.start();`}</div>
                        <span>{t('Code')}</span>
                      </div>
                      <div className="om-epm-strip-cell">
                        <img className="om-epm-kb" src={mediaUrl('strip-image-thumb.webp')} loading="lazy" alt="" />
                        <span>{t('Image')}</span>
                      </div>
                      <div className="om-epm-strip-cell">
                        {renderClip('spotify-next-level.mp4')}
                        <span>{t('Video')}</span>
                      </div>
                      <div className="om-epm-strip-cell om-epm-strip-audio">
                        <div className="om-epm-wave">
                          {Array.from({ length: 14 }, (_, i) => (
                            <i key={i} style={{ animationDelay: `${(i % 7) * -0.14}s` }} />
                          ))}
                        </div>
                        <span>{t('Audio')}</span>
                      </div>
                    </div>
                    <div className="om-epm-mlist">
                      <h4><em>46</em> {t('top AI models')}</h4>
                      <div className="om-epm-mrow"><span>{t('Flagship')}</span><div>Claude Fable 5.2, GPT-6.2 Astra</div><span className="om-epm-st is-pro">Pro</span></div>
                      <div className="om-epm-mrow"><span>{t('Chat & Code')}</span><div>{t('Claude Opus 5.5 & 29 more')}</div><span className="om-epm-st is-plus">Plus</span></div>
                      <div className="om-epm-mrow"><span>{t('Image')}</span><div>{t('Seedream 5.5, GPT Image 2.6 & 6 more')}</div><span className="om-epm-st is-plus">Plus</span></div>
                      <div className="om-epm-mrow"><span>{t('Video')}</span><div>{t('SeeDance 2.5, Wan 2.7 & 3 more')}</div><span className="om-epm-st is-plus">Plus</span></div>
                      <div className="om-epm-mrow"><span>{t('Audio & Music')}</span><div>{t('ElevenLabs V3, Music V2 & 3 more')}</div><span className="om-epm-st is-plus">Plus</span></div>
                    </div>
                  </div>

                  <div className="om-epm-card is-res">
                    <div className="om-epm-vis">{renderClip('themes-animated-gallery.webm')}</div>
                    <h4><span className="om-epm-num">291</span> {t('Motion templates')}</h4>
                    <p>{t('Ready to edit & export')}</p>
                  </div>
                  <div className="om-epm-card is-res">
                    <div className="om-epm-vis">{renderClip('blurry-text-spin.webm')}</div>
                    <h4><span className="om-epm-num">104</span> {t('Skills')}</h4>
                    <p>{t('Guided Agent workflows')}</p>
                  </div>
                  <div className="om-epm-card is-res">
                    <div className="om-epm-vis">{renderClip('animated-ui-kit.webm')}</div>
                    <h4><span className="om-epm-num">890+</span> {t('Creative assets')}</h4>
                    <p>{t('Motion components & clips')}</p>
                  </div>
                  <div className="om-epm-card is-res">
                    <div className="om-epm-vis">{renderClip('type-trail.webm')}</div>
                    <h4><span className="om-epm-num">100+</span> {t('Brand Kit')}</h4>
                    <p>{t('Colors, typography & logos')}</p>
                  </div>
                </div>
              </div>
              {renderSide(RIGHT_TILES, 'right')}
        </div>
      </div>
    </dialog>
  );
}
