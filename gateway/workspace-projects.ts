import { designProjectsFor } from '../design-projects.ts';
import { gameProjectsFor } from '../game-projects.ts';
import { designRoutes, type DesignProject } from '../shared/design-project.ts';
import type { GameCard } from '../shared/game-contract.ts';
import type { WebPublicationRecord, WebPublishListResponse } from '../shared/web-publish.ts';
import type {
  ProjectShareStatus,
  ProjectVisibility,
  UnifiedWorkspaceProject,
  UnifiedWorkspaceProjectsCounts,
  UnifiedWorkspaceProjectsResponse,
  WorkspaceDirectoryEntry,
  WorkspaceProjectKind,
} from '../shared/workspace-collab.ts';
import type { SavedProject, WorkspaceStore } from '../workspace.ts';
import { webPublishFor, type WebPublishAccountClient } from './web-publish.ts';
import type { RemoteTeamProjectInfo, WorkspaceCollabService } from './workspace-collab.ts';

export interface WorkspaceProjectsSources {
  directory: string;
  motionCatalog?: () => { projects: SavedProject[] };
  designList?: (options: { trashed: boolean }) => Promise<DesignProject[]>;
  gameCatalog?: () => Promise<{ games: GameCard[] }>;
  webPublishList?: () => Promise<WebPublishListResponse>;
  webPublishAccount?: WebPublishAccountClient;
}

type RawProjectSeed = {
  id: string;
  kind: WorkspaceProjectKind;
  title: string;
  titleKey?: 'OpenMotion Sample Video' | null;
  subtitle?: string;
  scenario?: string;
  previewUrl?: string | null;
  updatedAt?: number;
  trashed: boolean;
  trashedAt?: number;
};

function pickPublication(
  publications: WebPublicationRecord[],
  kind: WorkspaceProjectKind,
  id: string,
): UnifiedWorkspaceProject['webPublish'] {
  const matches = publications.filter(
    pub => pub.targetKind === kind && (pub.targetId === id || pub.projectId === id),
  );
  if (!matches.length) return { status: 'none' };
  const sorted = [...matches].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'published' ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
  const chosen = sorted[0]!;
  return {
    status: chosen.status,
    url: chosen.url ?? null,
    updatedAt: chosen.updatedAt,
  };
}

function resolveProjectCollabState(input: {
  seed: RawProjectSeed;
  snapshot: Awaited<ReturnType<WorkspaceCollabService['getSnapshot']>>;
  workspaceById: Map<string, WorkspaceDirectoryEntry>;
  personalWs: WorkspaceDirectoryEntry | null;
  activeTeamWs: WorkspaceDirectoryEntry | null;
  remoteTeamProjects: Map<string, RemoteTeamProjectInfo>;
  publications: WebPublicationRecord[];
  hasEditableTeam: boolean;
}): UnifiedWorkspaceProject {
  const {
    seed,
    snapshot,
    workspaceById,
    personalWs,
    activeTeamWs,
    remoteTeamProjects,
    publications,
    hasEditableTeam,
  } = input;

  const meta = snapshot.projectMeta[seed.id];
  const remote = remoteTeamProjects.get(seed.id);
  const metaWs = meta?.workspaceId ? workspaceById.get(meta.workspaceId) : undefined;
  const selfName = snapshot.user?.name?.trim() || snapshot.user?.email?.trim() || null;

  let shareStatus: ProjectShareStatus = 'personal';
  let workspaceId: string | null = personalWs?.workspaceId ?? null;
  let workspaceName: string | null = personalWs?.workspaceName ?? null;
  let visibility: ProjectVisibility = 'private';
  let ownerMemberId: string | null = personalWs?.workspaceMemberId ?? null;
  let ownerName: string | null = selfName;
  let isOwner = true;
  let sharedAt: number | null = null;
  let teamSynced = false;
  let workspaceLocked = false;

  if (metaWs && metaWs.workspaceType === 'team') {
    workspaceId = metaWs.workspaceId;
    workspaceName = metaWs.workspaceName;
    visibility = meta?.visibility ?? remote?.visibility ?? 'workspace';
    shareStatus = visibility === 'workspace' ? 'team_shared' : 'team_private';
    ownerMemberId = meta?.ownerMemberId ?? remote?.ownerMemberId ?? metaWs.workspaceMemberId;
    ownerName = meta?.ownerName ?? selfName;
    isOwner = !meta?.ownerMemberId || meta.ownerMemberId === metaWs.workspaceMemberId;
    sharedAt = meta?.movedAt ?? remote?.updatedAt ?? null;
    teamSynced = Boolean(meta?.teamSynced || remote);
    workspaceLocked = metaWs.lifecycleState === 'locked' || metaWs.lifecycleState === 'deleted';
  } else if (remote && activeTeamWs && !meta?.removedFromTeamAt) {
    workspaceId = activeTeamWs.workspaceId;
    workspaceName = activeTeamWs.workspaceName;
    visibility = remote.visibility ?? 'workspace';
    shareStatus = visibility === 'workspace' ? 'team_shared' : 'team_private';
    ownerMemberId = remote.ownerMemberId ?? null;
    isOwner = !remote.ownerMemberId || remote.ownerMemberId === activeTeamWs.workspaceMemberId;
    ownerName = isOwner ? selfName : null;
    sharedAt = remote.updatedAt ?? null;
    teamSynced = true;
    workspaceLocked = activeTeamWs.lifecycleState === 'locked' || activeTeamWs.lifecycleState === 'deleted';
  }

  const webPublish = pickPublication(publications, seed.kind, seed.id);

  return {
    id: seed.id,
    kind: seed.kind,
    title: seed.title,
    ...(seed.titleKey !== undefined ? { titleKey: seed.titleKey } : {}),
    ...(seed.subtitle ? { subtitle: seed.subtitle } : {}),
    ...(seed.scenario ? { scenario: seed.scenario } : {}),
    ...(seed.previewUrl !== undefined ? { previewUrl: seed.previewUrl } : {}),
    ...(seed.updatedAt !== undefined ? { updatedAt: seed.updatedAt } : {}),
    trashed: seed.trashed,
    ...(seed.trashedAt !== undefined ? { trashedAt: seed.trashedAt } : {}),
    shareStatus,
    workspaceId,
    workspaceName,
    visibility,
    ownerMemberId,
    ownerName,
    isOwner,
    sharedAt,
    teamSynced,
    webPublish,
    permissions: {
      canOpen: !seed.trashed,
      canShareToTeam: !seed.trashed && shareStatus === 'personal' && snapshot.signedIn && hasEditableTeam,
      canChangeVisibility: !seed.trashed && shareStatus !== 'personal' && isOwner && !workspaceLocked,
      canRemoveFromTeam: !seed.trashed && shareStatus !== 'personal' && isOwner && !workspaceLocked,
      canRename: !seed.trashed && isOwner && !workspaceLocked,
      canDelete: isOwner && !workspaceLocked,
    },
  };
}

/**
 * Aggregate Motion, Design, and user-authored Game projects alongside workspace
 * sharing status, ownership, and live Cloud publication state.
 */
export async function collectUnifiedWorkspaceProjects(
  storeOrSources: WorkspaceStore | WorkspaceProjectsSources,
  collab: WorkspaceCollabService,
  options: { includeRemoteSync?: boolean } = {},
): Promise<UnifiedWorkspaceProjectsResponse> {
  const isSources = 'directory' in storeOrSources && !('projectCatalog' in storeOrSources);
  const rootStore = isSources ? null : (storeOrSources.workspaceStore ?? storeOrSources);
  const directory = isSources ? storeOrSources.directory : rootStore!.directory;
  const sources: WorkspaceProjectsSources = isSources
    ? storeOrSources
    : { directory };

  const readMotion = sources.motionCatalog ?? (() => rootStore!.projectCatalog());
  const readDesign =
    sources.designList ?? ((opts: { trashed: boolean }) => designProjectsFor(directory).list(opts));
  const readGames = sources.gameCatalog ?? (() => gameProjectsFor(directory).catalog());
  const readWebPublish =
    sources.webPublishList ?? (() => webPublishFor(directory, sources.webPublishAccount).listAll());

  const [snapshotRes, motionRes, designActiveRes, designTrashedRes, gamesRes, webPublishRes] =
    await Promise.allSettled([
      collab.getSnapshot(),
      Promise.resolve().then(() => readMotion()),
      readDesign({ trashed: false }),
      readDesign({ trashed: true }),
      readGames(),
      readWebPublish(),
    ]);

  const snapshot =
    snapshotRes.status === 'fulfilled'
      ? snapshotRes.value
      : await collab.getSnapshot();

  const workspaceById = new Map<string, WorkspaceDirectoryEntry>(
    snapshot.workspaces.map(ws => [ws.workspaceId, ws]),
  );
  const personalWs =
    snapshot.workspaces.find(w => w.workspaceType === 'personal' && w.isDefault) ??
    snapshot.workspaces.find(w => w.workspaceType === 'personal') ??
    null;
  const activeTeamWs =
    snapshot.activeWorkspace?.workspaceType === 'team'
      ? snapshot.activeWorkspace
      : snapshot.workspaces.find(w => w.workspaceType === 'team' && w.memberStatus === 'active') ?? null;
  const hasEditableTeam = snapshot.workspaces.some(
    w => w.workspaceType === 'team' && w.memberStatus === 'active' && w.lifecycleState === 'active',
  );

  const remoteTeamProjects =
    options.includeRemoteSync !== false && snapshot.signedIn && activeTeamWs
      ? await collab.listRemoteTeamProjects(activeTeamWs.workspaceId).catch(() => new Map<string, RemoteTeamProjectInfo>())
      : new Map<string, RemoteTeamProjectInfo>();

  const publications = webPublishRes.status === 'fulfilled' ? webPublishRes.value.publications : [];

  const seeds: RawProjectSeed[] = [];

  if (motionRes.status === 'fulfilled') {
    for (const item of motionRes.value.projects) {
      const updatedAt = item.openedAt ?? item.createdAt ?? undefined;
      seeds.push({
        id: item.id,
        kind: 'motion',
        title: item.title,
        ...(item.titleKey !== undefined ? { titleKey: item.titleKey } : {}),
        subtitle: item.templateId ? `Template · ${item.templateId}` : 'Motion video',
        updatedAt,
        trashed: Boolean(item.trashedAt),
        ...(item.trashedAt ? { trashedAt: item.trashedAt } : {}),
      });
    }
  }

  if (designActiveRes.status === 'fulfilled') {
    for (const item of designActiveRes.value) {
      seeds.push({
        id: item.id,
        kind: 'design',
        title: item.title,
        subtitle: item.versionLabel ?? 'v1',
        scenario: item.scenario,
        previewUrl: designRoutes.raw(item.id, item.entry),
        updatedAt: item.updatedAt,
        trashed: false,
      });
    }
  }

  if (designTrashedRes.status === 'fulfilled') {
    for (const item of designTrashedRes.value) {
      seeds.push({
        id: item.id,
        kind: 'design',
        title: item.title,
        subtitle: item.versionLabel ?? 'v1',
        scenario: item.scenario,
        previewUrl: designRoutes.raw(item.id, item.entry),
        updatedAt: item.updatedAt,
        trashed: true,
        ...(item.trashedAt ? { trashedAt: item.trashedAt } : {}),
      });
    }
  }

  if (gamesRes.status === 'fulfilled') {
    for (const game of gamesRes.value.games) {
      if (game.source !== 'mine') continue;
      const parsedTime = Date.parse(game.updatedAt || game.createdAt);
      seeds.push({
        id: game.id,
        kind: 'game',
        title: game.title,
        subtitle: `${game.genre}${game.multiplayer ? ' · Multiplayer' : ''}`,
        previewUrl: game.cover,
        updatedAt: Number.isFinite(parsedTime) ? parsedTime : undefined,
        trashed: false,
      });
    }
  }

  const resolved = seeds.map(seed =>
    resolveProjectCollabState({
      seed,
      snapshot,
      workspaceById,
      personalWs,
      activeTeamWs,
      remoteTeamProjects,
      publications,
      hasEditableTeam,
    }),
  );

  const byRecency = (a: UnifiedWorkspaceProject, b: UnifiedWorkspaceProject) => {
    const ta = a.updatedAt ?? 0;
    const tb = b.updatedAt ?? 0;
    if (ta !== tb) return tb - ta;
    return a.title.localeCompare(b.title);
  };

  const projects = resolved.filter(item => !item.trashed).sort(byRecency);
  const trashed = resolved.filter(item => item.trashed).sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));

  const counts: UnifiedWorkspaceProjectsCounts = {
    total: projects.length,
    personal: projects.filter(item => item.shareStatus === 'personal').length,
    teamShared: projects.filter(item => item.shareStatus === 'team_shared').length,
    teamPrivate: projects.filter(item => item.shareStatus === 'team_private').length,
    motion: projects.filter(item => item.kind === 'motion').length,
    design: projects.filter(item => item.kind === 'design').length,
    game: projects.filter(item => item.kind === 'game').length,
    trashed: trashed.length,
  };

  return {
    activeWorkspaceId: snapshot.activeWorkspaceId,
    activeWorkspaceName: snapshot.activeWorkspace?.workspaceName ?? null,
    activeWorkspaceType: snapshot.activeWorkspace?.workspaceType ?? null,
    projects,
    trashed,
    counts,
  };
}
