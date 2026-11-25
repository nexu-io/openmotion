import { Button } from 'open-design-ui/button';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';

export function WorkspaceScopeNotice({ surface }: { surface: 'assets' | 'brand-kits' }) {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const snapshot = collab?.snapshot;
  const active = snapshot?.activeWorkspace;

  if (!collab || !snapshot?.signedIn || active?.workspaceType !== 'team') return null;

  const copy =
    surface === 'assets'
      ? t('Team library for {name} · Uploaded and generated assets are shared with your workspace.', {
          name: active.workspaceName,
        })
      : t('Team Brand Kits for {name} · Shared styles stay available across workspace projects.', {
          name: active.workspaceName,
        });

  return (
    <aside className="om-collab-scope-notice" data-testid={`scope-notice-${surface}`}>
      <span className="om-collab-scope-notice-copy">
        <RemixIcon name="group-line" size={15} />
        <span>{copy}</span>
      </span>
      {snapshot.permissions.canInviteMembers && (
        <Button
          variant="plain"
          type="button"
          className="om-collab-tonal-btn"
          data-compact="true"
          onClick={() => collab.setInviteDialogOpen(true)}
        >
          <span>{t('Invite teammates')}</span>
        </Button>
      )}
    </aside>
  );
}
