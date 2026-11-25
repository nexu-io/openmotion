import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { designProjectsFor } from '../design-projects.ts';
import { gameProjectsFor } from '../game-projects.ts';
import { brandKitWebsite, type BrandKit } from '../shared/brand-kit.ts';
import { assetDownloadUrl, assetMediaUrl, assetVersion, type LibraryAsset } from '../shared/asset-library.ts';
import { findDesignScenario, type DesignProject } from '../shared/design-project.ts';
import type { GameCard } from '../shared/game-contract.ts';
import type { GenerationJob } from '../shared/gateway.ts';
import { safeHttpsUrl } from '../shared/growth-surfaces.ts';
import {
  createEmptyLibraryCounts,
  designScenarioToLibraryCategory,
  type UnifiedLibraryItem,
  type UnifiedLibraryOrigin,
  type UnifiedLibraryQuery,
  type UnifiedLibraryResponse,
} from '../shared/library-index.ts';
import type { ScenarioRun, ScenarioRunSummary } from '../shared/scenario-runs.ts';
import { findScenario, type ScenarioId } from '../shared/scenarios.ts';
import type { SuperAgentArtifact, SuperAgentChat } from '../shared/super-agent.ts';
import type { ExportJob, SavedProject, WorkspaceStore } from '../workspace.ts';
import { AssetLibrary } from './asset-library.ts';
import { brandKitsFor } from './brand-kits.ts';
import { scenarioRunsFor } from './scenario-runs.ts';
import { gatewayFor } from './service.ts';
import { superAgentConversations } from './super-agent.ts';

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

type ChatProvenance = {
  chatId: string;
  chatTitle: string;
  artifactId: string;
  updatedAt: number;
};

type RunProvenance = {
  scenarioId: string;
  runId: string;
  runTitle: string;
  updatedAt: number;
};

function parseTimestamp(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function modalityCategory(modality: LibraryAsset['modality']): 'images' | 'videos' | 'audio' {
  if (modality === 'video') return 'videos';
  if (modality === 'audio') return 'audio';
  return 'images';
}

function modalityStudioLabel(modality: LibraryAsset['modality']): string {
  if (modality === 'video') return 'Video Studio';
  if (modality === 'audio') return 'Sound Studio';
  return 'Image Studio';
}

function normalizeGameCoverUrl(game: GameCard): string | undefined {
  if (!game.cover) return undefined;
  if (!game.cover.startsWith('/') && !/^(blob|data|https?):/.test(game.cover)) {
    return `/motion-api/games/${encodeURIComponent(game.id)}/play/${game.cover}`;
  }
  return game.cover.startsWith('/api/') ? `/motion-api${game.cover.slice(4)}` : game.cover;
}

function sanitizeExternalWebUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const https = safeHttpsUrl(raw);
  if (https) return https;
  const trimmed = raw.trim();
  if (/^\/(?!\/)/.test(trimmed)) return trimmed;
  return undefined;
}

function recordNewestProvenance<T extends { updatedAt: number }>(
  map: Map<string, T>,
  key: string | undefined,
  entry: T,
): void {
  if (!key) return;
  const existing = map.get(key);
  if (!existing || entry.updatedAt >= existing.updatedAt) {
    map.set(key, entry);
  }
}

async function listAllLibraryAssets(store: WorkspaceStore): Promise<LibraryAsset[]> {
  const lib = new AssetLibrary(store);
  const assets: LibraryAsset[] = [];
  let offset = 0;
  for (let page = 0; page < 20; page += 1) {
    const res = await lib.list({ trash: false, sort: 'newest', offset, limit: 100 });
    assets.push(...res.assets);
    if (res.nextOffset === null || res.nextOffset <= offset) break;
    offset = res.nextOffset;
  }
  return assets;
}

async function listCompletedMotionExports(rootDir: string, store: WorkspaceStore): Promise<Array<{ job: ExportJob; bytes: number }>> {
  const jobsDir = path.join(rootDir, 'jobs');
  const names = await readdir(jobsDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  const jobs = await Promise.all(
    names
      .filter(name => UUID_RE.test(name))
      .map(async id => {
        try {
          const raw = await readFile(path.join(jobsDir, id, 'job.json'), 'utf8');
          const parsed = JSON.parse(raw) as ExportJob;
          if (!parsed || parsed.id !== id || parsed.state !== 'completed') return null;
          const fileInfo = await stat(store.exportPath(parsed));
          if (!fileInfo.isFile() || fileInfo.size <= 0) return null;
          return { job: parsed, bytes: fileInfo.size };
        } catch {
          return null;
        }
      }),
  );
  return jobs.filter((item): item is { job: ExportJob; bytes: number } => item !== null);
}

async function readDirectoryMtime(dirPath: string): Promise<number> {
  try {
    const info = await stat(dirPath);
    return Number.isFinite(info.mtimeMs) ? Math.round(info.mtimeMs) : 0;
  } catch {
    return 0;
  }
}

function buildSearchHaystack(item: UnifiedLibraryItem): string {
  return [
    item.title,
    item.subtitle,
    item.originLabel,
    item.moduleLabel,
    item.badgeLabel,
    item.model,
    item.filename,
    item.sourceChatTitle,
    item.sourceRunTitle,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' ')
    .toLocaleLowerCase();
}

export async function collectUnifiedLibraryIndex(
  store: WorkspaceStore,
  query: UnifiedLibraryQuery = {},
): Promise<UnifiedLibraryResponse> {
  const rootStore = store.workspaceStore ?? store;
  const rootDir = rootStore.directory;
  const nowFallback = Date.now();

  const [
    chatsRes,
    runsRes,
    jobsRes,
    assetsRes,
    catalogRes,
    exportsRes,
    designRes,
    gamesRes,
    brandKitsRes,
  ] = await Promise.allSettled([
    (async () => {
      const sa = superAgentConversations(rootStore);
      const summaries = (await sa.list()).slice(0, 100);
      const settled = await Promise.allSettled(summaries.map(summary => sa.get(summary.id)));
      return settled
        .filter((entry): entry is PromiseFulfilledResult<SuperAgentChat> => entry.status === 'fulfilled')
        .map(entry => entry.value);
    })(),
    (async () => {
      const sr = scenarioRunsFor(rootStore);
      const listed = await sr.list({ includeArchived: false, limit: 100 });
      const settled = await Promise.allSettled(
        listed.runs.slice(0, 60).map(summary => sr.get(summary.id)),
      );
      return {
        summaries: listed.runs,
        runs: settled
          .filter((entry): entry is PromiseFulfilledResult<{ run: ScenarioRun }> => entry.status === 'fulfilled')
          .map(entry => entry.value.run),
      };
    })(),
    gatewayFor(rootStore).listJobs(),
    listAllLibraryAssets(rootStore),
    Promise.resolve().then(() => rootStore.projectCatalog()),
    listCompletedMotionExports(rootDir, rootStore),
    designProjectsFor(rootDir).list({ trashed: false }),
    gameProjectsFor(rootDir).catalog(),
    brandKitsFor(rootDir).list(),
  ]);

  const chats = chatsRes.status === 'fulfilled' ? chatsRes.value : [];
  const runBundle = runsRes.status === 'fulfilled'
    ? runsRes.value
    : { summaries: [] as ScenarioRunSummary[], runs: [] as ScenarioRun[] };
  const jobsById = new Map<string, GenerationJob>(
    (jobsRes.status === 'fulfilled' ? jobsRes.value : []).map(job => [job.id, job]),
  );
  const assets = assetsRes.status === 'fulfilled' ? assetsRes.value : [];
  const motionProjects: SavedProject[] = catalogRes.status === 'fulfilled'
    ? catalogRes.value.projects.filter(project => !project.trashedAt)
    : [];
  const motionTitleById = new Map(motionProjects.map(project => [project.id, project.title]));
  const completedExports = exportsRes.status === 'fulfilled' ? exportsRes.value : [];
  const designProjects: DesignProject[] = designRes.status === 'fulfilled' ? designRes.value : [];
  const myGames: GameCard[] = gamesRes.status === 'fulfilled'
    ? gamesRes.value.games.filter(game => game.source === 'mine')
    : [];
  const brandKits: BrandKit[] = brandKitsRes.status === 'fulfilled' ? brandKitsRes.value : [];

  // Provenance maps from Super Agent chats and Workflow runs
  const assetChatMap = new Map<string, ChatProvenance>();
  const motionChatMap = new Map<string, ChatProvenance>();
  const motionExportChatMap = new Map<string, ChatProvenance>();
  const designChatMap = new Map<string, ChatProvenance>();
  const gameChatMap = new Map<string, ChatProvenance>();
  const brandKitChatMap = new Map<string, ChatProvenance>();
  const exclusiveAgentArtifacts: Array<{ chat: SuperAgentChat; artifact: SuperAgentArtifact }> = [];

  for (const chat of chats) {
    for (const artifact of chat.artifacts) {
      const prov: ChatProvenance = {
        chatId: chat.id,
        chatTitle: chat.title,
        artifactId: artifact.id,
        updatedAt: artifact.updatedAt || chat.updatedAt,
      };
      if (artifact.assetId) recordNewestProvenance(assetChatMap, artifact.assetId, prov);
      if (artifact.kind === 'motion-project') recordNewestProvenance(motionChatMap, artifact.projectId, prov);
      if (artifact.kind === 'motion-export') {
        recordNewestProvenance(motionExportChatMap, artifact.jobId, prov);
        recordNewestProvenance(motionChatMap, artifact.projectId, prov);
      }
      if (artifact.kind === 'design-project') recordNewestProvenance(designChatMap, artifact.projectId, prov);
      if (artifact.kind === 'game-project') recordNewestProvenance(gameChatMap, artifact.projectId, prov);
      if (artifact.kind === 'brand-kit') recordNewestProvenance(brandKitChatMap, artifact.kitId, prov);
      if (artifact.kind === 'web') {
        exclusiveAgentArtifacts.push({ chat, artifact });
      }
    }
  }

  const assetRunMap = new Map<string, RunProvenance>();
  const designRunMap = new Map<string, RunProvenance>();
  const motionRunMap = new Map<string, RunProvenance>();

  for (const run of runBundle.runs) {
    if (run.archivedAt) continue;
    const prov: RunProvenance = {
      scenarioId: run.scenarioId,
      runId: run.id,
      runTitle: run.title,
      updatedAt: run.updatedAt,
    };
    for (const poolItem of run.pool) {
      if (poolItem.ref.type === 'asset') recordNewestProvenance(assetRunMap, poolItem.ref.assetId, prov);
      if (poolItem.ref.type === 'design') recordNewestProvenance(designRunMap, poolItem.ref.projectId, prov);
      if (poolItem.ref.type === 'motion') recordNewestProvenance(motionRunMap, poolItem.ref.projectId, prov);
    }
    for (const step of Object.values(run.steps)) {
      if (step.links.designProjectId) recordNewestProvenance(designRunMap, step.links.designProjectId, prov);
      if (step.links.motionProjectId) recordNewestProvenance(motionRunMap, step.links.motionProjectId, prov);
    }
  }

  const items: UnifiedLibraryItem[] = [];

  // 1. Media assets (images, videos, audio)
  for (const asset of assets) {
    const version = assetVersion(asset);
    const versionId = version?.id ?? asset.currentVersionId;
    const chatProv = assetChatMap.get(asset.id);
    const runProv = assetRunMap.get(asset.id);
    const linkedJob = version?.jobId ? jobsById.get(version.jobId) : undefined;

    let origin: Exclude<UnifiedLibraryOrigin, 'all'> = 'studio';
    let originLabel = modalityStudioLabel(asset.modality);
    if (chatProv) {
      origin = 'super-agent';
      originLabel = chatProv.chatTitle;
    } else if (runProv) {
      origin = 'workflow';
      originLabel = runProv.runTitle;
    } else if (version?.source === 'upload') {
      origin = 'upload';
      originLabel = 'Local upload';
    } else if (version?.conversationId) {
      origin = 'studio';
      originLabel = modalityStudioLabel(asset.modality);
    } else if (linkedJob) {
      origin = 'mcp';
      originLabel = 'MCP & Agents';
    }

    items.push({
      id: `asset:${asset.id}`,
      kind: 'asset',
      category: modalityCategory(asset.modality),
      title: asset.name,
      subtitle: version?.prompt?.trim() || version?.filename,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
      origin,
      originLabel,
      moduleLabel: modalityStudioLabel(asset.modality),
      badgeLabel: version?.filename ? path.extname(version.filename).replace('.', '').toUpperCase() || undefined : undefined,
      ...(chatProv ? { sourceChatId: chatProv.chatId, sourceChatTitle: chatProv.chatTitle } : {}),
      ...(runProv ? { sourceScenarioId: runProv.scenarioId, sourceRunId: runProv.runId, sourceRunTitle: runProv.runTitle } : {}),
      previewUrl: assetMediaUrl(asset.id, versionId),
      downloadUrl: assetDownloadUrl(asset.id, versionId, asset.name),
      mimeType: version?.mimeType,
      filename: version?.filename,
      bytes: version?.bytes,
      width: version?.width,
      height: version?.height,
      duration: version?.duration,
      model: version?.model,
      canTrash: true,
      target: { kind: 'asset', assetId: asset.id, versionId },
    });
  }

  // 2. Motion projects
  const motionWithTimes = await Promise.all(
    motionProjects.map(async project => {
      const mtime = project.openedAt ?? project.createdAt
        ? 0
        : await readDirectoryMtime(rootStore.projectDirectoryFor(project.id));
      const updatedAt = project.openedAt ?? project.createdAt ?? (mtime || nowFallback);
      const createdAt = project.createdAt ?? updatedAt;
      return { project, createdAt, updatedAt };
    }),
  );

  for (const { project, createdAt, updatedAt } of motionWithTimes) {
    const chatProv = motionChatMap.get(project.id);
    const runProv = motionRunMap.get(project.id);
    let origin: Exclude<UnifiedLibraryOrigin, 'all'> = 'studio';
    let originLabel = 'Motion Studio';
    if (chatProv) {
      origin = 'super-agent';
      originLabel = chatProv.chatTitle;
    } else if (runProv) {
      origin = 'workflow';
      originLabel = runProv.runTitle;
    }
    items.push({
      id: `motion:${project.id}`,
      kind: 'motion-project',
      category: 'motion',
      title: project.title,
      subtitle: 'Motion project',
      createdAt,
      updatedAt,
      origin,
      originLabel,
      moduleLabel: 'Motion Studio',
      badgeLabel: 'Motion',
      ...(chatProv ? { sourceChatId: chatProv.chatId, sourceChatTitle: chatProv.chatTitle } : {}),
      ...(runProv ? { sourceScenarioId: runProv.scenarioId, sourceRunId: runProv.runId, sourceRunTitle: runProv.runTitle } : {}),
      target: { kind: 'motion-project', projectId: project.id },
    });
  }

  // 3. Completed Motion MP4 exports
  for (const { job, bytes } of completedExports) {
    const projectTitle = job.projectId ? motionTitleById.get(job.projectId) : undefined;
    const chatProv = motionExportChatMap.get(job.id) ?? (job.projectId ? motionChatMap.get(job.projectId) : undefined);
    const runProv = job.projectId ? motionRunMap.get(job.projectId) : undefined;
    const origin: Exclude<UnifiedLibraryOrigin, 'all'> = chatProv
      ? 'super-agent'
      : runProv
        ? 'workflow'
        : job.phase1
          ? 'mcp'
          : 'studio';
    const originLabel = chatProv
      ? chatProv.chatTitle
      : runProv
        ? runProv.runTitle
        : job.phase1
          ? 'MCP & Agents'
          : 'Motion Studio';
    const downloadUrl = `/motion-api/exports/${encodeURIComponent(job.id)}/file`;
    const updatedAt = job.terminalAt ?? job.acceptedAt ?? job.createdAt;
    items.push({
      id: `motion-export:${job.id}`,
      kind: 'motion-export',
      category: 'videos',
      title: job.outputName || `${projectTitle || 'Motion export'}.mp4`,
      subtitle: projectTitle || 'Rendered video',
      createdAt: job.createdAt,
      updatedAt,
      origin,
      originLabel,
      moduleLabel: 'Motion Studio',
      badgeLabel: 'MP4',
      ...(chatProv ? { sourceChatId: chatProv.chatId, sourceChatTitle: chatProv.chatTitle } : {}),
      ...(runProv ? { sourceScenarioId: runProv.scenarioId, sourceRunId: runProv.runId, sourceRunTitle: runProv.runTitle } : {}),
      downloadUrl,
      mimeType: 'video/mp4',
      filename: job.outputName,
      bytes,
      target: { kind: 'motion-export', ...(job.projectId ? { projectId: job.projectId } : {}), jobId: job.id, downloadUrl },
    });
  }

  // 4. Design projects (websites, slides, documents)
  for (const project of designProjects) {
    const chatProv = designChatMap.get(project.id);
    const runProv = designRunMap.get(project.id);
    const scenarioDef = findDesignScenario(project.scenario);
    let origin: Exclude<UnifiedLibraryOrigin, 'all'> = 'studio';
    let originLabel = 'Design Studio';
    if (chatProv) {
      origin = 'super-agent';
      originLabel = chatProv.chatTitle;
    } else if (runProv) {
      origin = 'workflow';
      originLabel = runProv.runTitle;
    } else if (project.source === 'import') {
      origin = 'upload';
      originLabel = 'Local import';
    }
    items.push({
      id: `design:${project.id}`,
      kind: 'design-project',
      category: designScenarioToLibraryCategory(project.scenario),
      title: project.title,
      subtitle: scenarioDef?.label ?? project.scenario,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      origin,
      originLabel,
      moduleLabel: 'Design Studio',
      badgeLabel: scenarioDef?.label ?? project.scenario,
      ...(chatProv ? { sourceChatId: chatProv.chatId, sourceChatTitle: chatProv.chatTitle } : {}),
      ...(runProv ? { sourceScenarioId: runProv.scenarioId, sourceRunId: runProv.runId, sourceRunTitle: runProv.runTitle } : {}),
      target: { kind: 'design-project', projectId: project.id, scenario: project.scenario },
    });
  }

  // 5. User playable games
  for (const game of myGames) {
    const chatProv = gameChatMap.get(game.id);
    const createdAt = parseTimestamp(game.createdAt, nowFallback);
    const updatedAt = parseTimestamp(game.updatedAt, createdAt);
    items.push({
      id: `game:${game.id}`,
      kind: 'game-project',
      category: 'games',
      title: game.title,
      subtitle: game.description?.trim() || `${game.genre} · ${game.status}`,
      createdAt,
      updatedAt,
      origin: chatProv ? 'super-agent' : 'studio',
      originLabel: chatProv ? chatProv.chatTitle : 'Game Studio',
      moduleLabel: 'Game Studio',
      badgeLabel: game.status,
      ...(chatProv ? { sourceChatId: chatProv.chatId, sourceChatTitle: chatProv.chatTitle } : {}),
      ...(normalizeGameCoverUrl(game) ? { previewUrl: normalizeGameCoverUrl(game) } : {}),
      target: { kind: 'game-project', gameId: game.id },
    });
  }

  // 6. Brand Kits
  for (const kit of brandKits) {
    const chatProv = brandKitChatMap.get(kit.id);
    const createdAt = parseTimestamp(kit.createdAt, nowFallback);
    const updatedAt = parseTimestamp(kit.updatedAt, createdAt);
    items.push({
      id: `brand-kit:${kit.id}`,
      kind: 'brand-kit',
      category: 'brand-kits',
      title: kit.name,
      subtitle: brandKitWebsite(kit) ?? kit.url,
      createdAt,
      updatedAt,
      origin: chatProv ? 'super-agent' : 'studio',
      originLabel: chatProv ? chatProv.chatTitle : 'Brand Kit',
      moduleLabel: 'Brand Kit',
      badgeLabel: 'Brand Kit',
      ...(chatProv ? { sourceChatId: chatProv.chatId, sourceChatTitle: chatProv.chatTitle } : {}),
      target: { kind: 'brand-kit', kitId: kit.id },
    });
  }

  // 7. Scenario / Workflow runs
  const summaryByRunId = new Map(runBundle.summaries.map(summary => [summary.id, summary]));
  for (const run of runBundle.runs) {
    if (run.archivedAt) continue;
    const def = findScenario(run.scenarioId as ScenarioId);
    const summary = summaryByRunId.get(run.id);
    const totalSteps = def?.steps.length ?? Object.keys(run.steps).length;
    const doneSteps = summary?.doneSteps ?? Object.values(run.steps).filter(step => step.status === 'done').length;
    items.push({
      id: `workflow:${run.id}`,
      kind: 'workflow-run',
      category: 'workflows',
      title: run.title,
      subtitle: `${def?.title ?? run.scenarioId} · ${doneSteps}/${totalSteps}`,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      origin: 'workflow',
      originLabel: def?.title ?? 'Workflows',
      moduleLabel: 'Workflows',
      badgeLabel: def?.title ?? run.scenarioId,
      sourceScenarioId: run.scenarioId,
      sourceRunId: run.id,
      sourceRunTitle: run.title,
      target: { kind: 'workflow-run', scenarioId: run.scenarioId, runId: run.id },
    });
  }

  // 8. Exclusive Super Agent web deliverables
  for (const { chat, artifact } of exclusiveAgentArtifacts) {
    const cleanUrl = sanitizeExternalWebUrl(artifact.url);
    const updatedAt = artifact.updatedAt || chat.updatedAt;
    items.push({
      id: `super-agent:${chat.id}:${artifact.id}`,
      kind: 'super-agent-web',
      category: 'websites',
      title: artifact.title,
      subtitle: artifact.subtitle?.trim() || cleanUrl || chat.title,
      createdAt: artifact.createdAt || chat.createdAt,
      updatedAt,
      origin: 'super-agent',
      originLabel: chat.title,
      moduleLabel: 'Super Agent',
      badgeLabel: 'Web Page',
      sourceChatId: chat.id,
      sourceChatTitle: chat.title,
      ...(cleanUrl ? { externalUrl: cleanUrl } : {}),
      target: { kind: 'super-agent', chatId: chat.id, artifactId: artifact.id },
    });
  }

  // Apply origin + search filters first so category pill counts stay accurate across tabs.
  const search = query.query?.trim().toLocaleLowerCase() ?? '';
  const originFilter = query.origin && query.origin !== 'all' ? query.origin : null;

  const baseFiltered = items.filter(item => {
    if (originFilter && item.origin !== originFilter) return false;
    if (search && !buildSearchHaystack(item).includes(search)) return false;
    return true;
  });

  const counts = createEmptyLibraryCounts();
  for (const item of baseFiltered) {
    counts.all += 1;
    counts[item.category] += 1;
  }

  const categoryFilter = query.category && query.category !== 'all' ? query.category : null;
  const filtered = categoryFilter
    ? baseFiltered.filter(item => item.category === categoryFilter)
    : baseFiltered;

  const sort = query.sort ?? 'newest';
  filtered.sort((a, b) => {
    if (sort === 'name') {
      return a.title.localeCompare(b.title) || b.updatedAt - a.updatedAt;
    }
    if (sort === 'oldest') {
      return a.updatedAt - b.updatedAt || a.title.localeCompare(b.title);
    }
    return b.updatedAt - a.updatedAt || a.title.localeCompare(b.title);
  });

  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(200, Math.max(1, query.limit ?? 100));
  const paged = filtered.slice(offset, offset + limit);

  return {
    items: paged,
    counts,
    total: filtered.length,
    nextOffset: offset + paged.length < filtered.length ? offset + paged.length : null,
    generatedAt: Date.now(),
  };
}
