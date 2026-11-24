import { Button } from 'open-design-ui/button';
import { useI18n } from '../i18n/I18n';

export function NotFoundPage({ onExplore }: { onExplore: () => void }) {
  const { t } = useI18n();
  return (
    <section className="om-not-found" aria-labelledby="om-not-found-title">
      <div className="om-not-found-content">
        <span className="om-not-found-code" aria-hidden="true">404</span>
        <h1 id="om-not-found-title" className="om-not-found-title">
          {t('Page not found')}
        </h1>
        <p className="om-not-found-copy">
          {t('The page you are looking for does not exist or is no longer available.')}
        </p>
        <div className="om-not-found-actions">
          <Button variant="primary" size="lg" className="om-not-found-action" onClick={onExplore}>
            {t('Back to Explore')}
            <span className="om-not-found-arrow" aria-hidden="true">→</span>
          </Button>
        </div>
      </div>
    </section>
  );
}
