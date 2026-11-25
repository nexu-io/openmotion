import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { designProjectsFor } from '../design-projects.ts';
import { collectUnifiedLibraryIndex } from '../gateway/library-index.ts';
import { scenarioRunsFor } from '../gateway/scenario-runs.ts';
import { superAgentConversations } from '../gateway/super-agent.ts';
import { fixture } from './fixtures.ts';
import { transport } from './http.ts';

test('collectUnifiedLibraryIndex aggregates cross-module creations, enriches provenance, filters, sorts, and exposes /api/library/index', () =>
  fixture(async store => {
    const dir = store.directory;
    const baseMs = 1_795_000_000_000;

    // 1. Seed Media Assets (uploaded audio, MCP-generated image, trashed image excluded)
    const assetRecordsDir = path.join(dir, 'asset-library', 'records');
    const jobsDir = path.join(dir, 'jobs');
    const gatewayJobsDir = path.join(dir, 'model-gateway', 'jobs');
    await mkdir(assetRecordsDir, { recursive: true });
    await mkdir(jobsDir, { recursive: true });
    await mkdir(gatewayJobsDir, { recursive: true });

    const audioId = '11111111-1111-4111-8111-111111111111';
    const imageId = '22222222-2222-4222-8222-222222222222';
    const wfAssetId = '33333333-3333-4333-8333-333333333333';
    const trashedAssetId = '44444444-4444-4444-8444-444444444444';
    const mcpJobId = '55555555-5555-4555-8555-555555555555';

    await writeFile(
      path.join(gatewayJobsDir, `${mcpJobId}.json`),
      JSON.stringify({
        id: mcpJobId,
        state: 'completed',
        modality: 'image',
        prompt: 'Cyberpunk storefront render',
        model: { provider: 'account', modelId: 'seedream-4.0', name: 'Seedream 4.0', modality: 'image' },
        parameters: {},
        requestHash: 'hash_mcp',
        assets: [],
        library: { assetId: imageId, title: 'Cyberpunk Storefront' },
        createdAt: baseMs - 60_000,
        updatedAt: baseMs - 50_000,
      }),
    );

    await writeFile(
      path.join(assetRecordsDir, `${audioId}.json`),
      JSON.stringify({
        id: audioId,
        name: 'Warm Coffee Ambience',
        modality: 'audio',
        createdAt: baseMs - 300_000,
        updatedAt: baseMs - 300_000,
        currentVersionId: 'ver-aud-1',
        versions: [
          {
            id: 'ver-aud-1',
            createdAt: baseMs - 300_000,
            source: 'upload',
            filename: 'ambience.mp3',
            mimeType: 'audio/mpeg',
            bytes: 4096,
            sha256: 'sha_aud',
            references: [],
          },
        ],
      }),
    );

    await writeFile(
      path.join(assetRecordsDir, `${imageId}.json`),
      JSON.stringify({
        id: imageId,
        name: 'Cyberpunk Storefront',
        modality: 'image',
        createdAt: baseMs - 50_000,
        updatedAt: baseMs - 50_000,
        currentVersionId: 'ver-img-1',
        versions: [
          {
            id: 'ver-img-1',
            createdAt: baseMs - 50_000,
            source: 'generated',
            filename: 'storefront.png',
            mimeType: 'image/png',
            bytes: 8192,
            sha256: 'sha_img',
            prompt: 'Neon coffee shop facade',
            model: 'seedream-4.0',
            jobId: mcpJobId,
            references: [],
          },
        ],
      }),
    );

    await writeFile(
      path.join(assetRecordsDir, `${wfAssetId}.json`),
      JSON.stringify({
        id: wfAssetId,
        name: 'Product Hero Keyframe',
        modality: 'image',
        createdAt: baseMs - 40_000,
        updatedAt: baseMs - 40_000,
        currentVersionId: 'ver-wf-1',
        versions: [
          {
            id: 'ver-wf-1',
            createdAt: baseMs - 40_000,
            source: 'generated',
            filename: 'keyframe.png',
            mimeType: 'image/png',
            bytes: 2048,
            sha256: 'sha_wf',
            conversationId: 'conv_studio_1',
            references: [],
          },
        ],
      }),
    );

    await writeFile(
      path.join(assetRecordsDir, `${trashedAssetId}.json`),
      JSON.stringify({
        id: trashedAssetId,
        name: 'Deleted Asset Should Hide',
        modality: 'image',
        createdAt: baseMs,
        updatedAt: baseMs,
        trashedAt: baseMs,
        currentVersionId: 'ver-del-1',
        versions: [
          {
            id: 'ver-del-1',
            createdAt: baseMs,
            source: 'upload',
            filename: 'deleted.png',
            mimeType: 'image/png',
            bytes: 512,
            sha256: 'sha_del',
            references: [],
          },
        ],
      }),
    );

    // 2. Design Projects (Websites, Slides, Docs)
    const design = designProjectsFor(dir);
    await design.create({ requestId: 'req_web', scenario: 'prototype', title: 'Landing Microsite' });
    await design.create({ requestId: 'req_deck', scenario: 'deck', title: 'Q4 Keynote Deck' });
    await design.create({ requestId: 'req_doc', scenario: 'document', title: 'Technical Launch Brief' });

    // 3. Completed Motion MP4 Export
    const exportJobId = '66666666-6666-4666-8666-666666666666';
    const exportJob = {
      id: exportJobId,
      projectId: 'project',
      revision: 'rev1',
      state: 'completed',
      outputName: 'luma_coffee.mp4',
      createdAt: baseMs - 20_000,
      acceptedAt: baseMs - 18_000,
      terminalAt: baseMs - 5_000,
      expiresAt: baseMs + 60_000,
    };
    await mkdir(path.join(jobsDir, exportJobId), { recursive: true });
    await writeFile(path.join(jobsDir, exportJobId, 'job.json'), JSON.stringify(exportJob));
    const mp4Path = store.exportPath(exportJob as any);
    await mkdir(path.dirname(mp4Path), { recursive: true });
    await writeFile(mp4Path, Buffer.from('mock-mp4-binary-payload'));

    // 4. Playable Game created by user (templates must NOT appear in Library)
    const gameDir = path.join(dir, 'games', 'coffee-dash');
    await mkdir(gameDir, { recursive: true });
    await writeFile(
      path.join(gameDir, 'game.json'),
      JSON.stringify({
        id: 'coffee-dash',
        title: 'Coffee Dash Mini Game',
        description: 'Collect espresso beans in time.',
        genre: 'casual',
        style: 'pixel',
        setting: 'modern',
        multiplayer: false,
        maxPlayers: 1,
        status: 'ready',
        cover: 'cover.png',
        controls: 'Arrows',
        createdAt: new Date(baseMs - 150_000).toISOString(),
        updatedAt: new Date(baseMs - 10_000).toISOString(),
      }),
    );

    // 5. Brand Kit
    const kitId = '77777777-7777-4777-8777-777777777777';
    await mkdir(path.join(dir, 'brand-kits', kitId), { recursive: true });
    await writeFile(
      path.join(dir, 'brand-kits', kitId, 'record.json'),
      JSON.stringify({
        id: kitId,
        kind: 'brand-kit',
        name: 'LUMA Roasters Brand Kit',
        url: 'https://luma.example.com',
        websiteUrl: 'https://luma.example.com',
        createdAt: new Date(baseMs - 120_000).toISOString(),
        updatedAt: new Date(baseMs - 15_000).toISOString(),
        state: 'ready',
        progress: 100,
      }),
    );

    // 6. Workflow Run linking wfAssetId
    const runs = scenarioRunsFor(store);
    const createdRun = await runs.create({
      requestId: 'req_run_1',
      scenarioId: 'motion-full-chain',
      title: 'LUMA Coffee Launch Campaign',
    });
    createdRun.run.pool.push({
      id: 'pool_item_1',
      kind: 'image',
      ref: { type: 'asset', assetId: wfAssetId, versionId: 'ver-wf-1' },
      label: 'Product Hero Keyframe',
      source: 'generated',
      stepId: null,
      tags: [],
      pinned: false,
      addedAt: baseMs - 30_000,
    });
    await writeFile(
      path.join(dir, 'scenarios', 'runs', `${createdRun.run.id}.json`),
      JSON.stringify(createdRun.run),
    );

    // 7. Super Agent chat linking Motion export + exclusive Web Page artifact (+ stripped javascript: URL)
    const sa = superAgentConversations(store);
    const chat = await sa.create({ title: 'Create LUMA Coffee Showcase' });
    await sa.update(chat.id, {
      addArtifact: {
        id: 'art_mp4',
        kind: 'motion-export',
        title: 'luma_coffee.mp4',
        projectId: 'project',
        jobId: exportJobId,
        updatedAt: baseMs - 4_000,
      },
    });
    await sa.update(chat.id, {
      addArtifact: {
        id: 'art_web',
        kind: 'web',
        title: 'LUMA Microsite Demo',
        url: 'https://open-design.ai/showcase/luma',
        updatedAt: baseMs - 2_000,
      },
    });
    await sa.update(chat.id, {
      addArtifact: {
        id: 'art_unsafe_web',
        kind: 'web',
        title: 'Insecure HTTP Artifact',
        url: 'http://insecure.example/script',
        updatedAt: baseMs - 1_000,
      },
    });

    // Verify full aggregation & provenance
    const allRes = await collectUnifiedLibraryIndex(store);
    assert.equal(allRes.counts.motion, 1);
    assert.equal(allRes.counts.slides, 1);
    assert.equal(allRes.counts.docs, 1);
    assert.equal(allRes.counts.websites, 3); // Landing Microsite + 2 SA web artifacts
    assert.equal(allRes.counts.games, 1); // Only user game, never built-in templates
    assert.equal(allRes.counts.images, 2); // Excluded trashed asset
    assert.equal(allRes.counts.videos, 1); // Completed export
    assert.equal(allRes.counts.audio, 1);
    assert.equal(allRes.counts['brand-kits'], 1);
    assert.equal(allRes.counts.workflows, 1);
    assert.equal(allRes.total, 13);

    const mp4Item = allRes.items.find(item => item.id === `motion-export:${exportJobId}`);
    assert.ok(mp4Item);
    assert.equal(mp4Item.origin, 'super-agent');
    assert.equal(mp4Item.sourceChatId, chat.id);
    assert.equal(mp4Item.sourceChatTitle, 'Create LUMA Coffee Showcase');
    assert.equal(mp4Item.category, 'videos');

    const mcpImg = allRes.items.find(item => item.id === `asset:${imageId}`);
    assert.equal(mcpImg?.origin, 'mcp');

    const wfImg = allRes.items.find(item => item.id === `asset:${wfAssetId}`);
    assert.equal(wfImg?.origin, 'workflow');
    assert.equal(wfImg?.sourceRunId, createdRun.run.id);

    const uploadAudio = allRes.items.find(item => item.id === `asset:${audioId}`);
    assert.equal(uploadAudio?.origin, 'upload');

    const unsafeWeb = allRes.items.find(item => item.id.endsWith(':art_unsafe_web'));
    assert.ok(unsafeWeb);
    assert.equal(unsafeWeb.externalUrl, undefined);

    const gameItem = allRes.items.find(item => item.id === 'game:coffee-dash');
    assert.equal(gameItem?.previewUrl, '/motion-api/games/coffee-dash/play/cover.png');

    // Verify sorting & filtering
    for (let i = 1; i < allRes.items.length; i += 1) {
      assert.ok(allRes.items[i - 1]!.updatedAt >= allRes.items[i]!.updatedAt);
    }

    const byName = await collectUnifiedLibraryIndex(store, { sort: 'name' });
    assert.equal(byName.items[0]!.title, 'Coffee Dash Mini Game');

    const slidesOnly = await collectUnifiedLibraryIndex(store, { category: 'slides' });
    assert.equal(slidesOnly.total, 1);
    assert.equal(slidesOnly.items[0]!.title, 'Q4 Keynote Deck');
    assert.equal(slidesOnly.counts.all, 13);

    const searchLuma = await collectUnifiedLibraryIndex(store, { query: 'luma' });
    assert.ok(searchLuma.total >= 3);
    assert.ok(searchLuma.items.every(item =>
      `${item.title} ${item.subtitle ?? ''} ${item.originLabel}`.toLowerCase().includes('luma'),
    ));

    const saOnly = await collectUnifiedLibraryIndex(store, { origin: 'super-agent' });
    assert.equal(saOnly.counts.videos, 1);
    assert.equal(saOnly.counts.websites, 2);
    assert.equal(saOnly.counts.audio, 0);

    // HTTP route verification
    const req = transport(store);
    const httpOk = await req('/motion-api/library/index?category=slides');
    assert.equal(httpOk.status, 200);
    const httpJson = await httpOk.json();
    assert.equal(httpJson.total, 1);
    assert.equal(httpJson.items[0].title, 'Q4 Keynote Deck');

    assert.equal((await req('/motion-api/library/index?category=bogus')).status, 400);
    assert.equal((await req('/motion-api/library/index?origin=bogus')).status, 400);
    assert.equal((await req('/motion-api/library/index?sort=bogus')).status, 400);
    assert.equal((await req('/motion-api/library/index?limit=999')).status, 400);
  }));
