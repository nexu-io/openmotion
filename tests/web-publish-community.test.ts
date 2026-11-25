import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountRequestError, type OpenDesignWorkspaceInfo } from '../gateway/account.ts';
import {
  WebPublishService,
  cloudProjectIdFor,
  type WebPublishAccountClient,
} from '../gateway/web-publish.ts';
import { resolveWebPublishTarget } from '../gateway/web-publish-ops.ts';
import { loadBuiltinGameTemplates } from '../scripts/publish-game-templates.ts';
import { pluginRoot } from '../hyperframes.ts';
import { isPaidWebPublishPlan, type WebPublishFeedStatus, type WebPublishVisibility } from '../shared/web-publish.ts';
import { startServer } from '../server.ts';
import { WorkspaceStore } from '../workspace.ts';

function createCommunityMockAccount(planTier: 'free' | 'go' | 'pro') {
  const canUsePrivateShare = isPaidWebPublishPlan(planTier);
  const listings = new Map<
    string,
    {
      visibility: WebPublishVisibility;
      feedStatus: WebPublishFeedStatus;
      allowRemix: boolean;
      communityUrl: string;
      gameMeta?: Record<string, unknown>;
    }
  >();
  const controlCalls: Array<{ method: string; path: string; body?: unknown }> = [];
  const catalogByProject = new Map<string, { schemaVersion: 1; revision: number; files: Array<Record<string, unknown>> }>();
  let versionCounter = 0;

  const workspaces: OpenDesignWorkspaceInfo[] = [
    {
      workspaceId: `ws_${planTier}`,
      workspaceName: `OpenMotion ${planTier}`,
      workspaceType: 'personal',
      workspaceMemberId: `member_${planTier}`,
      role: 'owner',
      isDefault: true,
      memberStatus: 'active',
      lifecycleState: 'active',
    },
  ];

  const client: WebPublishAccountClient = {
    async isSignedIn() {
      return true;
    },
    async listWorkspaces() {
      return workspaces;
    },
    async summary() {
      return {
        state: 'signed-in',
        user: { id: `user_${planTier}`, email: `${planTier}@example.com`, name: planTier.toUpperCase() },
        plan: { id: planTier, name: planTier.toUpperCase(), status: 'active' },
        consoleUrl: 'https://open-design.app',
      };
    },
    async runWithEnv(args) {
      const cmd = args.slice(0, 2).join(' ');
      if (cmd === 'team-projects ensure-private') {
        return JSON.stringify({ projectId: args[2], ok: true });
      }
      if (cmd === 'team-projects register-resource') {
        return JSON.stringify({ ok: true });
      }
      if (cmd === 'team-projects get') {
        const projectId = args[2];
        const state = catalogByProject.get(projectId) ?? { schemaVersion: 1 as const, revision: 0, files: [] };
        return JSON.stringify({
          projectId,
          workspaceId: workspaces[0].workspaceId,
          ownerMemberId: workspaces[0].workspaceMemberId,
          resourceId: `root-${projectId}`,
          metadata: state.revision > 0 || state.files.length > 0 ? { _commentFiles: state } : {},
        });
      }
      if (cmd === 'team-projects upsert') {
        const projectId = args[2];
        const metaIdx = args.indexOf('--metadata-json');
        const payload = JSON.parse(args[metaIdx + 1]) as {
          _commentFiles?: {
            resourceId: string;
            versionId: string;
            files: Array<{ sourceFileId: string; sourceFilePath: string; entryPath: string; retired: boolean }>;
          };
        };
        const current = catalogByProject.get(projectId) ?? { schemaVersion: 1 as const, revision: 0, files: [] };
        const mutation = payload._commentFiles;
        if (mutation) {
          catalogByProject.set(projectId, {
            schemaVersion: 1,
            revision: current.revision + 1,
            files: mutation.files.map(item => ({
              ...item,
              resourceId: mutation.resourceId,
              versionId: mutation.versionId,
            })),
          });
        }
        return JSON.stringify({ projectId, ok: true });
      }
      if (cmd === 'resource push') {
        versionCounter += 1;
        return JSON.stringify({ id: `ver_${versionCounter}` });
      }
      if (cmd === 'share publish') {
        const slug = args[args.indexOf('--slug') + 1];
        const projectId = args[args.indexOf('--project-id') + 1];
        const versionId = args[args.indexOf('--version-id') + 1];
        return JSON.stringify({
          status: 'published',
          slug,
          version: versionCounter,
          publishedAt: 1_700_200_000_000 + versionCounter,
          snapshot: { versionId },
          url: `https://open-design.app/artifact/${projectId}/${slug}`,
        });
      }
      if (cmd === 'share stop') {
        return JSON.stringify({ status: 'stopped', slug: args[2] });
      }
      if (cmd === 'share resume-existing') {
        const slug = args[2];
        const projectId = args[args.indexOf('--project-id') + 1];
        return JSON.stringify({
          status: 'active',
          slug,
          publishedAt: 1_700_200_009_000,
          url: `https://open-design.app/artifact/${projectId}/${slug}`,
        });
      }
      throw new Error(`Unexpected mock CLI args: ${args.join(' ')}`);
    },
    async controlApiJson<T = Record<string, unknown>>(
      apiPath: string,
      options?: { method?: string; body?: unknown },
    ): Promise<T> {
      const method = options?.method ?? 'GET';
      controlCalls.push({ method, path: apiPath, body: options?.body });

      if (apiPath === '/api/v1/collab/game-share-entitlement' && method === 'GET') {
        return {
          canUsePrivateShare,
          planTier,
          requiredPlan: 'go',
        } as T;
      }

      const getListingMatch = apiPath.match(/^\/api\/v1\/collab\/shares\/([^/]+)\/game-listing(?:\?.*)?$/);
      if (getListingMatch && method === 'GET') {
        const slug = decodeURIComponent(getListingMatch[1]);
        const existing = listings.get(slug);
        if (!existing) {
          throw new AccountRequestError(JSON.stringify({ error: 'GAME_LISTING_NOT_FOUND', status: 404 }));
        }
        return {
          visibility: existing.visibility,
          feedStatus: existing.feedStatus,
          allowRemix: existing.allowRemix,
          inCommunityFeed:
            existing.visibility === 'public' &&
            (existing.feedStatus === 'approved' || existing.feedStatus === 'featured'),
          canUsePrivateShare,
          planTier,
          communityPath: `/games/${slug}`,
          communityUrl: existing.communityUrl,
        } as T;
      }

      const listingMatch = apiPath.match(/^\/api\/v1\/collab\/shares\/([^/]+)\/game-listing$/);
      if (listingMatch && method === 'PUT') {
        const slug = decodeURIComponent(listingMatch[1]);
        const body = (options?.body ?? {}) as {
          visibility?: WebPublishVisibility;
          allowRemix?: boolean;
          gameMeta?: Record<string, unknown>;
        };
        const visibility = body.visibility ?? 'public';
        if (visibility === 'unlisted' && !canUsePrivateShare) {
          throw new AccountRequestError(
            JSON.stringify({
              error: 'Private (unlisted) game shares require a paid plan (Go or higher).',
              errorCode: 'PRIVATE_SHARE_REQUIRES_PAID_PLAN',
              status: 403,
            }),
          );
        }
        const existing = listings.get(slug);
        const next = {
          visibility,
          feedStatus: (existing?.feedStatus ?? 'pending') as WebPublishFeedStatus,
          allowRemix: body.allowRemix ?? true,
          communityUrl: `https://open-design.app/games/${slug}`,
          gameMeta: body.gameMeta,
        };
        listings.set(slug, next);
        return {
          visibility: next.visibility,
          feedStatus: next.feedStatus,
          allowRemix: next.allowRemix,
          inCommunityFeed: next.visibility === 'public' && (next.feedStatus === 'approved' || next.feedStatus === 'featured'),
          canUsePrivateShare,
          planTier,
          communityPath: `/games/${slug}`,
          communityUrl: next.communityUrl,
        } as T;
      }

      const visibilityMatch = apiPath.match(/^\/api\/v1\/collab\/shares\/([^/]+)\/visibility$/);
      if (visibilityMatch && method === 'PATCH') {
        const slug = decodeURIComponent(visibilityMatch[1]);
        const body = (options?.body ?? {}) as { visibility?: WebPublishVisibility; allowRemix?: boolean };
        const visibility = body.visibility ?? 'public';
        if (visibility === 'unlisted' && !canUsePrivateShare) {
          throw new AccountRequestError(
            JSON.stringify({
              error: 'Private (unlisted) game shares require a paid plan (Go or higher).',
              errorCode: 'PRIVATE_SHARE_REQUIRES_PAID_PLAN',
              status: 403,
            }),
          );
        }
        const existing = listings.get(slug);
        const next = {
          visibility,
          feedStatus: (existing?.feedStatus ?? 'pending') as WebPublishFeedStatus,
          allowRemix: body.allowRemix ?? existing?.allowRemix ?? true,
          communityUrl: `https://open-design.app/games/${slug}`,
          gameMeta: existing?.gameMeta,
        };
        listings.set(slug, next);
        return {
          visibility: next.visibility,
          feedStatus: next.feedStatus,
          allowRemix: next.allowRemix,
          inCommunityFeed: next.visibility === 'public' && (next.feedStatus === 'approved' || next.feedStatus === 'featured'),
          canUsePrivateShare,
          planTier,
          communityPath: `/games/${slug}`,
          communityUrl: next.communityUrl,
        } as T;
      }

      throw new Error(`Unexpected controlApiJson call: ${method} ${apiPath}`);
    },
  };

  return { client, listings, controlCalls };
}

test('resolveWebPublishTarget extracts complete game community metadata including coverPath, orientation, genre, and i18n', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'om-game-meta-'));
  try {
    const gameDir = path.join(root, 'games', 'neon-pulse');
    await mkdir(gameDir, { recursive: true });
    await writeFile(path.join(gameDir, 'index.html'), '<!doctype html><canvas></canvas>');
    await writeFile(path.join(gameDir, 'cover.webp'), Buffer.from('RIFF0000WEBP'));
    await writeFile(
      path.join(gameDir, 'game.json'),
      JSON.stringify({
        id: 'neon-pulse',
        title: 'Neon Pulse',
        description: 'Dodge laser grids in vertical neon lanes.',
        genre: 'arcade',
        style: 'cyberpunk',
        setting: 'neon-city',
        orientation: 'portrait',
        controls: 'Swipe or A/D to switch lanes',
        cover: 'cover.webp',
        i18n: {
          'zh-CN': {
            title: '霓虹脉冲',
            description: '在竖屏霓虹通道中闪避激光阵。',
            controls: '滑动或 A/D 换道',
          },
        },
        updatedAt: '2026-11-24T12:00:00Z',
      }),
    );

    const store = new WorkspaceStore(root);
    await store.initialize(pluginRoot);
    const target = await resolveWebPublishTarget(store, {
      targetKind: 'game',
      targetId: 'neon-pulse',
    });
    assert.equal(target.kind, 'game');
    assert.equal(target.id, 'neon-pulse');
    assert.ok(target.gameMeta);
    assert.equal(target.gameMeta.title, 'Neon Pulse');
    assert.equal(target.gameMeta.genre, 'arcade');
    assert.equal(target.gameMeta.orientation, 'portrait');
    assert.equal(target.gameMeta.coverPath, 'cover.webp');
    assert.equal(target.gameMeta.i18n?.['zh-CN']?.title, '霓虹脉冲');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('WebPublishService enforces Free=Public (pending Layer 1) and unlocks Unlisted + in-place toggle for Paid Go tier', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'om-community-entitlement-'));
  try {
    const gameDir = path.join(root, 'game-src');
    await mkdir(gameDir, { recursive: true });
    await writeFile(path.join(gameDir, 'index.html'), '<!doctype html><canvas id="c"></canvas>');
    await writeFile(path.join(gameDir, 'cover.webp'), Buffer.from('RIFF0000WEBP'));

    const target = {
      kind: 'game' as const,
      id: 'comet-guard',
      title: 'Comet Guard',
      entryPath: 'index.html',
      sourceRevision: 'rev-1',
      sourcePath: gameDir,
      gameMeta: {
        title: 'Comet Guard',
        description: 'Defend the orbital shield.',
        genre: 'shooter',
        orientation: 'landscape' as const,
        controls: 'Mouse to aim',
        coverPath: 'cover.webp',
        templateId: 'comet-guard',
      },
    };

    // 1. Free plan: status reports canUsePrivateShare=false, unlisted publish rejected with 403, default public succeeds as pending.
    const freeMock = createCommunityMockAccount('free');
    const freeService = new WebPublishService(path.join(root, 'free-data'), freeMock.client);

    const freeStatus = await freeService.status(target);
    assert.equal(freeStatus.canUsePrivateShare, false);
    assert.equal(freeStatus.accountPlan, 'free');

    await assert.rejects(
      () => freeService.publish(target, { visibility: 'unlisted' }),
      (err: unknown) =>
        (err instanceof AccountRequestError &&
          err.status === 403 &&
          err.code === 'PRIVATE_SHARE_REQUIRES_PAID_PLAN') ||
        (err instanceof Error && err.message.includes('PRIVATE_SHARE_REQUIRES_PAID_PLAN')),
    );

    const freePub = await freeService.publish(target);
    assert.equal(freePub.publication.visibility, 'public');
    assert.equal(freePub.publication.feedStatus, 'pending');
    assert.equal(freePub.publication.communityUrl, `https://open-design.app/games/${freePub.publication.slug}`);
    assert.equal(freePub.publication.cloudProjectId, cloudProjectIdFor('game', 'comet-guard'));

    // Free user cannot toggle published game to unlisted either.
    await assert.rejects(
      () => freeService.setVisibility(target, { visibility: 'unlisted' }),
      (err: unknown) =>
        (err instanceof AccountRequestError &&
          err.status === 403 &&
          err.code === 'PRIVATE_SHARE_REQUIRES_PAID_PLAN') ||
        (err instanceof Error && err.message.includes('PRIVATE_SHARE_REQUIRES_PAID_PLAN')),
    );

    // 2. Paid Go plan (lowest paid tier): can publish unlisted directly and toggle to public in place preserving slug.
    const goMock = createCommunityMockAccount('go');
    const goService = new WebPublishService(path.join(root, 'go-data'), goMock.client);

    const goStatus = await goService.status(target);
    assert.equal(goStatus.canUsePrivateShare, true);
    assert.equal(goStatus.accountPlan, 'go');

    const goPub = await goService.publish(target, { visibility: 'unlisted' });
    assert.equal(goPub.publication.visibility, 'unlisted');
    assert.equal(goPub.publication.communityUrl, `https://open-design.app/games/${goPub.publication.slug}`);

    const toggled = await goService.setVisibility(target, { visibility: 'public' });
    assert.equal(toggled.publication.slug, goPub.publication.slug);
    assert.equal(toggled.publication.url, goPub.publication.url);
    assert.equal(toggled.publication.visibility, 'public');
    assert.equal(toggled.publication.feedStatus, 'pending');

    // 3. Offline curation promotes game to featured -> status() reflects it immediately (even with refresh=false)!
    const cur = goMock.listings.get(goPub.publication.slug)!;
    goMock.listings.set(goPub.publication.slug, { ...cur, feedStatus: 'featured' });
    const statusAfterCuration = await goService.status(target);
    assert.equal(statusAfterCuration.active?.feedStatus, 'featured');
    assert.equal(statusAfterCuration.active?.url, `https://open-design.app/games/${goPub.publication.slug}`);

    // 4. Stop (unpublish) + fast-path resume preserves /games/:slug communityUrl & visibility!
    await goService.unpublish(target);
    const resumed = await goService.publish(target, { mode: 'resume', visibility: 'public' });
    assert.equal(resumed.publication.status, 'published');
    assert.equal(resumed.publication.slug, goPub.publication.slug);
    assert.equal(resumed.publication.communityUrl, `https://open-design.app/games/${goPub.publication.slug}`);
    assert.equal(resumed.publication.url, `https://open-design.app/games/${goPub.publication.slug}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadBuiltinGameTemplates loads all 26 next-branch built-in templates cleanly for cold-start deployment', async () => {
  const templates = await loadBuiltinGameTemplates();
  assert.equal(templates.length, 26);

  const ids = new Set<string>();
  let portraitCount = 0;
  let landscapeCount = 0;
  for (const tpl of templates) {
    assert.equal(tpl.kind, 'game');
    assert.ok(tpl.id.length > 0);
    assert.ok(!ids.has(tpl.id), `duplicate template id: ${tpl.id}`);
    ids.add(tpl.id);
    assert.ok(tpl.gameMeta?.title, `missing title for ${tpl.id}`);
    assert.equal(tpl.gameMeta?.templateId, tpl.id);
    assert.ok(tpl.gameMeta?.coverPath, `missing coverPath for ${tpl.id}`);
    if (tpl.gameMeta?.orientation === 'portrait') portraitCount += 1;
    else landscapeCount += 1;
  }
  assert.ok(portraitCount > 0, 'expected at least one portrait template');
  assert.ok(landscapeCount > 0, 'expected at least one landscape template');

  // Filtering via --only returns exact subset.
  const subset = await loadBuiltinGameTemplates(new Set(['sky-runner', 'comet-guard']));
  assert.deepEqual(
    subset.map(item => item.id).sort(),
    ['comet-guard', 'sky-runner'],
  );
});

test('OpenMotion server PATCH /api/web-publish/game/:id maps visibility validation cleanly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'om-server-vis-'));
  const store = new WorkspaceStore(root);
  await store.initialize(pluginRoot);
  const gameDir = path.join(root, 'games', 'demo-vis');
  await mkdir(gameDir, { recursive: true });
  await writeFile(path.join(gameDir, 'index.html'), '<!doctype html><h1>Demo</h1>');
  await writeFile(
    path.join(gameDir, 'game.json'),
    JSON.stringify({ id: 'demo-vis', title: 'Demo Vis', orientation: 'landscape', updatedAt: '2026-11-24T00:00:00Z' }),
  );

  const running = await startServer(store, 0, { editor: false });
  const port = (running.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${origin}/motion-api/web-publish/game/demo-vis`, {
      method: 'PATCH',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'invalid-mode' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: { code?: string; message?: string } | string };
    const message = typeof body.error === 'string' ? body.error : body.error?.message ?? '';
    assert.match(message, /public|unlisted/i);

    // Non-game targets (e.g. design) are strictly rejected from the game visibility endpoint.
    const designPatch = await fetch(`${origin}/motion-api/web-publish/design/demo-design`, {
      method: 'PATCH',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'unlisted' }),
    });
    assert.equal(designPatch.status, 400);
    const designPatchBody = (await designPatch.json()) as { error?: { code?: string; message?: string } | string };
    const designPatchMsg = typeof designPatchBody.error === 'string'
      ? designPatchBody.error
      : designPatchBody.error?.message ?? '';
    assert.match(designPatchMsg, /only supported for game/i);
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('non-game Cloud Deploy (design/motion/html) never enters the game community pipeline', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'om-design-isolated-'));
  try {
    const designDir = path.join(root, 'design-src');
    await mkdir(designDir, { recursive: true });
    await writeFile(path.join(designDir, 'index.html'), '<!doctype html><h1>Design Poster</h1>');

    const designTarget = {
      kind: 'design' as const,
      id: 'poster-v1',
      title: 'Poster V1',
      entryPath: 'index.html',
      sourceRevision: 'rev-1',
      sourcePath: designDir,
    };

    const freeMock = createCommunityMockAccount('free');
    const service = new WebPublishService(path.join(root, 'design-data'), freeMock.client);

    // 1. Status must NOT touch game-share-entitlement or game-listing APIs.
    const beforeStatus = await service.status(designTarget);
    assert.equal(beforeStatus.canUsePrivateShare, undefined);
    assert.equal(freeMock.controlCalls.length, 0);

    // 2. Publish (even if visibility="unlisted" is mistakenly passed) skips game entitlement & listing sync
    //    and returns the original /artifact/:projectId/:slug link without ?kind=game or /games/:slug.
    const published = await service.publish(designTarget, { visibility: 'unlisted' });
    assert.equal(freeMock.controlCalls.length, 0);
    assert.equal(freeMock.listings.size, 0);
    assert.equal(published.publication.communityUrl, undefined);
    assert.equal(published.publication.visibility, undefined);
    assert.equal(published.publication.feedStatus, undefined);
    assert.match(published.url ?? '', /^https:\/\/open-design\.app\/artifact\/[^/]+\/[^/?]+$/);
    assert.ok(!(published.url ?? '').includes('kind=game'));

    // 3. Unpublish + fast-path resume keeps the exact same original /artifact link with zero game API calls.
    await service.unpublish(designTarget);
    const resumed = await service.publish(designTarget, { mode: 'resume' });
    assert.equal(freeMock.controlCalls.length, 0);
    assert.equal(resumed.url, published.url);
    assert.equal(resumed.publication.communityUrl, undefined);

    // 4. setVisibility strictly rejects non-game deployments.
    await assert.rejects(
      () => service.setVisibility(designTarget, { visibility: 'unlisted' }),
      /only supported for game/i,
    );
    assert.equal(freeMock.controlCalls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('WebPublishService hydrates missing billing plan via refresh=true and tolerates 404 game-listing endpoints', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'om-pro-hydrate-'));
  try {
    const gameDir = path.join(root, 'pro-game');
    await mkdir(gameDir, { recursive: true });
    await writeFile(path.join(gameDir, 'index.html'), '<!doctype html><h1>Pro Game</h1>');

    const baseMock = createCommunityMockAccount('pro');
    const summaryCalls: Array<boolean | undefined> = [];
    const client: WebPublishAccountClient = {
      isSignedIn: baseMock.client.isSignedIn,
      listWorkspaces: baseMock.client.listWorkspaces,
      runWithEnv: baseMock.client.runWithEnv,
      async summary(refresh?: boolean) {
        summaryCalls.push(refresh);
        if (!refresh) {
          return {
            state: 'signed-in',
            user: { id: 'user_pro', email: 'pro@example.com', name: 'PRO' },
            billingUnavailable: false,
            consoleUrl: 'https://open-design.app',
          };
        }
        return {
          state: 'signed-in',
          user: { id: 'user_pro', email: 'pro@example.com', name: 'PRO' },
          plan: 'pro',
          balance: '125.00',
          billingUnavailable: false,
          consoleUrl: 'https://open-design.app',
        };
      },
      async controlApiJson(apiPath: string, options?: { method?: string }) {
        const method = options?.method ?? 'GET';
        if (apiPath === '/api/v1/collab/game-share-entitlement' && method === 'GET') {
          throw new Error(`DEPLOY_FAILED: OpenDesign API ${apiPath} failed (404: NOT_FOUND)`);
        }
        if (/^\/api\/v1\/collab\/shares\/[^/]+\/game-listing$/.test(apiPath) && method === 'PUT') {
          throw new Error(`DEPLOY_FAILED: OpenDesign API ${apiPath} failed (404: NOT_FOUND)`);
        }
        if (/^\/api\/v1\/collab\/shares\/[^/]+\/visibility$/.test(apiPath) && method === 'PATCH') {
          throw new Error(`DEPLOY_FAILED: OpenDesign API ${apiPath} failed (404: NOT_FOUND)`);
        }
        throw new Error(`Unexpected controlApiJson call: ${method} ${apiPath}`);
      },
    };

    const service = new WebPublishService(path.join(root, 'pub-data'), client);
    const target = {
      kind: 'game' as const,
      id: 'pro-game',
      title: 'Pro Game',
      entryPath: 'index.html',
      sourceRevision: 'rev-pro-1',
      sourcePath: gameDir,
    };

    // 1. status() refreshes billing when initial summary omits plan, unlocking Pro private share despite 404 entitlement endpoint.
    const status = await service.status(target);
    assert.deepEqual(summaryCalls, [undefined, true]);
    assert.equal(status.accountPlan, 'pro');
    assert.equal(status.canUsePrivateShare, true);

    // 2. publish() succeeds with fallback artifact share URL when legacy cloud API returns 404 on PUT game-listing.
    const published = await service.publish(target, { visibility: 'unlisted' });
    assert.equal(published.publication.status, 'published');
    assert.equal(published.publication.visibility, 'unlisted');
    assert.match(published.url ?? '', /^https:\/\/open-design\.app\/artifact\/[^/]+\/[^?]+\?kind=game$/);

    // 3. setVisibility() switches cleanly when legacy cloud API returns 404 on PATCH visibility.
    const toggled = await service.setVisibility(target, { visibility: 'public' });
    assert.equal(toggled.publication.visibility, 'public');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
