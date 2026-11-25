import { Button } from 'open-design-ui/button';
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from '../../components/ui/Menu';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';

export type ProjectScopeFilter = 'all' | 'personal' | 'team' | `team:${string}`;

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
    if (scope.startsWith('team:')) return wsId === scope.slice(5);
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
  const teamWorkspaces = (snapshot?.workspaces ?? []).filter(
    w => w.workspaceType === 'team' && w.memberStatus !== 'removed',
  );
  const hasTeam = Boolean(snapshot?.signedIn && teamWorkspaces.length > 0);
  if (!hasTeam) return null;

  const primaryTeam =
    snapshot?.activeWorkspace?.workspaceType === 'team'
      ? snapshot.activeWorkspace
      : teamWorkspaces[0] ?? null;

  const selectedTeam = value.startsWith('team:')
    ? teamWorkspaces.find(w => w.workspaceId === value.slice(5)) ?? null
    : null;

  const activeMeta =
    value === 'personal'
      ? { tone: 'personal', icon: 'user-3-line', label: t('Personal') }
      : value === 'team'
        ? {
            tone: 'team',
            icon: 'group-line',
            label:
              teamWorkspaces.length > 1
                ? t('All teams')
                : primaryTeam?.workspaceName ?? t('Team'),
          }
        : value.startsWith('team:')
          ? {
              tone: 'team',
              icon: 'group-line',
              label: selectedTeam?.workspaceName ?? primaryTeam?.workspaceName ?? t('Team'),
            }
          : { tone: 'all', icon: 'stack-line', label: t('All workspaces') };

  return (
    <div className="om-scope-filter-host" data-testid="project-scope-tabs">
      <Menu
        modal={false}
        className="om-scope-filter-menu"
        aria-label={t('Project workspace filter')}
        trigger={
          <Button
            variant="plain"
            type="button"
            className="om-scope-dropdown-trigger"
            aria-label={t('Project workspace filter')}
            title={activeMeta.label}
          >
            <span className="om-scope-icon-chip" data-tone={activeMeta.tone} aria-hidden="true">
              <RemixIcon name={activeMeta.icon} size={13} />
            </span>
            <span className="om-scope-trigger-label">{activeMeta.label}</span>
            <RemixIcon name="arrow-down-s-line" size={14} className="om-scope-trigger-chevron" />
          </Button>
        }
      >
        <MenuRadioGroup value={value} onValueChange={next => onChange(next as ProjectScopeFilter)}>
          <MenuRadioItem value="all" closeOnClick>
            <span className="om-scope-radio-row">
              <span className="om-scope-icon-chip" data-tone="all" aria-hidden="true">
                <RemixIcon name="stack-line" size={13} />
              </span>
              <span className="om-scope-radio-label">{t('All workspaces')}</span>
            </span>
          </MenuRadioItem>
          <MenuRadioItem value="personal" closeOnClick>
            <span className="om-scope-radio-row">
              <span className="om-scope-icon-chip" data-tone="personal" aria-hidden="true">
                <RemixIcon name="user-3-line" size={13} />
              </span>
              <span className="om-scope-radio-label">{t('Personal')}</span>
            </span>
          </MenuRadioItem>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>{t('Team workspaces')}</MenuGroupLabel>
            {teamWorkspaces.length > 1 ? (
              <>
                <MenuRadioItem value="team" closeOnClick>
                  <span className="om-scope-radio-row">
                    <span className="om-scope-icon-chip" data-tone="team" aria-hidden="true">
                      <RemixIcon name="group-line" size={13} />
                    </span>
                    <span className="om-scope-radio-label">{t('All teams')}</span>
                  </span>
                </MenuRadioItem>
                {teamWorkspaces.map(ws => (
                  <MenuRadioItem key={ws.workspaceId} value={`team:${ws.workspaceId}`} closeOnClick>
                    <span className="om-scope-radio-row">
                      <span className="om-scope-icon-chip" data-tone="team" aria-hidden="true">
                        <RemixIcon name="group-line" size={13} />
                      </span>
                      <span className="om-scope-radio-label">{ws.workspaceName}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </>
            ) : (
              <MenuRadioItem value="team" closeOnClick>
                <span className="om-scope-radio-row">
                  <span className="om-scope-icon-chip" data-tone="team" aria-hidden="true">
                    <RemixIcon name="group-line" size={13} />
                  </span>
                  <span className="om-scope-radio-label">
                    {primaryTeam?.workspaceName ?? t('Team')}
                  </span>
                </span>
              </MenuRadioItem>
            )}
          </MenuGroup>
        </MenuRadioGroup>
      </Menu>
    </div>
  );
}
