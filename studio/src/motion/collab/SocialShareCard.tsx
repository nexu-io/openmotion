import { Button } from 'open-design-ui/button';
import { buildSocialSharePayload, type SocialSharePlatform } from '../../../../shared/social-share';
import { StudioToastViewport } from '../../components/StudioToastViewport';
import { useToast } from '../../hooks/useToast';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { openExternalUrl } from '../../utils/platformHost';

export type SocialShareCardProps = {
  title?: string;
  shareUrl?: string | null;
  onNotify?: (message: string, variant?: 'info' | 'error') => void;
  onShared?: (platform: SocialSharePlatform) => void;
};

export function SocialShareCard({
  title,
  shareUrl,
  onNotify,
  onShared,
}: SocialShareCardProps) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const payload = buildSocialSharePayload({ title, shareUrl, locale });

  const emitNotice = (message: string, variant: 'info' | 'error') => {
    if (onNotify) {
      onNotify(message, variant);
    } else {
      toast.showToast(message, variant === 'error' ? 'error' : 'info');
    }
  };

  const handleCopyCaption = async () => {
    try {
      await navigator.clipboard.writeText(payload.copyText);
      emitNotice(t('Copied share caption'), 'info');
    } catch {
      emitNotice(t('Could not copy share caption'), 'error');
    }
  };

  return (
    <>
      <div className="om-social-share" data-testid="social-share-card">
        <div className="om-social-share-head">
          <div className="om-social-share-title-group">
            <RemixIcon name="share-forward-line" size={14} />
            <strong>{t('Share to social')}</strong>
          </div>
          <Button
            variant="plain"
            type="button"
            className="om-social-share-copy-btn"
            onClick={() => void handleCopyCaption()}
          >
            <RemixIcon name="file-copy-line" size={13} />
            <span>{t('Copy caption')}</span>
          </Button>
        </div>

        <p className="om-social-share-preview">{payload.copyText}</p>

        <div className="om-social-share-grid" role="group" aria-label={t('Social platforms')}>
          {payload.platforms.map(target => (
            <Button
              key={target.platform}
              variant="plain"
              type="button"
              className="om-social-share-btn"
              data-platform={target.platform}
              onClick={() => {
                void openExternalUrl(target.shareUrl);
                onShared?.(target.platform);
              }}
            >
              <RemixIcon name={target.icon} size={15} />
              <span>{t(target.label)}</span>
            </Button>
          ))}
        </div>
      </div>
      {!onNotify && <StudioToastViewport {...toast} />}
    </>
  );
}
