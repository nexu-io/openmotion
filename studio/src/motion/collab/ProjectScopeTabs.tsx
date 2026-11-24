import { Button } from 'open-design-ui/button';
import { useI18n } from '../../i18n/I18n';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';

export type ProjectScopeFilter = 'all' | 'personal' | 'team';

export function filterProjectsByScope<T extends { id: string }>(
  projects: T[],
  scope: ProjectScopeFilter,
  projectMeta: Record<string, { workspaceId: string }> | undefined,
  personalWorkspaceIds: Set<string>,
  teamWorkspaceIds: Set<string>,
): T[] {
  if (scope === 'all' || !projectMeta) return projects;
  return projects.filter(project => {
    const wsId = projectMeta[project.id]?.workspaceId;
    if (scope === 'team') return Boolean(wsId && teamWorkspaceIds.has(wsId));
    return !wsId || personalWorkspaceIds.has(wsId);
  });
}

export function ProjectScopeTabs({
  value,
  onChange,
}: {
  value: ProjectScopeFilter;
  onChange: (next: ProjectScopeFilter) => void;
}) {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const snapshot = collab?.snapshot;
  const hasTeam = Boolean(snapshot?.signedIn && snapshot.workspaces.some(w => w.workspaceType === 'team'));
  if (!hasTeam) return null;

  const teamLabel =
    snapshot?.activeWorkspace?.workspaceType === 'team'
      ? snapshot.activeWorkspace.workspaceName
      : snapshot?.workspaces.find(w => w.workspaceType === 'team')?.workspaceName ?? t('Team');

  return (
    <div className="om-scope-tabs" data-testid="project-scope-tabs" role="group" aria-label={t('Project workspace filter')}>
      <Button
        variant="plain"
        type="button"
        className="om-scope-tab"
        aria-pressed={value === 'all'}
        onClick={() => onChange('all')}
      >
        {t('All')}
      </Button>
      <Button
        variant="plain"
        type="button"
        className="om-scope-tab"
        aria-pressed={value === 'personal'}
        onClick={() => onChange('personal')}
      >
        {t('Personal')}
      </Button>
      <Button
        variant="plain"
        type="button"
        className="om-scope-tab"
        title={teamLabel}
        aria-pressed={value === 'team'}
        onClick={() => onChange('team')}
      >
        {teamLabel}
      </Button>
    </div>
  );
}
