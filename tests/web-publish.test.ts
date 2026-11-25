import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { designProjectsFor } from '../design-projects.ts';
import { GameProjects, gameProjectsFor } from '../game-projects.ts';
import { AccountRequestError, OpenDesignAccount, type OpenDesignWorkspaceInfo } from '../gateway/account.ts';
import { AssetLibrary, atomicAssetJson } from '../gateway/asset-library.ts';
import {
  cloudProjectIdFor,
  shareViewerUrlForTarget,
  WebPublishService,
  type WebPublishAccountClient,
} from '../gateway/web-publish.ts';
import { buildPublishBundle } from '../gateway/web-publish-bundle.ts';
import { pluginRoot } from '../hyperframes.ts';
import { atomicJson } from '../phase1-versions.ts';
import { startServer } from '../server.ts';
import { MCP_HTTP_PATH, MCP_TOKENS_API } from '../shared/mcp-http.ts';
import { webPublishRoutes } from '../shared/web-publish.ts';
import { WorkspaceStore } from '../workspace.ts';
import { fixture } from './fixtures.ts';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

function createMockWebPublishAccount() {
  const stagedFilesByPush: Array<{ root: string; metadata: Record<string, unknown> }> = [];
  const catalogByProject = new Map<string, { schemaVersion: 1; revision: number; files: Array<Record<string, unknown>> }>();
  let versionCounter = 0;

  const workspaces: OpenDesignWorkspaceInfo[] = [
    {
      workspaceId: 'ws_web_1',
      workspaceName: 'OpenMotion Cloud',
      workspaceType: 'personal',
      workspaceMemberId: 'member_web_1',
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
          workspaceId: 'ws_web_1',
          ownerMemberId: 'member_web_1',
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
        const mutation = payload._commentFiles!;
        if (mutation.files.some(file => current.files.some(previous =>
          !file.retired && !previous.retired && file.sourceFilePath === previous.sourceFilePath
          && file.sourceFileId !== previous.sourceFileId,
        ))) {
          throw new AccountRequestError('API request failed with status 409');
        }
        catalogByProject.set(projectId, {
          schemaVersion: 1,
          revision: current.revision + 1,
          files: mutation.files.map(item => ({
            ...item,
            resourceId: mutation.resourceId,
            versionId: mutation.versionId,
          })),
        });
        return JSON.stringify({ projectId, ok: true });
      }
      if (cmd === 'resource push') {
        const metaIdx = args.indexOf('--metadata-json');
        stagedFilesByPush.push({
          root: args[4],
          metadata: JSON.parse(args[metaIdx + 1]) as Record<string, unknown>,
        });
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
          publishedAt: 1_700_100_000_000 + versionCounter,
          snapshot: { versionId },
          url: `https://open-design.app/artifact/${projectId}/${slug}`,
        });
      }
      if (cmd === 'share stop') {
        return JSON.stringify({ status: 'stopped', slug: args[2] });
      }
      throw new Error(`Unexpected mock args: ${args.join(' ')}`);
    },
  };

  return { client, stagedFilesByPush };
}

test('WebPublishService publishes design, game, and standalone single-file HTML targets uniformly and reads legacy design records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'om-web-publish-unit-'));
  try {
    const dataDir = path.join(root, 'data');
    const designDir = path.join(root, 'design-bundle');
    const gameDir = path.join(root, 'game-bundle');
    const singleHtml = path.join(root, 'architecture-map.html');

    await mkdir(designDir, { recursive: true });
    await mkdir(path.join(gameDir, 'assets'), { recursive: true });
    await writeFile(path.join(designDir, 'index.html'), '<!doctype html><h1>Design</h1>');
    await writeFile(path.join(gameDir, 'index.html'), '<!doctype html><canvas id="game"></canvas>');
    await writeFile(path.join(gameDir, 'assets/sprite.svg'), '<svg></svg>');
    await writeFile(singleHtml, '<!doctype html><h1>Standalone Architecture Map</h1>');

    const mock = createMockWebPublishAccount();
    const service = new WebPublishService(dataDir, mock.client);

    // 1. Design target preserves native design project ID
    const designRes = await service.publish({
      kind: 'design',
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Marketing Page',
      entryPath: 'index.html',
      sourceRevision: 'rev-d1',
      sourcePath: designDir,
    });
    assert.equal(designRes.publication.targetKind, 'design');
    assert.equal(designRes.publication.cloudProjectId, '11111111-1111-4111-8111-111111111111');
    assert.ok(designRes.url?.includes('11111111-1111-4111-8111-111111111111'));

    // 2. Game target derives deterministic collision-free UUID
    const expectedGameCloudId = cloudProjectIdFor('game', 'arcade-shooter');
    assert.match(expectedGameCloudId, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    const gameRes = await service.publish({
      kind: 'game',
      id: 'arcade-shooter',
      title: 'Arcade Shooter',
      entryPath: 'index.html',
      sourceRevision: 'rev-g1',
      sourcePath: gameDir,
    });
    assert.equal(gameRes.publication.targetKind, 'game');
    assert.equal(gameRes.publication.targetId, 'arcade-shooter');
    assert.equal(gameRes.publication.cloudProjectId, expectedGameCloudId);
    assert.equal(gameRes.publication.fileCount, 2);
    assert.equal(mock.stagedFilesByPush[1].metadata.targetKind, 'game');
    // Game shares open the cloud viewer without comments; other kinds keep comments.
    assert.equal(new URL(gameRes.url ?? '').searchParams.get('kind'), 'game');
    assert.equal(new URL(designRes.url ?? '').searchParams.get('kind'), null);
    const gameStatus = await service.status({ kind: 'game', id: 'arcade-shooter', entryPath: 'index.html' });
    assert.equal(new URL(gameStatus.active?.url ?? '').searchParams.get('kind'), 'game');

    // 3. Standalone single HTML file is staged cleanly as entryPath="index.html"
    const htmlRes = await service.publish({
      kind: 'html',
      id: 'arch-map-demo',
      title: 'Architecture Map',
      entryPath: 'index.html',
      sourceRevision: 'rev-h1',
      sourcePath: singleHtml,
    });
    assert.equal(htmlRes.publication.targetKind, 'html');
    assert.equal(htmlRes.publication.fileCount, 1);
    assert.ok(htmlRes.url?.startsWith('https://open-design.app/artifact/'));
    assert.equal(new URL(htmlRes.url ?? '').searchParams.get('kind'), null);

    // 4. Unified catalog listAll returns all three target kinds
    const listing = await service.listAll();
    assert.equal(listing.accountSignedIn, true);
    assert.equal(listing.publications.length, 3);
    assert.deepEqual(
      listing.publications.map(p => p.targetKind).sort(),
      ['design', 'game', 'html'],
    );
    for (const publication of listing.publications) {
      const kind = new URL(publication.url ?? '').searchParams.get('kind');
      assert.equal(kind, publication.targetKind === 'game' ? 'game' : null);
    }

    // 5. Legacy design-projects/deployments/<id>.json fallback works seamlessly
    const legacyId = '22222222-2222-4222-8222-222222222222';
    await mkdir(path.join(dataDir, 'design-projects', 'deployments'), { recursive: true });
    await atomicJson(path.join(dataDir, 'design-projects', 'deployments', `${legacyId}.json`), {
      schemaVersion: 1,
      reservations: {},
      deployments: {
        'index.html': {
          schemaVersion: 1,
          projectId: legacyId,
          filePath: 'index.html',
          entryPath: 'index.html',
          name: 'Legacy Design',
          workspaceId: 'ws_web_1',
          ownerMemberId: 'member_web_1',
          resourceId: 'res-legacy',
          sourceFileId: 'sf-legacy',
          sourceKey: 'sk-legacy',
          slug: 'legacy-slug',
          version: 1,
          versionId: 'ver-legacy',
          status: 'published',
          url: `https://open-design.app/artifact/${legacyId}/legacy-slug`,
          publishedAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          fileCount: 1,
          totalBytes: 120,
          sourceRevision: 'rev-legacy',
        },
      },
    });
    const legacyStatus = await service.status({
      kind: 'design',
      id: legacyId,
      entryPath: 'index.html',
    });
    assert.equal(legacyStatus.active?.slug, 'legacy-slug');
    assert.equal(legacyStatus.active?.targetKind, 'design');
    assert.equal(legacyStatus.active?.cloudProjectId, legacyId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Unified /motion-api/web-publish HTTP routes and Streamable HTTP openmotion_assets_use action=web_publish enforce validation and auth', () =>
  fixture(async store => {
    // Create a local playable game inside workspace dataDirectory
    const games = new GameProjects(store.directory);
    const createdGame = (await games.create({
      prompt: 'Neon Grid Runner',
      multiplayer: false,
      genre: 'shooter',
    })).game;

    const running = await startServer(store, 0, { editor: false });
    const port = (running.server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;

    try {
      // 1. Unified list endpoint returns empty list initially
      const listRes = await fetch(`${origin}${webPublishRoutes.list}`);
      assert.equal(listRes.status, 200);
      const listPayload = (await listRes.json()) as {
        accountSignedIn: boolean;
        publications: unknown[];
      };
      assert.equal(typeof listPayload.accountSignedIn, 'boolean');
      assert.deepEqual(listPayload.publications, []);

      // 2. Game status endpoint resolves GameProjects targets cleanly
      const gameStatusRes = await fetch(`${origin}${webPublishRoutes.target('game', createdGame.id)}`);
      assert.equal(gameStatusRes.status, 200);
      const gameStatus = (await gameStatusRes.json()) as {
        targetKind: string;
        targetId: string;
        active: unknown;
      };
      assert.equal(gameStatus.targetKind, 'game');
      assert.equal(gameStatus.targetId, createdGame.id);
      assert.equal(gameStatus.active, null);

      // 2b. Game ZIP export returns a valid archive containing index.html (without game.json)
      const gameExportRes = await fetch(`${origin}/motion-api/games/${encodeURIComponent(createdGame.id)}/export`);
      assert.equal(gameExportRes.status, 200);
      assert.equal(gameExportRes.headers.get('content-type'), 'application/zip');
      assert.match(gameExportRes.headers.get('content-disposition') ?? '', /attachment; filename=/i);
      const zipBuf = Buffer.from(await gameExportRes.arrayBuffer());
      const { unzip } = await import('../scripts/template-library.ts');
      const extracted = unzip(zipBuf);
      assert.ok(extracted.has('index.html'));
      assert.equal(extracted.has('game.json'), false);

      // 3. Invalid targetKind & unknown game map to 400 / 404
      const badKindRes = await fetch(`${origin}/motion-api/web-publish/unknown-kind/abc`);
      assert.equal(badKindRes.status, 400);
      const missingGameRes = await fetch(`${origin}${webPublishRoutes.target('game', 'missing-game-id')}`);
      assert.equal(missingGameRes.status, 404);

      // 4. Streamable HTTP /mcp openmotion_assets_use action=web_publish list & status + read token guard
      const [readRes, writeRes] = await Promise.all([
        fetch(`${origin}${MCP_TOKENS_API}`, {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Read WebPublish Test', scope: 'read' }),
        }),
        fetch(`${origin}${MCP_TOKENS_API}`, {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Write WebPublish Test', scope: 'write' }),
        }),
      ]);
      const readToken = ((await readRes.json()) as { token: string }).token;
      const writeToken = ((await writeRes.json()) as { token: string }).token;

      async function mcpRpc(token: string, body: Record<string, unknown>, sessionId?: string) {
        const res = await fetch(`${origin}${MCP_HTTP_PATH}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
          },
          body: JSON.stringify(body),
        });
        const payload = await res.json();
        return { res, payload, sessionId: res.headers.get('Mcp-Session-Id') ?? sessionId };
      }

      const initWrite = await mcpRpc(writeToken, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'web-publish-test', version: '1.0.0' },
        },
      });
      assert.ok(initWrite.sessionId);

      const mcpList = await mcpRpc(
        writeToken,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'openmotion_assets_use',
            arguments: { action: 'web_publish', webPublish: { command: 'list' } },
          },
        },
        initWrite.sessionId,
      );
      assert.equal(mcpList.payload.error, undefined);
      const parsedList = JSON.parse(mcpList.payload.result.content[0].text) as { publications: unknown[] };
      assert.deepEqual(parsedList.publications, []);

      const mcpGameStatus = await mcpRpc(
        writeToken,
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'openmotion_assets_use',
            arguments: {
              action: 'web_publish',
              webPublish: { command: 'status', targetKind: 'game', targetId: createdGame.id },
            },
          },
        },
        initWrite.sessionId,
      );
      assert.equal(mcpGameStatus.payload.error, undefined);
      const parsedGameStatus = JSON.parse(mcpGameStatus.payload.result.content[0].text) as {
        targetKind: string;
        targetId: string;
      };
      assert.equal(parsedGameStatus.targetKind, 'game');
      assert.equal(parsedGameStatus.targetId, createdGame.id);

      // Validated MCP adapter accepts embedUrl for community games
      const mcpEmbedStatus = await mcpRpc(
        writeToken,
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'openmotion_assets_use',
            arguments: {
              action: 'web_publish',
              webPublish: {
                command: 'status',
                targetKind: 'game',
                targetId: 'community-demo',
                embedUrl: 'https://example.com/play/',
                title: 'Community Demo',
              },
            },
          },
        },
        initWrite.sessionId,
      );
      assert.equal(mcpEmbedStatus.payload.error, undefined);
      assert.notEqual(mcpEmbedStatus.payload.result?.isError, true);
      const parsedEmbedStatus = JSON.parse(mcpEmbedStatus.payload.result.content[0].text) as {
        targetKind: string;
        targetId: string;
      };
      assert.equal(parsedEmbedStatus.targetKind, 'game');
      assert.equal(parsedEmbedStatus.targetId, 'community-demo');

      // Read-scoped token cannot call openmotion_assets_use action=web_publish
      const initRead = await mcpRpc(readToken, {
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'readonly-web-publish', version: '1.0.0' },
        },
      });
      const forbidden = await mcpRpc(
        readToken,
        {
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'openmotion_assets_use',
            arguments: {
              action: 'web_publish',
              webPublish: { command: 'publish', targetKind: 'game', targetId: createdGame.id },
            },
          },
        },
        initRead.sessionId,
      );
      assert.equal(forbidden.payload.error?.code, -32003);
      assert.match(String(forbidden.payload.error?.message), /MCP_SCOPE_FORBIDDEN/);
    } finally {
      await running.close();
    }
  }));

test('buildPublishBundle and WebPublishService rewrite local assets/routes into relative paths, exclude game metadata, and track freshness', () =>
  fixture(async store => {
    const games = gameProjectsFor(store.directory);
    const created = (await games.create({ prompt: 'Bundle Quest arcade game', multiplayer: false })).game;

    const pngPath = path.join(store.directory, 'hero-sprite.png');
    const pngBytes = Buffer.from(TINY_PNG_BASE64, 'base64');
    await writeFile(pngPath, pngBytes);
    const asset = await new AssetLibrary(store).importFile(pngPath, { requestId: 'sprite-1', name: 'Hero Sprite' });
    const assetVersionId = asset.currentVersionId!;
    const mediaUrl = `/motion-api/assets/${asset.id}/versions/${assetVersionId}/media`;
    const localLogicUrl = `/motion-api/games/${created.id}/play/logic.js`;

    await games.write(created.id, [
      {
        path: 'index.html',
        content: `<!doctype html><html><body><img src="${mediaUrl}?v=1" /><script type="module" src="${localLogicUrl}"></script></body></html>`,
      },
      {
        path: 'logic.js',
        content: `export const SPRITE = "${mediaUrl}"; export const score = 10;\n`,
      },
    ]);

    const located = await games.locate(created.id);
    await mkdir(path.join(located.dir, 'trailer'), { recursive: true });
    await writeFile(path.join(located.dir, 'trailer', 'clip.mp4'), 'trailer-placeholder');

    await mkdir(path.join(located.dir, 'assets', 'playtests'), { recursive: true });
    await writeFile(path.join(located.dir, 'assets', 'playtests', 'private.png'), pngBytes);
    await writeFile(path.join(located.dir, 'assets', 'runtime.png'), pngBytes);
    await writeFile(path.join(located.dir, 'assets', 'cover.png'), pngBytes);
    await mkdir(path.join(located.dir, 'Design'), { recursive: true });
    await writeFile(path.join(located.dir, 'Design', 'plan.md'), 'Internal uppercase plan');
    await mkdir(path.join(located.dir, 'designs'), { recursive: true });
    await writeFile(path.join(located.dir, 'designs', 'keep.txt'), 'Public sibling directory');
    await games.write(created.id, [{path: 'design/verification.md', content: 'Internal test notes'}]);

    const bundle = await buildPublishBundle({
      dataDirectory: store.directory,
      kind: 'game',
      targetId: created.id,
      sourcePath: located.dir,
      entryPath: 'index.html',
    });
    assert.equal(bundle.entryPath, 'index.html');
    assert.equal(bundle.bundledAssetCount, 1);

    const expectedAssetPath = `_shared-assets/${asset.id}-${assetVersionId}.png`;
    const bundledAsset = bundle.files.find(f => f.file === expectedAssetPath);
    assert.ok(bundledAsset, `expected bundled asset at ${expectedAssetPath}`);
    assert.deepEqual(bundledAsset.data, pngBytes);

    const htmlFile = bundle.files.find(f => f.file === 'index.html');
    const logicFile = bundle.files.find(f => f.file === 'logic.js');
    assert.ok(htmlFile && logicFile);
    assert.match(htmlFile.data.toString('utf8'), new RegExp(`\\./_shared-assets/${asset.id}-${assetVersionId}\\.png`));
    assert.match(htmlFile.data.toString('utf8'), /src="\.\/logic\.js"/);
    assert.ok(!htmlFile.data.toString('utf8').includes('/motion-api/'));
    assert.match(logicFile.data.toString('utf8'), new RegExp(`"\\./_shared-assets/${asset.id}-${assetVersionId}\\.png"`));
    assert.ok(!bundle.files.some(f => f.file.toLowerCase() === 'game.json'), 'game.json must not be staged');
    assert.ok(!bundle.files.some(f => f.file.toLowerCase().startsWith('trailer/')), 'trailer/ must not be staged');

    assert.ok(!bundle.files.some(f => /^(assets\/playtests|design)\//i.test(f.file)));
    assert.ok(bundle.files.some(f => f.file === 'assets/runtime.png'));
    assert.ok(bundle.files.some(f => f.file === 'assets/cover.png'));
    assert.ok(bundle.files.some(f => f.file === 'designs/keep.txt'));

    // Original files on disk remain untouched.
    const diskHtml = await readFile(path.join(located.dir, 'index.html'), 'utf8');
    assert.ok(diskHtml.includes(mediaUrl));
    assert.ok(diskHtml.includes(localLogicUrl));

    // Freshness transitions: unknown -> fresh -> outdated -> fresh.
    const { client } = createMockWebPublishAccount();
    const service = new WebPublishService(store.directory, client);
    const target = {
      kind: 'game' as const,
      id: created.id,
      title: 'Bundle Quest',
      entryPath: 'index.html',
      sourceRevision: String(created.updatedAt),
      sourcePath: located.dir,
    };

    const initialStatus = await service.status(target);
    assert.equal(initialStatus.freshness, 'unknown');
    assert.equal(initialStatus.bundledAssetCount, 1);

    const published = await service.publish(target);
    assert.equal(published.publication.bundledAssetCount, 1);
    assert.ok(published.publication.contentFingerprint);

    const freshStatus = await service.status(target);
    assert.equal(freshStatus.freshness, 'fresh');

    await games.write(created.id, [{ path: 'logic.js', content: `export const SPRITE = "${mediaUrl}"; export const score = 99;\n` }]);
    const outdatedStatus = await service.status(target);
    assert.equal(outdatedStatus.freshness, 'outdated');

    await service.publish(target);
    const republishedStatus = await service.status(target);
    assert.equal(republishedStatus.freshness, 'fresh');

    // Design project relative /motion-api/design/raw/<id>/ rewriting without mutating source.
    const design = designProjectsFor(store.directory);
    const designProj = await design.create({ requestId: 'des-bundle-1', scenario: 'prototype', title: 'Landing Demo' });
    await design.write(designProj.id, {
      requestId: 'des-bundle-w1',
      expectedRevision: designProj.revision,
      files: [
        { path: 'index.html', content: `<!doctype html><html><body><script type="module" src="/motion-api/design/raw/${designProj.id}/app.js?v=1"></script></body></html>` },
        { path: 'app.js', content: 'export const ok = true;\n' },
      ],
    });
    const designBundle = await buildPublishBundle({
      dataDirectory: store.directory,
      kind: 'design',
      targetId: designProj.id,
      sourcePath: design.projectDir(designProj.id),
      entryPath: 'index.html',
    });
    const designHtml = designBundle.files.find(f => f.file === 'index.html');
    assert.ok(designHtml);
    assert.match(designHtml.data.toString('utf8'), /src="\.\/app\.js\?v=1"/);

    // Large >=256 KiB PNG assets are automatically transcoded to lossless WebP when an exact encoder is available,
    // preserving decoded RGBA pixels (including RGB under alpha=0) and keeping original PNG otherwise.
    const zlib = await import('node:zlib');
    const makeLargePng = (w: number, h: number, withAlpha: boolean): Buffer => {
      const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      const crcTable = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[i] = c >>> 0;
      }
      const crc32 = (buf: Buffer) => {
        let c = 0xffffffff;
        for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
      };
      const chunk = (type: string, data: Buffer) => {
        const t = Buffer.from(type, 'ascii');
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
        return Buffer.concat([len, t, data, crc]);
      };
      const channels = withAlpha ? 4 : 3;
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
      ihdr[8] = 8; ihdr[9] = withAlpha ? 6 : 2; // 8-bit RGBA or RGB
      const raw = Buffer.alloc((w * channels + 1) * h);
      let seed = 1337;
      for (let y = 0; y < h; y++) {
        const row = y * (w * channels + 1);
        raw[row] = 0;
        for (let x = 0; x < w; x++) {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          const off = row + 1 + x * channels;
          raw[off] = (x + (seed & 0x3f)) & 0xff;
          raw[off + 1] = (y + ((seed >>> 8) & 0x3f)) & 0xff;
          raw[off + 2] = ((x ^ y) + ((seed >>> 16) & 0x3f)) & 0xff;
          if (withAlpha) raw[off + 3] = x < 32 ? 0 : x < 64 ? 128 : 255;
        }
      }
      const idat = zlib.deflateSync(raw, { level: 1 });
      return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
    };
    const bigPng = makeLargePng(384, 384, true);
    assert.ok(bigPng.length >= 256 * 1024, `expected RGBA fixture PNG >= 256 KiB, got ${bigPng.length}`);
    const bigPath = path.join(store.directory, 'big-sky.png');
    await writeFile(bigPath, bigPng);
    const bigAsset = await new AssetLibrary(store).importFile(bigPath, { requestId: 'big-sky-1', name: 'Big Sky' });
    const bigUrl = `/motion-api/assets/${bigAsset.id}/versions/${bigAsset.currentVersionId!}/media`;
    const bigGame = (await games.create({ prompt: 'Big Asset Compression Test', multiplayer: false })).game;
    const bigLoc = await games.locate(bigGame.id);
    await writeFile(path.join(bigLoc.dir, 'index.html'), `<!doctype html><html><body><img src="${bigUrl}"></body></html>`);
    const bigBundle = await buildPublishBundle({
      dataDirectory: store.directory,
      kind: 'game',
      targetId: bigGame.id,
      sourcePath: bigLoc.dir,
      entryPath: 'index.html',
    });
    const bigBundled = bigBundle.files.find(f => f.file.startsWith('_shared-assets/'));
    assert.ok(bigBundled);
    const bigHtml = bigBundle.files.find(f => f.file === 'index.html')!.data.toString('utf8');
    if (bigBundled.file.endsWith('.webp')) {
      assert.ok(bigBundled.data.length < bigPng.length * 0.95, 'compressed lossless WebP must be smaller than original PNG');
      assert.match(bigHtml, /\.webp/);
      // Verify decoded RGBA pixels (including non-zero RGB under alpha=0) are preserved bit-for-bit identically.
      const { execFileSync } = await import('node:child_process');
      const { verificationBinaries } = await import('../scripts/verify-export.ts');
      const webpTmp = path.join(store.directory, 'big-sky-check.webp');
      await writeFile(webpTmp, bigBundled.data);
      try {
        const { ffmpeg } = verificationBinaries();
        const origRgba = execFileSync(ffmpeg, ['-v', 'error', '-nostdin', '-i', bigPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 4 * 1024 * 1024 });
        const webpRgba = execFileSync(ffmpeg, ['-v', 'error', '-nostdin', '-i', webpTmp, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 4 * 1024 * 1024 });
        assert.equal(Buffer.compare(origRgba, webpRgba), 0, 'lossless PNG->WebP must preserve exact decoded RGBA pixels');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      }
    } else {
      assert.equal(bigBundled.data.length, bigPng.length);
    }

    // Without cwebp, an RGBA PNG must keep its original bytes (FFmpeg libwebp cannot preserve RGB beneath alpha=0),
    // while an opaque RGB PNG falls back to configured HYPERFRAMES_FFMPEG_PATH via execute().
    const prevCwebp = process.env.CWEBP_PATH;
    const prevFfmpeg = process.env.HYPERFRAMES_FFMPEG_PATH;
    process.env.CWEBP_PATH = path.join(store.directory, 'missing-cwebp-binary');
    try {
      const alphaFallbackBundle = await buildPublishBundle({
        dataDirectory: store.directory,
        kind: 'game',
        targetId: bigGame.id,
        sourcePath: bigLoc.dir,
        entryPath: 'index.html',
      });
      const alphaFallbackAsset = alphaFallbackBundle.files.find(f => f.file.startsWith('_shared-assets/'));
      assert.ok(alphaFallbackAsset && alphaFallbackAsset.file.endsWith('.png'), 'RGBA PNG must stay .png when cwebp is unavailable');
      assert.equal(alphaFallbackAsset.data.length, bigPng.length);

      if (process.platform !== 'win32') {
        const opaquePng = makeLargePng(420, 420, false);
        assert.ok(opaquePng.length >= 256 * 1024, `expected opaque fixture PNG >= 256 KiB, got ${opaquePng.length}`);
        const opaquePath = path.join(store.directory, 'opaque-sky.png');
        await writeFile(opaquePath, opaquePng);
        const opaqueAsset = await new AssetLibrary(store).importFile(opaquePath, { requestId: 'opaque-sky-1', name: 'Opaque Sky' });
        const opaqueUrl = `/motion-api/assets/${opaqueAsset.id}/versions/${opaqueAsset.currentVersionId!}/media`;
        await writeFile(path.join(bigLoc.dir, 'index.html'), `<!doctype html><html><body><img src="${opaqueUrl}"></body></html>`);

        // Test real configured FFmpeg fallback if libwebp is supported, then deterministic wrapper verification.
        const realFallbackBundle = await buildPublishBundle({
          dataDirectory: store.directory,
          kind: 'game',
          targetId: bigGame.id,
          sourcePath: bigLoc.dir,
          entryPath: 'index.html',
        });
        const realFallbackAsset = realFallbackBundle.files.find(f => f.file.startsWith('_shared-assets/'));
        assert.ok(realFallbackAsset);
        if (realFallbackAsset.file.endsWith('.webp')) {
          const { execFileSync } = await import('node:child_process');
          const { verificationBinaries } = await import('../scripts/verify-export.ts');
          const outTmp = path.join(store.directory, 'opaque-real-check.webp');
          await writeFile(outTmp, realFallbackAsset.data);
          const { ffmpeg } = verificationBinaries();
          const origRgba = execFileSync(ffmpeg, ['-v', 'error', '-nostdin', '-i', opaquePath, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 4 * 1024 * 1024 });
          const webpRgba = execFileSync(ffmpeg, ['-v', 'error', '-nostdin', '-i', outTmp, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 4 * 1024 * 1024 });
          assert.equal(Buffer.compare(origRgba, webpRgba), 0, 'opaque PNG FFmpeg fallback must preserve exact decoded RGBA pixels');
        }

        const { chmod } = await import('node:fs/promises');
        const fakeFfmpeg = path.join(store.directory, 'fake-ffmpeg.sh');
        await writeFile(fakeFfmpeg, '#!/bin/sh\nfor last; do :; done\nprintf "RIFF\\x10\\x00\\x00\\x00WEBPVP8 " > "$last"\n');
        await chmod(fakeFfmpeg, 0o755);
        process.env.HYPERFRAMES_FFMPEG_PATH = fakeFfmpeg;
        const ffmpegBundle = await buildPublishBundle({
          dataDirectory: store.directory,
          kind: 'game',
          targetId: bigGame.id,
          sourcePath: bigLoc.dir,
          entryPath: 'index.html',
        });
        const ffmpegAsset = ffmpegBundle.files.find(f => f.file.startsWith('_shared-assets/'));
        assert.ok(ffmpegAsset && ffmpegAsset.file.endsWith('.webp'), 'HYPERFRAMES_FFMPEG_PATH fallback must produce .webp for opaque PNG');
        assert.ok(ffmpegAsset.data.length < opaquePng.length * 0.95);
        const ffmpegHtml = ffmpegBundle.files.find(f => f.file === 'index.html')!.data.toString('utf8');
        assert.match(ffmpegHtml, /\.webp/);
      }
    } finally {
      if (prevCwebp === undefined) delete process.env.CWEBP_PATH; else process.env.CWEBP_PATH = prevCwebp;
      if (prevFfmpeg === undefined) delete process.env.HYPERFRAMES_FFMPEG_PATH; else process.env.HYPERFRAMES_FFMPEG_PATH = prevFfmpeg;
    }
  }));

test('WebPublishService migrates legacy cloud-shares records and preserves cloudProjectId/slug', () =>
  fixture(async store => {
    const games = gameProjectsFor(store.directory);
    const created = (await games.create({ prompt: 'Legacy CloudShare Game', multiplayer: false })).game;
    const cloudDir = path.join(store.directory, 'cloud-shares');
    await mkdir(cloudDir, { recursive: true });
    const legacyFile = path.join(
      cloudDir,
      `game-project__${Buffer.from(`game-project:${created.id}`, 'utf8').toString('base64url')}.json`,
    );
    await atomicAssetJson(legacyFile, {
      kind: 'game-project',
      projectId: created.id,
      cloudProjectId: `om-game-${created.id}`,
      workspaceId: 'ws_web_1',
      ownerMemberId: 'member_web_1',
      workspaceName: 'OpenMotion Cloud',
      slug: 'legacy-cloud-slug',
      sourceFileId: '11111111-1111-4111-8111-111111111111',
      sourceKey: 'sk-legacy-cloud',
      resourceId: 'res-legacy-cloud',
      entryPath: 'index.html',
      status: 'active',
      url: `https://open-design.app/artifact/om-game-${created.id}/legacy-cloud-slug`,
      version: 3,
      versionId: 'ver-3',
      contentFingerprint: 'legacy-fingerprint-old',
      publishedAt: 1_700_000_123_000,
      updatedAt: 1_700_000_123_000,
    });

    const { client } = createMockWebPublishAccount();
    const service = new WebPublishService(store.directory, client);
    const located = await games.locate(created.id);
    const status = await service.status({
      kind: 'game',
      id: created.id,
      entryPath: 'index.html',
      sourcePath: located.dir,
    });
    assert.equal(status.active?.slug, 'legacy-cloud-slug');
    assert.equal(status.active?.cloudProjectId, `om-game-${created.id}`);
    assert.equal(status.freshness, 'outdated');

    const listing = await service.listAll();
    assert.ok(listing.publications.some(p => p.slug === 'legacy-cloud-slug' && p.targetId === created.id));

    const updated = await service.publish({
      kind: 'game',
      id: created.id,
      title: 'Legacy CloudShare Game',
      entryPath: 'index.html',
      sourceRevision: 'rev-next',
      sourcePath: located.dir,
    });
    assert.equal(updated.publication.slug, 'legacy-cloud-slug');
    assert.equal(updated.publication.cloudProjectId, `om-game-${created.id}`);
    assert.equal(updated.url, `https://open-design.app/artifact/om-game-${created.id}/legacy-cloud-slug?kind=game`);
  }));

test('OpenDesignAccount Vela JSON error envelope parsing and signed-out workspace guard', async () => {
  const parsedJsonErr = new AccountRequestError(JSON.stringify({
    error: 'publish share: API request failed with status 409: SHARE_GENERATION_MISMATCH',
    errorCode: 'SHARE_GENERATION_MISMATCH',
    status: 409,
  }));
  assert.equal(parsedJsonErr.status, 409);
  assert.equal(parsedJsonErr.code, 'SHARE_GENERATION_MISMATCH');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'om-wp-signed-out-'));
  try {
    const store = new WorkspaceStore(dir);
    await store.initialize(pluginRoot);
    const service = new WebPublishService(dir);
    const games = gameProjectsFor(dir);
    const created = (await games.create({ prompt: 'Signed Out Guard', multiplayer: false })).game;
    const located = await games.locate(created.id);
    const status = await service.status({ kind: 'game', id: created.id, entryPath: 'index.html', sourcePath: located.dir });
    assert.equal(status.accountSignedIn, false);
    assert.equal(status.accountState, 'signed-out');
    await assert.rejects(
      () => service.publish({ kind: 'game', id: created.id, title: 'Signed Out Guard', entryPath: 'index.html', sourceRevision: '1', sourcePath: located.dir }),
      /OPENDESIGN_SIGN_IN_REQUIRED/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('WebPublish retries a new link without interrupting the old one and allows status and unpublish after local project deletion', () => fixture(async store => {
  const { webPublishOperation } = await import('../gateway/web-publish-ops.ts');
  const { designProjectsFor } = await import('../design-projects.ts');
  const { client } = createMockWebPublishAccount();
  const calls: Array<{ args: string[]; workspaceId?: string }> = [];
  const origRun = client.runWithEnv.bind(client);
  let failSharePublish = false;
  client.runWithEnv = async (args, env) => {
    calls.push({ args, workspaceId: env?.VELA_WORKSPACE_ID });
    if (failSharePublish && args[0] === 'share' && args[1] === 'publish') {
      throw new AccountRequestError('API request failed with status 503');
    }
    return origRun(args, env);
  };
  const service = new WebPublishService(store.directory, client);

  const design = designProjectsFor(store.directory);
  const created = await design.create({
    requestId: 'wp-rot-del-1',
    scenario: 'prototype',
    title: 'Rotate And Delete',
  });
  await design.write(created.id, {
    requestId: 'wp-rot-del-2',
    expectedRevision: created.revision,
    files: [{ path: 'index.html', content: '<!doctype html><html><body>v1</body></html>' }],
  });

  // 1. Publish initial link
  const first = (await webPublishOperation(
    store,
    { command: 'publish', targetKind: 'design', targetId: created.id },
    'http://127.0.0.1:4173',
    service,
  )) as any;
  assert.equal(first.publication.status, 'published');
  const firstSlug = first.publication.slug;

  const rotate = () => webPublishOperation(
    store, { command: 'publish', targetKind: 'design', targetId: created.id, deployMode: 'new_link' },
    'http://127.0.0.1:4173',
    service,
  ) as Promise<{ publication: { status: string; slug: string; cloudProjectId: string } }>;
  failSharePublish = true;
  await assert.rejects(rotate, (error: unknown) => error instanceof AccountRequestError && error.status === 503);
  const failedPublish = calls.at(-1)!.args;
  assert.deepEqual(failedPublish.slice(0, 2), ['share', 'publish']);
  assert.notEqual(failedPublish[failedPublish.indexOf('--project-id') + 1], first.publication.cloudProjectId);
  assert.ok(!calls.some(c => c.args[0] === 'share' && c.args[1] === 'stop'));
  const statusAfterFailure = await service.status({ kind: 'design', id: created.id, entryPath: 'index.html' });
  assert.equal(statusAfterFailure.active?.slug, firstSlug);
  assert.equal(statusAfterFailure.active?.status, 'published');

  failSharePublish = false;
  const rotated = await rotate();
  assert.equal(rotated.publication.status, 'published');
  assert.notEqual(rotated.publication.slug, firstSlug);
  assert.equal(rotated.publication.slug, failedPublish[failedPublish.indexOf('--slug') + 1]);
  assert.equal(rotated.publication.cloudProjectId, failedPublish[failedPublish.indexOf('--project-id') + 1]);
  assert.deepEqual(calls.slice(-2).map(c => c.args.slice(0, 2)), [['share', 'publish'], ['share', 'stop']]);
  assert.equal(calls.at(-1)?.args[2], firstSlug);

  // 3. Delete the local design project; status & unpublish must still succeed from persisted records
  await design.trash(created.id, 'wp-rot-del-trash');
  await design.remove(created.id, 'wp-rot-del-remove');

  const statusAfterDelete = (await webPublishOperation(
    store,
    { command: 'status', targetKind: 'design', targetId: created.id },
    'http://127.0.0.1:4173',
    service,
  )) as any;
  assert.equal(statusAfterDelete.active?.slug, rotated.publication.slug);
  assert.equal(statusAfterDelete.active?.status, 'published');

  const stoppedAfterDelete = (await webPublishOperation(
    store,
    { command: 'unpublish', targetKind: 'design', targetId: created.id },
    'http://127.0.0.1:4173',
    service,
  )) as any;
  assert.equal(stoppedAfterDelete.publication.status, 'stopped');
  assert.equal(stoppedAfterDelete.publication.slug, rotated.publication.slug);
  assert.ok(
    calls.some(c => c.args[0] === 'share' && c.args[1] === 'stop' && c.args[2] === rotated.publication.slug),
    'unpublish after project deletion must call share stop on the persisted slug',
  );
}));

test('WebPublish deploys embeddable community games via an OpenDesign Cloud wrapper and rejects non-https embedUrl', () => fixture(async store => {
  const { resolveWebPublishTarget, webPublishOperation } = await import('../gateway/web-publish-ops.ts');
  const { client } = createMockWebPublishAccount();
  const service = new WebPublishService(store.directory, client);

  // 1. Valid https embedUrl stages a cached wrapper outside games/ and publishes to OpenDesign Cloud
  const target = await resolveWebPublishTarget(
    store,
    {
      targetKind: 'game',
      targetId: 'community-turbo-kart',
      embedUrl: 'https://bridge-mind.github.io/turbo-kart-rally/',
      title: 'Turbo Kart Rally',
    },
    'http://127.0.0.1:4173',
  );
  assert.equal(target.kind, 'game');
  assert.equal(target.id, 'community-turbo-kart');
  assert.equal(target.entryPath, 'index.html');
  assert.ok(target.sourcePath.includes(path.join('web-publish-cache', 'games', 'community-turbo-kart')));

  const wrapperHtml = await readFile(path.join(target.sourcePath, 'index.html'), 'utf8');
  assert.ok(wrapperHtml.includes('src="https://bridge-mind.github.io/turbo-kart-rally/"'));
  assert.ok(wrapperHtml.includes('<title>Turbo Kart Rally · OpenDesign</title>'));
  assert.ok(wrapperHtml.includes('sandbox="allow-scripts allow-same-origin allow-pointer-lock"'));
  assert.equal(wrapperHtml.includes('clipboard-write'), false);

  // Must not pollute local user GameProjects catalog
  const games = new GameProjects(store.directory);
  const catalog = await games.catalog();
  assert.equal(catalog.games.some(item => item.id === 'community-turbo-kart'), false);

  const published = (await webPublishOperation(
    store,
    {
      command: 'publish',
      targetKind: 'game',
      targetId: 'community-turbo-kart',
      embedUrl: 'https://bridge-mind.github.io/turbo-kart-rally/',
      title: 'Turbo Kart Rally',
    },
    'http://127.0.0.1:4173',
    service,
  )) as any;
  assert.equal(published.publication.status, 'published');
  assert.ok(published.url?.startsWith('https://open-design.app/artifact/'));

  // 2. Subsequent status & unpublish work from the cached wrapper even without re-sending embedUrl
  const statusAfter = (await webPublishOperation(
    store,
    { command: 'status', targetKind: 'game', targetId: 'community-turbo-kart' },
    'http://127.0.0.1:4173',
    service,
  )) as any;
  assert.equal(statusAfter.active?.url, published.url);
  assert.equal(statusAfter.freshness, 'fresh');

  // 2b. Status with embedUrl and omitted title stays read-only and preserves wrapper title & freshness
  const statusWithEmbedNoTitle = (await webPublishOperation(
    store,
    {
      command: 'status',
      targetKind: 'game',
      targetId: 'community-turbo-kart',
      embedUrl: 'https://bridge-mind.github.io/turbo-kart-rally/',
    },
    'http://127.0.0.1:4173',
    service,
  )) as any;
  assert.equal(statusWithEmbedNoTitle.active?.url, published.url);
  assert.equal(statusWithEmbedNoTitle.freshness, 'fresh');
  const wrapperAfterStatus = await readFile(path.join(target.sourcePath, 'index.html'), 'utf8');
  assert.ok(wrapperAfterStatus.includes('<title>Turbo Kart Rally · OpenDesign</title>'));

  // 2c. Status with a changed embedUrl reports outdated without rewriting the cached wrapper on disk
  const statusChangedEmbed = (await webPublishOperation(
    store,
    {
      command: 'status',
      targetKind: 'game',
      targetId: 'community-turbo-kart',
      embedUrl: 'https://bridge-mind.github.io/turbo-kart-rally-v2/',
      title: 'Turbo Kart Rally',
    },
    'http://127.0.0.1:4173',
    service,
  )) as any;
  assert.equal(statusChangedEmbed.freshness, 'outdated');
  const wrapperAfterChangedEmbed = await readFile(path.join(target.sourcePath, 'index.html'), 'utf8');
  assert.equal(wrapperAfterChangedEmbed, wrapperAfterStatus);
  assert.ok(wrapperAfterChangedEmbed.includes('https://bridge-mind.github.io/turbo-kart-rally/'));
  assert.ok(!wrapperAfterChangedEmbed.includes('turbo-kart-rally-v2'));

  // 3. Non-https and credential-bearing embedUrl values are rejected
  await assert.rejects(
    () =>
      resolveWebPublishTarget(
        store,
        {
          targetKind: 'game',
          targetId: 'community-bad-proto',
          embedUrl: 'javascript:alert(1)',
          title: 'Bad Game',
        },
        'http://127.0.0.1:4173',
      ),
    /GAME_NOT_FOUND|not found/i,
  );
  await assert.rejects(
    () =>
      resolveWebPublishTarget(
        store,
        {
          targetKind: 'game',
          targetId: 'community-http-local',
          embedUrl: 'http://127.0.0.1:8080/game',
          title: 'Insecure Local Game',
        },
        'http://127.0.0.1:4173',
      ),
    /GAME_NOT_FOUND|not found/i,
  );
  await assert.rejects(
    () =>
      resolveWebPublishTarget(
        store,
        {
          targetKind: 'game',
          targetId: 'community-creds-url',
          embedUrl: 'https://user:pass@example.com/private-game/',
          title: 'Private Preview Game',
        },
        'http://127.0.0.1:4173',
      ),
    /GAME_NOT_FOUND|not found/i,
  );
}));
test('shareViewerUrlForTarget marks only game shares and is idempotent', () => {
  const base = 'https://open-design.app/artifact/p1/slug-1';
  assert.equal(shareViewerUrlForTarget('game', base), `${base}?kind=game`);
  assert.equal(shareViewerUrlForTarget('game', `${base}?kind=game`), `${base}?kind=game`);
  assert.equal(shareViewerUrlForTarget('design', base), base);
  assert.equal(shareViewerUrlForTarget('html', base), base);
  assert.equal(shareViewerUrlForTarget('motion', base), base);
  assert.equal(shareViewerUrlForTarget('game', null), null);
});
