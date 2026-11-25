import { Button } from 'open-design-ui/button';
import { StudioToastViewport } from '../../components/StudioToastViewport';
import { useToast } from '../../hooks/useToast';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { openExternalUrl } from '../../utils/platformHost';
import { discord, feishu } from '../CommunityLink';
import { GITHUB_REPOSITORY } from '../githubRepository';
import { CollabDialog } from './CollabDialog';
import { useOptionalGrowthSurfaces } from './GrowthSurfacesContext';

type SupportChannelItem = {
  id: 'feishu' | 'discord' | 'github';
  label: string;
  description: string;
  href: string;
  iconSrc?: string;
};

export function SupportDialog() {
  const { t, locale } = useI18n();
  const growth = useOptionalGrowthSurfaces();
  const toast = useToast();

  const open = Boolean(growth?.supportDialogOpen);
  const context = growth?.supportContext ?? null;
  const isZh = locale.toLowerCase().startsWith('zh');

  const channels: SupportChannelItem[] = [
    {
      id: 'feishu',
      label: t('Feishu group'),
      description: t('Join the community chat for quick troubleshooting.'),
      href: feishu.href,
      iconSrc: feishu.icon,
    },
    {
      id: 'discord',
      label: discord.platform,
      description: t('Ask questions and share reproduction steps in Discord.'),
      href: discord.href,
      iconSrc: discord.icon,
    },
    {
      id: 'github',
      label: t('GitHub Issues'),
      description: t('File a bug report with clear reproduction details.'),
      href: `${GITHUB_REPOSITORY}/issues/new`,
    },
  ];

  const orderedChannels = isZh
    ? channels
    : [channels[1], channels[0], channels[2]];

  const handleCopyError = async () => {
    if (!context?.summary && !context?.detail) return;
    const lines = [
      context.source ? `[${context.source}]` : null,
      context.summary ?? null,
      context.detail && context.detail !== context.summary ? context.detail : null,
      `Locale: ${locale}`,
    ].filter((line): line is string => Boolean(line && line.trim()));
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast.showToast(t('Error details copied'), 'info');
    } catch {
      toast.showToast(t('Could not copy error details'), 'error');
    }
  };

  return (
    <>
      <CollabDialog
        open={open}
        title={t('Contact support')}
        description={t('Reach the OpenMotion community or include technical details when asking for help.')}
        onClose={() => growth?.closeSupportDialog()}
        className="om-collab-dialog-wide om-support-dialog"
      >
        <div className="om-support-dialog-content">
          {(context?.summary || context?.detail) && (
            <div className="om-support-context" data-testid="support-error-context">
              <div className="om-support-context-head">
                <span className="om-support-context-source">
                  {context.source ? t(context.source) : t('Recent error')}
                </span>
                <Button
                  variant="plain"
                  type="button"
                  className="om-support-copy-btn"
                  onClick={() => void handleCopyError()}
                >
                  <RemixIcon name="file-copy-line" size={14} />
                  <span>{t('Copy error details')}</span>
                </Button>
              </div>
              {context.summary && <p className="om-support-context-summary">{context.summary}</p>}
              {context.detail && context.detail !== context.summary && (
                <p className="om-support-context-detail">{context.detail}</p>
              )}
            </div>
          )}

          <div className="om-support-channels" role="list" aria-label={t('Support channels')}>
            {orderedChannels.map(channel => (
              <Button
                key={channel.id}
                variant="plain"
                type="button"
                role="listitem"
                className="om-support-channel-btn"
                onClick={() => void openExternalUrl(channel.href)}
              >
                <span className="om-support-channel-leading" aria-hidden="true">
                  {channel.iconSrc ? (
                    <img src={channel.iconSrc} alt="" width={18} height={18} />
                  ) : (
                    <RemixIcon name="customer-service-2-line" size={18} />
                  )}
                </span>
                <span className="om-support-channel-copy">
                  <strong>{channel.label}</strong>
                  <span>{channel.description}</span>
                </span>
                <RemixIcon name="external-link-line" size={15} className="om-support-channel-ext" />
              </Button>
            ))}
          </div>
        </div>
      </CollabDialog>
      <StudioToastViewport {...toast} />
    </>
  );
}
