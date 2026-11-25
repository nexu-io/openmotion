import { useEffect, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { useOptionalGrowthSurfaces } from './GrowthSurfacesContext';

export function WhatsNewCard() {
  const { t } = useI18n();
  const growth = useOptionalGrowthSurfaces();
  const [imageError, setImageError] = useState(false);

  const card = growth?.whatsNewCard ?? null;
  const open = Boolean(growth?.whatsNewOpen && card);

  useEffect(() => {
    setImageError(false);
  }, [card?.id, card?.imageUrl]);

  if (!growth || !open || !card) return null;

  return (
    <aside
      className="om-whats-new-card om-selection-panel"
      data-testid="whats-new-card"
      aria-label={t("What's new")}
    >
      <header className="om-whats-new-head">
        <span className="om-whats-new-eyebrow">
          <RemixIcon name="sparkling-fill" size={14} />
          <span>{t("What's new")}</span>
          <span className="om-collab-pill">v{card.version}</span>
        </span>
        <IconButton
          variant="ghost"
          size="sm"
          type="button"
          aria-label={t('Close')}
          data-testid="whats-new-close"
          onClick={growth.dismissWhatsNew}
          icon={<RemixIcon name="close-line" size={14} />}
        />
      </header>

      {card.imageUrl && !imageError && (
        <img
          src={card.imageUrl}
          alt=""
          className="om-whats-new-cover"
          onError={() => setImageError(true)}
        />
      )}

      <div className="om-whats-new-body">
        <strong className="om-whats-new-title">{card.title}</strong>
        {card.notes.length > 0 && (
          <ul className="om-whats-new-list">
            {card.notes.map((note, index) => (
              <li key={index} className="om-whats-new-list-item">
                <RemixIcon name="check-line" size={13} />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="om-whats-new-footer">
        <Button
          variant="plain"
          size="sm"
          type="button"
          className="om-collab-tonal-btn"
          data-testid="whats-new-dismiss"
          onClick={growth.dismissWhatsNew}
        >
          <span>{t('Got it')}</span>
        </Button>
        {card.linkUrl && (
          <Button
            variant="primary"
            size="sm"
            type="button"
            data-testid="whats-new-cta"
            onClick={growth.openWhatsNewLink}
          >
            <span>{card.ctaLabel || t('Learn more')}</span>
            <RemixIcon name="external-link-line" size={13} />
          </Button>
        )}
      </footer>
    </aside>
  );
}
