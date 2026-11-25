import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import type {
  UnifiedWorkspaceProject,
  UnifiedWorkspaceProjectsResponse,
  WorkspaceProjectKind,
} from '../../../shared/workspace-collab';
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from '../components/ui/Menu';
import { Popover } from '../components/ui/Popover';
import { Skeleton } from '../components/ui/Skeleton';
import { designClient } from '../design/designClient';
import { ScaledPreviewThumb } from '../design/ScaledPreviewThumb';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { CollabDialog } from './collab/CollabDialog';
import { gatewayRequest } from './gatewayClient';
import { LibraryHubNav } from './LibraryHubNav';
import { motionApi } from './useWorkspace';
import { useOptionalWorkspaceCollab } from './WorkspaceCollabContext';
import type { ProjectHubScope, ProjectHubType } from './workspacePageRouting';
import './projectsPage.css';

export type ProjectsPageProps = {
  active?: boolean;
  scope?: ProjectHubScope | null;
  projectType?: ProjectHubType | null;
  manageProject?: string | null;
  onFilterChange?: (patch: {
    projectScope?: ProjectHubScope | null;
    projectType?: ProjectHubType | null;
    manageProject?: string | null;
  }) => void;
  onOpenMotionProject: (id: string) => void | Promise<unknown>;
  onOpenDesignProject: (id: string) => void;
  onOpenGameProject: (id: string) => void;
  onCreateMotionProject?: () => void;
  onCreateGameProject?: () => void;
  onImportMotionZip?: () => void;
};

type IconTone =
  | 'all'
  | 'personal'
  | 'team'
  | 'motion'
  | 'design'
  | 'game'
  | 'live'
  | 'warning'
  | 'danger'
  | 'import';

type SortOption = 'recent' | 'name';

const PROJECT_TYPE_OPTIONS: ReadonlyArray<{
  id: Exclude<ProjectHubType, 'trash'>;
  label: string;
  icon: string;
  tone: IconTone;
}> = [
  { id: 'all', label: 'All types', icon: 'apps-2-line', tone: 'all' },
  { id: 'motion', label: 'Motion', icon: 'clapperboard-fill', tone: 'motion' },
  { id: 'design', label: 'Design', icon: 'palette-fill', tone: 'design' },
  { id: 'game', label: 'Game', icon: 'gamepad-fill', tone: 'game' },
];

const SORT_OPTIONS: ReadonlyArray<{ id: SortOption; label: string; icon: string }> = [
  { id: 'recent', label: 'Recently updated', icon: 'time-line' },
  { id: 'name', label: 'Name (A–Z)', icon: 'font-size' },
];

const KIND_INFO: Record<
  WorkspaceProjectKind,
  { label: string; icon: string; tone: IconTone; caption: string }
> = {
  motion: { label: 'Motion', icon: 'clapperboard-fill', tone: 'motion', caption: 'Motion timeline' },
  design: { label: 'Design', icon: 'palette-fill', tone: 'design', caption: 'Design canvas' },
  game: { label: 'Game', icon: 'gamepad-fill', tone: 'game', caption: 'Playable game' },
};

function designScenarioBadge(scenario?: string): { icon: string; tone: IconTone; label: string } {
  if (scenario === 'deck') return { icon: 'slideshow-fill', tone: 'warning', label: 'Slide deck' };
  if (scenario === 'document') return { icon: 'file-text-fill', tone: 'all', label: 'Document' };
  if (scenario === 'prototype') return { icon: 'layout-2-fill', tone: 'design', label: 'Prototype' };
  return { icon: KIND_INFO.design.icon, tone: KIND_INFO.design.tone, label: KIND_INFO.design.label };
}

function resolveGamePreviewUrl(id: string, previewUrl: string | null | undefined): string | null {
  if (!previewUrl) return null;
  if (!previewUrl.startsWith('/') && !/^(blob|data|https?):/.test(previewUrl)) {
    return `/motion-api/games/${encodeURIComponent(id)}/play/${previewUrl}`;
  }
  return previewUrl.replace(/^\/api\//, '/motion-api/');
}

function ProjectFallbackArt({
  kind,
  kindInfo,
  caption,
}: {
  kind: WorkspaceProjectKind;
  kindInfo: { icon: string; tone: IconTone; caption: string };
  caption: string;
}) {
  return (
    <div className="om-projects-card-motion-art" data-kind={kind} aria-hidden="true">
      <span className="om-projects-art-emblem" data-tone={kindInfo.tone}>
        <RemixIcon name={kindInfo.icon} size={26} />
      </span>
      <span className="om-projects-art-caption">{caption}</span>
    </div>
  );
}

function GameCardVisual({
  projectId,
  previewUrl,
  kindInfo,
  caption,
}: {
  projectId: string;
  previewUrl: string | null | undefined;
  kindInfo: { icon: string; tone: IconTone; caption: string };
  caption: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : resolveGamePreviewUrl(projectId, previewUrl);
  if (!src) {
    return <ProjectFallbackArt kind="game" kindInfo={kindInfo} caption={caption} />;
  }
  return <img className="om-projects-card-preview-img" src={src} alt="" onError={() => setFailed(true)} />;
}

function resolveDisplayTitle(project: UnifiedWorkspaceProject, t: (key: string, params?: Record<string, string | number>) => string): string {
  return project.titleKey ? t(project.titleKey) : project.title;
}

function downloadBlobUrl(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

export function ProjectsPage({
  active = true,
  scope: routeScope,
  projectType: routeType,
  manageProject,
  onFilterChange,
  onOpenMotionProject,
  onOpenDesignProject,
  onOpenGameProject,
  onCreateMotionProject,
  onCreateGameProject,
  onImportMotionZip,
}: ProjectsPageProps) {
  const { t, formatDate } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const snapshot = collab?.snapshot ?? null;
  const activeWs = snapshot?.activeWorkspace ?? null;
  const teamWorkspaces = useMemo(
    () => (snapshot?.workspaces ?? []).filter(w => w.workspaceType === 'team' && w.memberStatus === 'active'),
    [snapshot?.workspaces],
  );
  const hasTeamWorkspace = Boolean(snapshot?.signedIn && teamWorkspaces.length > 0);
  const primaryTeam =
    activeWs?.workspaceType === 'team' ? activeWs : teamWorkspaces[0] ?? null;

  const [scope, setScopeState] = useState<ProjectHubScope>(routeScope ?? 'all');
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [typeFilter, setTypeFilterState] = useState<ProjectHubType>(routeType ?? 'all');
  const [sort, setSort] = useState<SortOption>('recent');
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<UnifiedWorkspaceProjectsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState<{
    project: UnifiedWorkspaceProject;
    title: string;
  } | null>(null);
  const [deleteDraft, setDeleteDraft] = useState<UnifiedWorkspaceProject | null>(null);

  const designZipInputRef = useRef<HTMLInputElement>(null);
  const handledManageRef = useRef<string | null>(null);
  const projectsRevision = collab?.projectsRevision ?? 0;

  useEffect(() => {
    if (routeScope) {
      setScopeState(routeScope);
      if (routeScope !== 'team') setSelectedTeamId(null);
    }
  }, [routeScope]);

  useEffect(() => {
    if (selectedTeamId && !teamWorkspaces.some(w => w.workspaceId === selectedTeamId)) {
      setSelectedTeamId(null);
    }
  }, [selectedTeamId, teamWorkspaces]);

  useEffect(() => {
    if (routeType) setTypeFilterState(routeType);
  }, [routeType]);

  const setScope = (next: ProjectHubScope, teamId: string | null = null) => {
    setSelectedTeamId(next === 'team' ? teamId : null);
    setScopeState(next);
    onFilterChange?.({ projectScope: next === 'all' ? null : next });
  };

  const setTypeFilter = (next: ProjectHubType) => {
    setTypeFilterState(next);
    onFilterChange?.({ projectType: next === 'all' ? null : next });
  };

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await gatewayRequest<UnifiedWorkspaceProjectsResponse>('workspace/projects');
      setCatalog(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not load projects'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!active) return;
    void loadCatalog();
  }, [active, loadCatalog, projectsRevision, activeWs?.workspaceId]);

  useEffect(() => {
    if (!manageProject || !catalog || !collab) return;
    if (handledManageRef.current === manageProject) return;
    const match = catalog.projects.find(item => item.id === manageProject);
    if (!match) return;
    handledManageRef.current = manageProject;
    collab.openProjectSharing({
      projectId: match.id,
      kind: match.kind,
      title: resolveDisplayTitle(match, t),
    });
    onFilterChange?.({ manageProject: null });
  }, [catalog, collab, manageProject, onFilterChange, t]);

  const openProject = (project: UnifiedWorkspaceProject) => {
    if (project.trashed) return;
    if (project.kind === 'motion') {
      void onOpenMotionProject(project.id);
    } else if (project.kind === 'design') {
      onOpenDesignProject(project.id);
    } else {
      onOpenGameProject(project.id);
    }
  };

  const handleDuplicate = async (project: UnifiedWorkspaceProject) => {
    if (busyId || project.kind === 'game') return;
    setBusyId(project.id);
    const displayTitle = resolveDisplayTitle(project, t);
    try {
      if (project.kind === 'motion') {
        await motionApi('/phase1/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'openmotion_manage_project',
            arguments: {
              action: 'duplicate',
              projectId: project.id,
              requestId: crypto.randomUUID(),
              title: t('{title} (copy)', { title: displayTitle.slice(0, 80) }).slice(0, 100),
            },
          }),
        });
      } else {
        await designClient.duplicateProject(project.id);
      }
      collab?.notify(t('Project duplicated'), 'info');
      await loadCatalog();
    } catch (err) {
      collab?.notify(err instanceof Error ? err.message : t('Project action failed'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleExport = async (project: UnifiedWorkspaceProject) => {
    if (busyId) return;
    setBusyId(project.id);
    try {
      if (project.kind === 'motion') {
        const result = await motionApi<{ downloadUrl: string; filename: string }>('/phase1/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'openmotion_project_archive',
            arguments: {
              action: 'export',
              requestId: crypto.randomUUID(),
              projectIds: [project.id],
            },
          }),
        });
        downloadBlobUrl(result.downloadUrl, result.filename);
        collab?.notify(t('Project ZIP ready'), 'info');
      } else if (project.kind === 'design') {
        const filename = await designClient.downloadExport(project.id, { format: 'zip' });
        collab?.notify(t('Exported {filename}', { filename }), 'info');
      } else {
        downloadBlobUrl(`/api/games/${encodeURIComponent(project.id)}/export`, `${project.id}.zip`);
        collab?.notify(t('Project ZIP ready'), 'info');
      }
    } catch (err) {
      collab?.notify(err instanceof Error ? err.message : t('Export failed'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleTrashOrRestore = async (project: UnifiedWorkspaceProject, action: 'trash' | 'restore') => {
    if (busyId || project.kind === 'game') return;
    setBusyId(project.id);
    try {
      if (project.kind === 'motion') {
        await motionApi('/phase1/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'openmotion_manage_project',
            arguments: { action, projectId: project.id, requestId: crypto.randomUUID() },
          }),
        });
      } else {
        if (action === 'trash') await designClient.trashProject(project.id);
        else await designClient.restoreProject(project.id);
      }
      collab?.notify(
        t(action === 'trash' ? 'Project moved to trash' : 'Project restored'),
        'info',
      );
      await loadCatalog();
    } catch (err) {
      collab?.notify(err instanceof Error ? err.message : t('Project action failed'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleCommitRename = async () => {
    if (!renameDraft || busyId) return;
    const trimmed = renameDraft.title.trim();
    const { project } = renameDraft;
    if (!trimmed) return;
    setBusyId(project.id);
    try {
      if (project.kind === 'motion') {
        await motionApi('/phase1/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'openmotion_manage_project',
            arguments: {
              action: 'rename',
              projectId: project.id,
              title: trimmed.slice(0, 100),
              expectedTitle: project.title,
              requestId: crypto.randomUUID(),
            },
          }),
        });
      } else if (project.kind === 'design') {
        await designClient.renameProject(project.id, trimmed, project.title);
      }
      setRenameDraft(null);
      collab?.notify(t('Project renamed'), 'info');
      await loadCatalog();
    } catch (err) {
      collab?.notify(err instanceof Error ? err.message : t('Project action failed'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleCommitDelete = async () => {
    if (!deleteDraft || busyId) return;
    const target = deleteDraft;
    setBusyId(target.id);
    try {
      if (target.kind === 'motion') {
        await motionApi('/phase1/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'openmotion_manage_project',
            arguments: { action: 'delete', projectId: target.id, requestId: crypto.randomUUID() },
          }),
        });
      } else if (target.kind === 'design') {
        await designClient.deleteProject(target.id);
      } else {
        const res = await fetch(`/api/games/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(t('Could not delete project'));
      }
      setDeleteDraft(null);
      collab?.notify(t('Project permanently deleted'), 'info');
      await loadCatalog();
    } catch (err) {
      collab?.notify(err instanceof Error ? err.message : t('Could not delete project'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleCreateDesign = async () => {
    setNewMenuOpen(false);
    if (busyId) return;
    setBusyId('__create_design');
    try {
      const created = await designClient.createProject({ scenario: 'prototype' });
      onOpenDesignProject(created.project.id);
    } catch (err) {
      collab?.notify(err instanceof Error ? err.message : t('Could not create project'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDesignZipSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusyId('__import_design');
    try {
      const imported = await designClient.importZipFile(file);
      collab?.notify(t('Imported {count} design project(s)', { count: imported.projects.length }), 'info');
      if (imported.projects[0]) onOpenDesignProject(imported.projects[0].id);
      else await loadCatalog();
    } catch (err) {
      collab?.notify(err instanceof Error ? err.message : t('Could not import ZIP'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const sourceList = useMemo(() => {
    if (!catalog) return [];
    if (typeFilter === 'trash') return catalog.trashed;
    return catalog.projects;
  }, [catalog, typeFilter]);

  const matchesWorkspaceFilter = useCallback(
    (project: UnifiedWorkspaceProject) => {
      if (!hasTeamWorkspace) return true;
      if (scope === 'personal') return project.shareStatus === 'personal';
      if (scope === 'team') {
        if (project.shareStatus === 'personal') return false;
        if (selectedTeamId) return project.workspaceId === selectedTeamId;
        return true;
      }
      return true;
    },
    [hasTeamWorkspace, scope, selectedTeamId],
  );

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const list = sourceList.filter(project => {
      if (typeFilter !== 'all' && typeFilter !== 'trash' && project.kind !== typeFilter) return false;
      if (typeFilter !== 'trash' && !matchesWorkspaceFilter(project)) return false;
      if (q) {
        const displayTitle = resolveDisplayTitle(project, t).toLocaleLowerCase();
        const sub = (project.subtitle ?? '').toLocaleLowerCase();
        const wsName = (project.workspaceName ?? '').toLocaleLowerCase();
        if (!displayTitle.includes(q) && !sub.includes(q) && !wsName.includes(q)) return false;
      }
      return true;
    });
    return [...list].sort((a, b) => {
      if (sort === 'name') {
        const cmp = resolveDisplayTitle(a, t).localeCompare(resolveDisplayTitle(b, t));
        if (cmp !== 0) return cmp;
      }
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });
  }, [sourceList, typeFilter, matchesWorkspaceFilter, query, sort, t]);

  const teamProjectCount = (catalog?.counts.teamShared ?? 0) + (catalog?.counts.teamPrivate ?? 0);
  const memberCountBadge = primaryTeam?.memberCount;

  const teamCountsById = useMemo(() => {
    const map = new Map<string, number>();
    if (!catalog) return map;
    for (const project of catalog.projects) {
      if (project.shareStatus !== 'personal' && project.workspaceId) {
        map.set(project.workspaceId, (map.get(project.workspaceId) ?? 0) + 1);
      }
    }
    return map;
  }, [catalog]);

  const typeCounts = useMemo(() => {
    if (!catalog) return { all: 0, motion: 0, design: 0, game: 0 };
    if (typeFilter === 'trash' || scope === 'all') {
      return {
        all: catalog.counts.total,
        motion: catalog.counts.motion,
        design: catalog.counts.design,
        game: catalog.counts.game,
      };
    }
    const scoped = catalog.projects.filter(matchesWorkspaceFilter);
    return {
      all: scoped.length,
      motion: scoped.filter(p => p.kind === 'motion').length,
      design: scoped.filter(p => p.kind === 'design').length,
      game: scoped.filter(p => p.kind === 'game').length,
    };
  }, [catalog, matchesWorkspaceFilter, scope, typeFilter]);

  const workspaceMenuValue = scope === 'team' && selectedTeamId ? `team:${selectedTeamId}` : scope;
  const selectedTeamEntry = selectedTeamId
    ? teamWorkspaces.find(w => w.workspaceId === selectedTeamId) ?? null
    : null;

  const activeWorkspaceBadge: {
    icon: string;
    tone: IconTone;
    label: string;
    count?: number;
  } =
    scope === 'personal'
      ? { icon: 'user-3-line', tone: 'personal', label: t('Personal'), count: catalog?.counts.personal }
      : scope === 'team'
        ? selectedTeamEntry
          ? {
              icon: 'group-line',
              tone: 'team',
              label: selectedTeamEntry.workspaceName,
              count: teamCountsById.get(selectedTeamEntry.workspaceId) ?? 0,
            }
          : {
              icon: 'group-line',
              tone: 'team',
              label: teamWorkspaces.length === 1 ? teamWorkspaces[0]!.workspaceName : t('All teams'),
              count: teamProjectCount,
            }
        : { icon: 'stack-line', tone: 'all', label: t('All workspaces'), count: catalog?.counts.total };

  const activeTypeOption =
    PROJECT_TYPE_OPTIONS.find(opt => opt.id === (typeFilter === 'trash' ? 'all' : typeFilter)) ??
    PROJECT_TYPE_OPTIONS[0]!;
  const activeSortOption = SORT_OPTIONS.find(opt => opt.id === sort) ?? SORT_OPTIONS[0]!;
  const trashedCount = catalog?.counts.trashed ?? 0;

  const hasWorkspaceFilter = Boolean(hasTeamWorkspace && typeFilter !== 'trash' && scope !== 'all');
  const hasTypeFilter = typeFilter !== 'all';
  const trimmedQuery = query.trim();
  const hasActiveFilters = hasWorkspaceFilter || hasTypeFilter || Boolean(trimmedQuery);

  const resetFilters = () => {
    setScope('all');
    setTypeFilter('all');
    setQuery('');
  };

  const handleWorkspaceMenuChange = (next: string) => {
    if (next === 'all') setScope('all');
    else if (next === 'personal') setScope('personal');
    else if (next === 'team') setScope('team', null);
    else if (next.startsWith('team:')) setScope('team', next.slice(5));
  };

  return (
    <main className="om-projects-page" aria-label={t('Projects')}>
      <input
        ref={designZipInputRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        aria-label={t('Import Design ZIP')}
        onChange={event => void handleDesignZipSelected(event)}
      />

      <div className="om-projects-shell">
        <LibraryHubNav activeTab="projects" />
        <header className="om-projects-header">
          <div className="om-projects-heading">
            <h1>{t('Projects')}</h1>
            <p>
              {activeWs?.workspaceType === 'team'
                ? t('Active workspace: {name} · Team workspace. Share Personal projects or manage collaborators below.', {
                    name: activeWs.workspaceName,
                  })
                : hasTeamWorkspace
                  ? t('Active workspace: Personal · Manage Motion, Design, and Game projects in one place.')
                  : t('Create, organize, and share Motion, Design, and Game projects.')}
            </p>
          </div>

          <div className="om-projects-header-actions">
            {hasTeamWorkspace && collab && primaryTeam && (
              <Button
                variant="plain"
                type="button"
                className="om-collab-tonal-btn"
                data-testid="projects-collaborators-btn"
                onClick={() => collab.setTeamMembersDialogOpen(true)}
              >
                <span className="om-projects-btn-icon" data-tone="team" aria-hidden="true">
                  <RemixIcon name="group-line" size={14} />
                </span>
                <span>
                  {memberCountBadge && memberCountBadge > 0
                    ? t('Team · {count}', { count: memberCountBadge })
                    : t('Collaborators')}
                </span>
              </Button>
            )}
            {hasTeamWorkspace && collab && snapshot?.permissions.canInviteMembers && (
              <Button
                variant="plain"
                type="button"
                className="om-collab-tonal-btn"
                onClick={() => collab.setInviteDialogOpen(true)}
              >
                <span className="om-projects-btn-icon" data-tone="all" aria-hidden="true">
                  <RemixIcon name="add-line" size={14} />
                </span>
                <span>{t('Invite teammates')}</span>
              </Button>
            )}
            <Popover
              modal={false}
              initialFocus={false}
              open={newMenuOpen}
              onOpenChange={setNewMenuOpen}
              align="end"
              aria-label={t('New project')}
              className="om-projects-new-popover"
              trigger={
                <Button variant="primary" type="button" data-testid="projects-new-btn">
                  <RemixIcon name="add-line" size={15} />
                  <span>{t('New project')}</span>
                </Button>
              }
            >
              <div className="om-projects-popover-section">
                <div className="om-projects-popover-label">{t('Create')}</div>
                {onCreateMotionProject && (
                  <Button
                    variant="plain"
                    type="button"
                    className="om-projects-new-option"
                    onClick={() => {
                      setNewMenuOpen(false);
                      onCreateMotionProject();
                    }}
                  >
                    <span className="om-projects-menu-icon" data-tone="motion" aria-hidden="true">
                      <RemixIcon name="clapperboard-fill" size={14} />
                    </span>
                    <span>{t('New Motion video')}</span>
                  </Button>
                )}
                <Button
                  variant="plain"
                  type="button"
                  className="om-projects-new-option"
                  onClick={() => void handleCreateDesign()}
                >
                  <span className="om-projects-menu-icon" data-tone="design" aria-hidden="true">
                    <RemixIcon name="palette-fill" size={14} />
                  </span>
                  <span>{t('New Design page')}</span>
                </Button>
                {onCreateGameProject && (
                  <Button
                    variant="plain"
                    type="button"
                    className="om-projects-new-option"
                    onClick={() => {
                      setNewMenuOpen(false);
                      onCreateGameProject();
                    }}
                  >
                    <span className="om-projects-menu-icon" data-tone="game" aria-hidden="true">
                      <RemixIcon name="gamepad-fill" size={14} />
                    </span>
                    <span>{t('New playable Game')}</span>
                  </Button>
                )}
              </div>
              <div className="om-projects-popover-sep" role="separator" />
              <div className="om-projects-popover-section">
                <div className="om-projects-popover-label">{t('Import')}</div>
                {onImportMotionZip && (
                  <Button
                    variant="plain"
                    type="button"
                    className="om-projects-new-option"
                    onClick={() => {
                      setNewMenuOpen(false);
                      onImportMotionZip();
                    }}
                  >
                    <span className="om-projects-menu-icon" data-tone="import" aria-hidden="true">
                      <RemixIcon name="upload-2-line" size={14} />
                    </span>
                    <span>{t('Import Motion ZIP')}</span>
                  </Button>
                )}
                <Button
                  variant="plain"
                  type="button"
                  className="om-projects-new-option"
                  onClick={() => {
                    setNewMenuOpen(false);
                    designZipInputRef.current?.click();
                  }}
                >
                  <span className="om-projects-menu-icon" data-tone="import" aria-hidden="true">
                    <RemixIcon name="upload-2-line" size={14} />
                  </span>
                  <span>{t('Import Design ZIP')}</span>
                </Button>
              </div>
            </Popover>
          </div>
        </header>

        <div className="om-projects-toolbar">
          <div className="om-projects-filter-group">
            {hasTeamWorkspace && typeFilter !== 'trash' && (
              <Menu
                modal={false}
                className="om-projects-filter-menu"
                aria-label={t('Filter by workspace')}
                trigger={
                  <Button
                    variant="plain"
                    type="button"
                    className="om-projects-filter-trigger"
                    data-active={scope !== 'all' || undefined}
                    data-testid="projects-workspace-filter"
                    aria-label={t('Filter by workspace')}
                  >
                    <span className="om-projects-icon-chip" data-tone={activeWorkspaceBadge.tone} aria-hidden="true">
                      <RemixIcon name={activeWorkspaceBadge.icon} size={13} />
                    </span>
                    <span className="om-projects-filter-label">{activeWorkspaceBadge.label}</span>
                    {typeof activeWorkspaceBadge.count === 'number' && (
                      <span className="om-projects-trigger-count">{activeWorkspaceBadge.count}</span>
                    )}
                    <RemixIcon name="arrow-down-s-line" size={14} className="om-projects-chevron" />
                  </Button>
                }
              >
                <MenuRadioGroup value={workspaceMenuValue} onValueChange={handleWorkspaceMenuChange}>
                  <MenuRadioItem value="all" closeOnClick>
                    <span className="om-projects-radio-row">
                      <span className="om-projects-icon-chip" data-tone="all" aria-hidden="true">
                        <RemixIcon name="stack-line" size={13} />
                      </span>
                      <span className="om-projects-radio-label">{t('All workspaces')}</span>
                      {catalog && <span className="om-projects-radio-count">{catalog.counts.total}</span>}
                    </span>
                  </MenuRadioItem>
                  <MenuRadioItem value="personal" closeOnClick>
                    <span className="om-projects-radio-row">
                      <span className="om-projects-icon-chip" data-tone="personal" aria-hidden="true">
                        <RemixIcon name="user-3-line" size={13} />
                      </span>
                      <span className="om-projects-radio-label">{t('Personal')}</span>
                      {catalog && <span className="om-projects-radio-count">{catalog.counts.personal}</span>}
                    </span>
                  </MenuRadioItem>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>{t('Team workspaces')}</MenuGroupLabel>
                    {teamWorkspaces.length > 1 ? (
                      <>
                        <MenuRadioItem value="team" closeOnClick>
                          <span className="om-projects-radio-row">
                            <span className="om-projects-icon-chip" data-tone="team" aria-hidden="true">
                              <RemixIcon name="group-line" size={13} />
                            </span>
                            <span className="om-projects-radio-label">{t('All teams')}</span>
                            {catalog && <span className="om-projects-radio-count">{teamProjectCount}</span>}
                          </span>
                        </MenuRadioItem>
                        {teamWorkspaces.map(ws => (
                          <MenuRadioItem key={ws.workspaceId} value={`team:${ws.workspaceId}`} closeOnClick>
                            <span className="om-projects-radio-row">
                              <span className="om-projects-icon-chip" data-tone="team" aria-hidden="true">
                                <RemixIcon name="group-line" size={13} />
                              </span>
                              <span className="om-projects-radio-label">{ws.workspaceName}</span>
                              {catalog && (
                                <span className="om-projects-radio-count">
                                  {teamCountsById.get(ws.workspaceId) ?? 0}
                                </span>
                              )}
                            </span>
                          </MenuRadioItem>
                        ))}
                      </>
                    ) : (
                      <MenuRadioItem value="team" closeOnClick>
                        <span className="om-projects-radio-row">
                          <span className="om-projects-icon-chip" data-tone="team" aria-hidden="true">
                            <RemixIcon name="group-line" size={13} />
                          </span>
                          <span className="om-projects-radio-label">
                            {primaryTeam?.workspaceName ?? t('Team')}
                          </span>
                          {catalog && <span className="om-projects-radio-count">{teamProjectCount}</span>}
                        </span>
                      </MenuRadioItem>
                    )}
                  </MenuGroup>
                </MenuRadioGroup>
              </Menu>
            )}

            <Menu
              modal={false}
              className="om-projects-filter-menu"
              aria-label={t('Filter by type')}
              trigger={
                <Button
                  variant="plain"
                  type="button"
                  className="om-projects-filter-trigger"
                  data-active={(typeFilter !== 'all' && typeFilter !== 'trash') || undefined}
                  data-testid="projects-type-filter"
                  aria-label={t('Filter by type')}
                >
                  <span className="om-projects-icon-chip" data-tone={activeTypeOption.tone} aria-hidden="true">
                    <RemixIcon name={activeTypeOption.icon} size={13} />
                  </span>
                  <span className="om-projects-filter-label">{t(activeTypeOption.label)}</span>
                  {catalog && (
                    <span className="om-projects-trigger-count">{typeCounts[activeTypeOption.id]}</span>
                  )}
                  <RemixIcon name="arrow-down-s-line" size={14} className="om-projects-chevron" />
                </Button>
              }
            >
              <MenuRadioGroup
                value={typeFilter === 'trash' ? 'all' : typeFilter}
                onValueChange={next => setTypeFilter(next as ProjectHubType)}
              >
                {PROJECT_TYPE_OPTIONS.map(opt => (
                  <MenuRadioItem key={opt.id} value={opt.id} closeOnClick>
                    <span className="om-projects-radio-row">
                      <span className="om-projects-icon-chip" data-tone={opt.tone} aria-hidden="true">
                        <RemixIcon name={opt.icon} size={13} />
                      </span>
                      <span className="om-projects-radio-label">{t(opt.label)}</span>
                      {catalog && <span className="om-projects-radio-count">{typeCounts[opt.id]}</span>}
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </Menu>

            <Menu
              modal={false}
              className="om-projects-filter-menu"
              aria-label={t('Sort projects')}
              trigger={
                <Button
                  variant="plain"
                  type="button"
                  className="om-projects-filter-trigger"
                  data-testid="projects-sort-filter"
                  aria-label={t('Sort projects')}
                >
                  <span className="om-projects-icon-chip" data-tone="all" aria-hidden="true">
                    <RemixIcon name={activeSortOption.icon} size={13} />
                  </span>
                  <span className="om-projects-filter-label">{t(activeSortOption.label)}</span>
                  <RemixIcon name="arrow-down-s-line" size={14} className="om-projects-chevron" />
                </Button>
              }
            >
              <MenuRadioGroup value={sort} onValueChange={next => setSort(next as SortOption)}>
                {SORT_OPTIONS.map(opt => (
                  <MenuRadioItem key={opt.id} value={opt.id} closeOnClick>
                    <span className="om-projects-radio-row">
                      <span className="om-projects-icon-chip" data-tone="all" aria-hidden="true">
                        <RemixIcon name={opt.icon} size={13} />
                      </span>
                      <span className="om-projects-radio-label">{t(opt.label)}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </Menu>
          </div>

          <div className="om-projects-search-row">
            <label className="om-field om-projects-search">
              <RemixIcon name="search-line" size={15} />
              <input
                type="search"
                aria-label={t('Search projects')}
                placeholder={t('Search projects…')}
                value={query}
                onChange={event => setQuery(event.target.value)}
              />
            </label>
            <Button
              variant="plain"
              type="button"
              className="om-projects-trash-btn"
              data-testid="projects-trash-btn"
              aria-pressed={typeFilter === 'trash'}
              onClick={() => setTypeFilter(typeFilter === 'trash' ? 'all' : 'trash')}
            >
              <RemixIcon name="delete-bin-line" size={14} className="om-projects-trash-icon" />
              <span>{t('Trash')}</span>
              {trashedCount > 0 && <span className="om-projects-trigger-count">{trashedCount}</span>}
            </Button>
            <IconButton
              variant="ghost"
              className="om-projects-icon-action"
              aria-label={t('Refresh')}
              disabled={loading}
              onClick={() => void loadCatalog()}
              icon={
                <RemixIcon
                  name={loading ? 'loader-4-line' : 'refresh-line'}
                  size={16}
                  className={loading ? 'animate-spin motion-reduce:animate-none' : undefined}
                />
              }
            />
          </div>
        </div>

        {hasActiveFilters && (
          <div className="om-projects-active-filters" data-testid="projects-active-filters">
            {hasWorkspaceFilter && (
              <Button
                variant="plain"
                type="button"
                className="om-projects-active-chip"
                onClick={() => setScope('all')}
                aria-label={t('Remove {label} filter', { label: activeWorkspaceBadge.label })}
              >
                <span className="om-projects-icon-chip" data-tone={activeWorkspaceBadge.tone} aria-hidden="true">
                  <RemixIcon name={activeWorkspaceBadge.icon} size={12} />
                </span>
                <span>{activeWorkspaceBadge.label}</span>
                <RemixIcon name="close-line" size={12} />
              </Button>
            )}
            {hasTypeFilter && (
              <Button
                variant="plain"
                type="button"
                className="om-projects-active-chip"
                onClick={() => setTypeFilter('all')}
                aria-label={t('Remove {label} filter', {
                  label: typeFilter === 'trash' ? t('Trash') : t(activeTypeOption.label),
                })}
              >
                <span
                  className="om-projects-icon-chip"
                  data-tone={typeFilter === 'trash' ? 'danger' : activeTypeOption.tone}
                  aria-hidden="true"
                >
                  <RemixIcon
                    name={typeFilter === 'trash' ? 'delete-bin-line' : activeTypeOption.icon}
                    size={12}
                  />
                </span>
                <span>{typeFilter === 'trash' ? t('Trash') : t(activeTypeOption.label)}</span>
                <RemixIcon name="close-line" size={12} />
              </Button>
            )}
            {trimmedQuery && (
              <Button
                variant="plain"
                type="button"
                className="om-projects-active-chip"
                onClick={() => setQuery('')}
                aria-label={t('Remove {label} filter', { label: trimmedQuery })}
              >
                <RemixIcon name="search-line" size={12} />
                <span>“{trimmedQuery}”</span>
                <RemixIcon name="close-line" size={12} />
              </Button>
            )}
            <Button variant="plain" type="button" className="om-projects-clear-btn" onClick={resetFilters}>
              {t('Clear filters')}
            </Button>
          </div>
        )}

        {loading && !catalog ? (
          <div className="om-projects-grid" aria-busy="true">
            {[0, 1, 2, 3, 4, 5].map(idx => (
              <Skeleton key={idx} className="om-projects-skeleton-card" />
            ))}
          </div>
        ) : error && !catalog ? (
          <div className="om-projects-empty">
            <p>{error}</p>
            <Button variant="primary" type="button" onClick={() => void loadCatalog()}>
              {t('Retry')}
            </Button>
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="om-projects-empty">
            <RemixIcon name={typeFilter === 'trash' ? 'delete-bin-line' : 'folder-open-line'} size={28} />
            <p>
              {query.trim()
                ? t('No matching projects')
                : typeFilter === 'trash'
                  ? t('Trash is empty')
                  : scope === 'team'
                    ? t('No projects shared with your team yet. Open Share on any Personal project to add it here.')
                    : t('No projects yet. Create a Motion video, Design page, or playable Game to get started.')}
            </p>
            <div className="om-projects-empty-actions">
              {scope === 'team' && (catalog?.counts.personal ?? 0) > 0 && typeFilter !== 'trash' && (
                <Button variant="plain" type="button" className="om-collab-tonal-btn" onClick={() => setScope('personal')}>
                  {t('View Personal projects')}
                </Button>
              )}
              {hasActiveFilters && (
                <Button variant="plain" type="button" className="om-collab-tonal-btn" onClick={resetFilters}>
                  {t('Clear filters')}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="om-projects-grid" data-testid="projects-hub-grid">
            {filteredProjects.map(project => {
              const displayTitle = resolveDisplayTitle(project, t);
              const kindInfo = KIND_INFO[project.kind];
              const typeBadge =
                project.kind === 'design'
                  ? designScenarioBadge(project.scenario)
                  : { icon: kindInfo.icon, tone: kindInfo.tone, label: kindInfo.label };
              const isSharedInTeam = project.shareStatus === 'team_shared';
              const isPrivateInTeam = project.shareStatus === 'team_private';
              const shareBadgeTone: IconTone = isSharedInTeam ? 'team' : isPrivateInTeam ? 'warning' : 'personal';
              const shareBadgeIcon = isSharedInTeam
                ? 'group-line'
                : isPrivateInTeam
                  ? 'eye-off-line'
                  : 'lock-line';
              const shareBadgeText = isSharedInTeam
                ? t('Team · {name}', { name: project.workspaceName ?? t('Team') })
                : isPrivateInTeam
                  ? t('Private in team')
                  : t('Personal');

              const updatedLabel = project.updatedAt
                ? formatDate(new Date(project.updatedAt), { month: 'short', day: 'numeric' })
                : null;
              const ownerDetail =
                project.shareStatus === 'personal'
                  ? t('Only you')
                  : isPrivateInTeam
                    ? t('Hidden from teammates')
                    : project.isOwner
                      ? t('Shared by You')
                      : project.ownerName
                        ? t('Shared by {name}', { name: project.ownerName })
                        : t('Shared in workspace');

              return (
                <article
                  key={`${project.kind}:${project.id}`}
                  className="om-projects-card"
                  data-testid={`project-card-${project.id}`}
                  data-share-status={project.shareStatus}
                >
                  <Button
                    variant="plain"
                    type="button"
                    className="om-projects-card-preview-btn"
                    disabled={Boolean(project.trashed)}
                    aria-label={t('Open {title}', { title: displayTitle })}
                    onClick={() => openProject(project)}
                  >
                    {project.kind === 'design' && project.previewUrl ? (
                      <ScaledPreviewThumb src={project.previewUrl} title={displayTitle} active={active} />
                    ) : project.kind === 'game' ? (
                      <GameCardVisual
                        projectId={project.id}
                        previewUrl={project.previewUrl}
                        kindInfo={kindInfo}
                        caption={t(kindInfo.caption)}
                      />
                    ) : (
                      <ProjectFallbackArt
                        kind={project.kind}
                        kindInfo={kindInfo}
                        caption={t(kindInfo.caption)}
                      />
                    )}

                    <div className="om-projects-card-badges">
                      <span className="om-projects-overlay-pill">
                        <span className="om-projects-pill-icon" data-tone={typeBadge.tone} aria-hidden="true">
                          <RemixIcon name={typeBadge.icon} size={13} />
                        </span>
                        <span>{t(typeBadge.label)}</span>
                      </span>

                      <span className="om-projects-badge-group">
                        {project.webPublish.status === 'published' && (
                          <span className="om-projects-overlay-pill" data-tone="live">
                            <span className="om-projects-pill-icon" data-tone="live" aria-hidden="true">
                              <RemixIcon name="cloud-line" size={12} />
                            </span>
                            <span>{t('Live')}</span>
                          </span>
                        )}
                        <span className="om-projects-overlay-pill" data-tone={shareBadgeTone}>
                          <span className="om-projects-pill-icon" data-tone={shareBadgeTone} aria-hidden="true">
                            <RemixIcon name={shareBadgeIcon} size={12} />
                          </span>
                          <span>{shareBadgeText}</span>
                        </span>
                      </span>
                    </div>
                  </Button>

                  <div className="om-projects-card-body">
                    <div className="om-projects-card-title-row">
                      <Button
                        variant="plain"
                        type="button"
                        className="om-projects-card-title-btn"
                        disabled={Boolean(project.trashed)}
                        title={displayTitle}
                        onClick={() => openProject(project)}
                      >
                        {displayTitle}
                      </Button>
                      <div className="om-projects-card-meta">
                        <span>{ownerDetail}</span>
                        {updatedLabel && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{updatedLabel}</span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="om-projects-card-actions">
                      {project.trashed ? (
                        <>
                          {project.kind !== 'game' && (
                            <Button
                              variant="plain"
                              type="button"
                              className="om-collab-tonal-btn"
                              disabled={busyId === project.id}
                              onClick={() => void handleTrashOrRestore(project, 'restore')}
                            >
                              <RemixIcon name="history-line" size={14} />
                              <span>{t('Restore')}</span>
                            </Button>
                          )}
                          <Button
                            variant="plain"
                            type="button"
                            className="om-collab-tonal-btn om-collab-danger-tonal-btn"
                            disabled={busyId === project.id}
                            onClick={() => setDeleteDraft(project)}
                          >
                            <RemixIcon name="delete-bin-line" size={14} />
                            <span>{t('Delete permanently')}</span>
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            variant="plain"
                            type="button"
                            className="om-projects-share-btn"
                            data-shared={project.shareStatus !== 'personal' || undefined}
                            data-testid={`project-share-btn-${project.id}`}
                            onClick={() =>
                              collab?.openProjectSharing({
                                projectId: project.id,
                                kind: project.kind,
                                title: displayTitle,
                              })
                            }
                          >
                            <span
                              className="om-projects-share-icon"
                              data-tone={project.shareStatus === 'personal' ? 'personal' : 'team'}
                              aria-hidden="true"
                            >
                              <RemixIcon name={project.shareStatus === 'personal' ? 'share-forward-line' : 'group-line'} size={14} />
                            </span>
                            <span>{t(project.shareStatus === 'personal' ? 'Share' : 'Sharing')}</span>
                          </Button>

                          <Menu
                            modal={false}
                            align="end"
                            presentation="panel"
                            aria-label={t('Actions for {title}', { title: displayTitle })}
                            trigger={
                              <IconButton
                                variant="plain"
                                type="button"
                                className="motion-icon-button"
                                disabled={busyId === project.id}
                                aria-label={t('Actions for {title}', { title: displayTitle })}
                                icon={<RemixIcon name="more-2-line" size={16} />}
                              />
                            }
                          >
                            <MenuItem
                              icon={<RemixIcon name="arrow-right-up-line" size={14} />}
                              onClick={() => openProject(project)}
                            >
                              {t('Open project')}
                            </MenuItem>
                            {collab && (
                              <MenuItem
                                icon={<RemixIcon name="group-line" size={14} />}
                                onClick={() =>
                                  collab.openProjectSharing({
                                    projectId: project.id,
                                    kind: project.kind,
                                    title: displayTitle,
                                  })
                                }
                              >
                                {t('Share & collaborators…')}
                              </MenuItem>
                            )}
                            {collab && project.permissions.canShareToTeam && (
                              <MenuItem
                                icon={<RemixIcon name="share-forward-line" size={14} />}
                                onClick={() =>
                                  collab.requestMoveToTeam({
                                    id: project.id,
                                    title: displayTitle,
                                    kind: project.kind,
                                  })
                                }
                              >
                                {t('Share to team')}
                              </MenuItem>
                            )}
                            {collab && project.permissions.canRemoveFromTeam && (
                              <MenuItem
                                icon={<RemixIcon name="arrow-go-back-line" size={14} />}
                                tone="danger"
                                onClick={() =>
                                  collab.requestRemoveFromTeam({
                                    id: project.id,
                                    title: displayTitle,
                                    workspaceName: project.workspaceName,
                                  })
                                }
                              >
                                {t('Remove from team')}
                              </MenuItem>
                            )}
                            {project.kind !== 'game' && (
                              <MenuItem
                                icon={<RemixIcon name="edit-line" size={14} />}
                                onClick={() => setRenameDraft({ project, title: displayTitle })}
                              >
                                {t('Rename')}
                              </MenuItem>
                            )}
                            {project.kind !== 'game' && (
                              <MenuItem
                                icon={<RemixIcon name="file-copy-line" size={14} />}
                                onClick={() => void handleDuplicate(project)}
                              >
                                {t('Duplicate')}
                              </MenuItem>
                            )}
                            <MenuItem
                              icon={<RemixIcon name="download-2-line" size={14} />}
                              onClick={() => void handleExport(project)}
                            >
                              {t('Export ZIP')}
                            </MenuItem>
                            {project.kind !== 'game' ? (
                              <MenuItem
                                icon={<RemixIcon name="delete-bin-line" size={14} />}
                                tone="danger"
                                onClick={() => void handleTrashOrRestore(project, 'trash')}
                              >
                                {t('Move to trash')}
                              </MenuItem>
                            ) : (
                              <MenuItem
                                icon={<RemixIcon name="delete-bin-line" size={14} />}
                                tone="danger"
                                onClick={() => setDeleteDraft(project)}
                              >
                                {t('Delete permanently')}
                              </MenuItem>
                            )}
                          </Menu>
                        </>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <CollabDialog
        open={Boolean(renameDraft)}
        title={t('Rename project')}
        onClose={() => setRenameDraft(null)}
      >
        <form
          onSubmit={event => {
            event.preventDefault();
            void handleCommitRename();
          }}
        >
          <label className="om-label">
            <span>{t('Project name')}</span>
            <span className="om-field">
              <input
                autoFocus
                maxLength={100}
                value={renameDraft?.title ?? ''}
                disabled={Boolean(busyId)}
                onFocus={event => event.target.select()}
                onChange={event =>
                  setRenameDraft(prev => (prev ? { ...prev, title: event.target.value } : null))
                }
              />
            </span>
          </label>
          <div className="om-collab-dialog-footer" style={{ marginTop: 'var(--motion-space-12)' }}>
            <Button
              variant="plain"
              type="button"
              className="om-collab-tonal-btn"
              onClick={() => setRenameDraft(null)}
            >
              {t('Cancel')}
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={Boolean(busyId) || !renameDraft?.title.trim()}
            >
              {t('Save')}
            </Button>
          </div>
        </form>
      </CollabDialog>

      <CollabDialog
        open={Boolean(deleteDraft)}
        title={t('Delete permanently?')}
        onClose={() => setDeleteDraft(null)}
      >
        <p className="om-muted" style={{ margin: 0 }}>
          {deleteDraft
            ? t('This permanently deletes “{title}” and its local files.', {
                title: resolveDisplayTitle(deleteDraft, t),
              })
            : ''}
        </p>
        <div className="om-collab-dialog-footer">
          <Button
            variant="plain"
            type="button"
            className="om-collab-tonal-btn"
            onClick={() => setDeleteDraft(null)}
          >
            {t('Cancel')}
          </Button>
          <Button
            variant="danger"
            type="button"
            disabled={Boolean(busyId)}
            onClick={() => void handleCommitDelete()}
          >
            {t('Delete permanently')}
          </Button>
        </div>
      </CollabDialog>
    </main>
  );
}
