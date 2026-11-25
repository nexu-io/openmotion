import { useEffect, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { useOptionalGrowthSurfaces } from './GrowthSurfacesContext';

function splitHighlight(note: string): { lead: string; detail: string } | null {
  const dashIdx = note.indexOf(' — ');
  if (dashIdx > 0 && dashIdx <= 28) {
    return { lead: note.slice(0, dashIdx).trim(), detail: note.slice(dashIdx + 3).trim() };
  }
  const zhColonIdx = note.indexOf('：');
  if (zhColonIdx > 0 && zhColonIdx <= 18) {
    return { lead: note.slice(0, zhColonIdx).trim(), detail: note.slice(zhColonIdx + 1).trim() };
  }
  return null;
}

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
          <span className="om-whats-new-badge-icon" aria-hidden="true">
            <RemixIcon name="sparkling-fill" size={13} />
          </span>
          <span className="om-whats-new-eyebrow-label">{t("What's new")}</span>
          <span className="om-whats-new-version">v{card.version}</span>
        </span>
        <IconButton
          variant="ghost"
          size="sm"
          type="button"
          className="om-whats-new-close"
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
        <h3 className="om-whats-new-title">{card.title}</h3>
        {card.notes.length > 0 && (
          <ul className="om-whats-new-list">
            {card.notes.map((note, index) => {
              const split = splitHighlight(note);
              return (
                <li key={index} className="om-whats-new-list-item">
                  <span className="om-whats-new-dot" aria-hidden="true" />
                  <span className="om-whats-new-item-copy">
                    {split ? (
                      <>
                        <strong className="om-whats-new-item-lead">{split.lead}</strong>
                        <span className="om-whats-new-item-detail">{split.detail}</span>
                      </>
                    ) : (
                      note
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="om-whats-new-footer">
        <Button
          variant="plain"
          type="button"
          className="om-whats-new-dismiss"
          data-testid="whats-new-dismiss"
          onClick={growth.dismissWhatsNew}
        >
          <span>{t('Got it')}</span>
        </Button>
        {card.linkUrl && (
          <Button
            variant="primary"
            type="button"
            className="om-whats-new-cta"
            data-testid="whats-new-cta"
            onClick={growth.openWhatsNewLink}
          >
            <span>{card.ctaLabel || t('Learn more')}</span>
            <RemixIcon name="arrow-right-up-line" size={14} />
          </Button>
        )}
      </footer>
    </aside>
  );
}
