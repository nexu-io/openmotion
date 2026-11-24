import { Button } from 'open-design-ui/button';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';

export function WorkspaceRemovalBoundary() {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const removed = collab?.snapshot?.removedFromWorkspace;
  if (!collab || !removed) return null;

  return (
    <section
      className="om-removal-boundary"
      role="alertdialog"
      aria-modal="true"
      aria-label={t('Workspace access removed')}
      data-testid="workspace-removal-boundary"
    >
      <div className="om-removal-boundary-card">
        <RemixIcon name="shield-check-line" size={28} />
        <h2 className="om-title">{t('You no longer have access to {name}', { name: removed.workspaceName })}</h2>
        <p className="om-muted">
          {t('Your membership in this team workspace ended. Switch back to your personal workspace to continue working safely.')}
        </p>
        <Button
          variant="primary"
          type="button"
          disabled={collab.switching}
          onClick={() => void collab.recoverToPersonal()}
        >
          <span>{t(collab.switching ? 'Switching…' : 'Return to personal workspace')}</span>
        </Button>
      </div>
    </section>
  );
}
