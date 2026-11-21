import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fixture } from './fixtures.ts';
import { execute, pluginRoot } from '../hyperframes.ts';
import { verificationBinaries } from '../scripts/verify-export.ts';
import { Phase1Service } from '../phase1.ts';
import { gatewayFor } from '../gateway/service.ts';
import {
  registerCapabilityQuoteEstimator,
  registerCapabilityScriptExecutor,
  saveCapabilityOverrides,
  setCapabilityRemoteConfigFetcher,
  syncCapabilityRemoteConfig,
  unregisterCapabilityScriptExecutor,
} from '../gateway/capability-center.ts';
import { defaultCapabilities } from '../shared/capability-registry.ts';
import { imageFeatures, imageFeaturePrompt } from '../shared/image-features.ts';
import { videoFeatures, videoFeaturePrompt } from '../shared/video-features.ts';

const service = (store: any) =>
  new Phase1Service(store, pluginRoot, {
    origin: () => 'http://localhost:4173',
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async task => task(),
    cancel: async () => {},
  });

async function makePng(directory: string, filename: string, color: string) {
  const file = path.join(directory, filename);
  const result = await execute(
    verificationBinaries().ffmpeg,
    ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=32x24`, '-frames:v', '1', '-y', file],
    directory,
    20_000,
  );
  assert.equal(result.code, 0, result.stderr);
  return file;
}

test('Unified Capability Registry drives shared image/video features and separates live vs coming-soon capabilities', () => {
  assert.deepEqual(imageFeatures['remove-background'].parameters, { background: 'transparent' });
  assert.equal(imageFeatures.relight.recommended, 'seedream-5.5');
  assert.equal(videoFeatures['multi-shot'].defaultDuration, 10);
  assert.equal(videoFeatures['native-audio'].forceAudio, true);
  assert.match(imageFeaturePrompt('relight', 'Sharp rim.', { direction: 'back', temperature: 'warm', mood: 'neon' }), /backlight.*3200K.*neon/i);
  assert.match(videoFeaturePrompt('camera-control', 'Mountain peak', { movement: 'orbit', pace: 'slow' }), /360-degree camera orbit.*Mountain peak/);

  const liveIds = defaultCapabilities.filter(c => c.status === 'live').map(c => c.id);
  for (const id of ['text-to-image', 'remove-background', 'relight', 'character', 'camera-control', 'multi-shot', 'native-audio', 'music', 'speech', 'asr-transcribe']) {
    assert.ok(liveIds.includes(id), `expected live capability ${id}`);
  }
  const soonIds = defaultCapabilities.filter(c => c.status === 'coming_soon').map(c => c.id);
  for (const id of ['inpainting', 'upscale-4k', 'lipsync', 'voice-changer', 'dubbing', 'digital-human', '3d-asset']) {
    assert.ok(soonIds.includes(id), `expected coming_soon capability ${id}`);
  }
});

test('4 MCP meta-tools discover schemas, execute capabilities, manage jobs and persist capability provenance on AssetVersion', () =>
  fixture(async store => {
    const api = service(store);
    const gateway = gatewayFor(store);
    gateway.options.detect = async () => [
      { id: 'codex', label: 'Codex', installed: true, authenticated: true, imageGeneration: true, available: true, reason: 'fixture' },
    ];
    gateway.options.codex = async () => readFile(await makePng(store.directory, 'generated.png', 'teal'));

    // 1. Discover live MCP capabilities (coming_soon excluded by default)
    const listed = await api.call('openmotion_capability_discover', { action: 'list' });
    assert.ok(listed.capabilities.some((c: any) => c.id === 'text-to-image' && c.available === true));
    assert.ok(listed.capabilities.some((c: any) => c.id === 'remove-background'));
    assert.ok(!listed.capabilities.some((c: any) => c.status === 'coming_soon'));

    const withSoon = await api.call('openmotion_capability_discover', { action: 'list', includeComingSoon: true });
    assert.ok(withSoon.capabilities.some((c: any) => c.id === 'lipsync' && c.status === 'coming_soon'));

    // 2. Describe capability options schema
    const relightMeta = await api.call('openmotion_capability_discover', { action: 'describe', capabilityId: 'relight' });
    assert.equal(relightMeta.capability.id, 'relight');
    assert.equal(relightMeta.capability.input.minReferences, 1);
    assert.deepEqual(relightMeta.capability.input.optionsSchema.properties.direction.enum, ['left', 'right', 'front', 'top', 'back']);

    // 3. Reject coming_soon capability execution cleanly
    await assert.rejects(
      api.call('openmotion_capability_run', { action: 'run', requestId: 'soon-1', capabilityId: 'lipsync' }),
      /CAPABILITY_COMING_SOON/,
    );

    // 4. Execute text-to-image through capability_run, poll via job_manage, inspect provenance via asset_manage
    const submitted = await api.call('openmotion_capability_run', {
      action: 'run',
      requestId: 'cap-t2i-1',
      capabilityId: 'text-to-image',
      prompt: 'Minimal ceramic mug',
      name: 'Ceramic Mug',
    });
    assert.equal(submitted.capabilityId, 'text-to-image');
    assert.equal(submitted.selectedModel, 'codex:image-generation');
    assert.equal(submitted.next.tool, 'openmotion_job_manage');

    // Idempotent replay with same requestId returns the exact same job without re-running
    const replayed = await api.call('openmotion_capability_run', {
      action: 'run',
      requestId: 'cap-t2i-1',
      capabilityId: 'text-to-image',
      prompt: 'Minimal ceramic mug',
      name: 'Ceramic Mug',
    });
    assert.equal(replayed.job.id, submitted.job.id);

    await gateway.tick();
    await Promise.all([...gateway.active.values()].map(task => task.done));

    const jobState = await api.call('openmotion_job_manage', { action: 'status', jobId: submitted.job.id });
    assert.equal(jobState.job.state, 'completed');
    assert.equal(jobState.job.capabilityId, 'text-to-image');
    const createdRef = jobState.job.libraryAssets[0];
    assert.ok(createdRef?.assetId && createdRef?.versionId);

    const inspected = await api.call('openmotion_asset_manage', {
      action: 'get',
      assetId: createdRef.assetId,
      versionId: createdRef.versionId,
    });
    assert.equal(inspected.version.capabilityId, 'text-to-image');
    assert.equal(inspected.asset.name, 'Ceramic Mug');

    const preview = await api.call('openmotion_asset_manage', {
      action: 'read',
      assetId: createdRef.assetId,
      versionId: createdRef.versionId,
    });
    assert.equal(preview.versionId, createdRef.versionId);
    assert.ok(preview.content.some((block: any) => block.type === 'image'));
  }, false));

test('Unified Capability Center supports runtime hot-swapping to a local script executor and two-step soft deprecation', () =>
  fixture(async store => {
    const api = service(store);
    const scriptId = 'test-fast-matting-v1';

    // Import an initial source image asset
    const sourcePng = await makePng(store.directory, 'product-raw.png', 'orange');
    const imported = await api.call('openmotion_asset_manage', {
      action: 'import',
      requestId: 'import-raw-1',
      sourcePath: sourcePng,
      name: 'Raw Product',
    });
    const ref = { assetId: imported.asset.id, versionId: imported.asset.currentVersionId };

    registerCapabilityScriptExecutor(scriptId, async ctx => {
      assert.equal(ctx.references.length, 1);
      assert.equal(ctx.references[0].assetId, ref.assetId);
      const cutout = await makePng(store.directory, 'cutout.png', 'white');
      return { sourcePath: cutout, name: 'Cutout Product' };
    });

    try {
      // Hot-swap `remove-background` to the script executor AND soft-deprecate `relight` -> `image-edit`
      await saveCapabilityOverrides(store, [
        {
          id: 'remove-background',
          executor: { kind: 'script', scriptId },
        },
        {
          id: 'relight',
          status: 'deprecated',
          replacementCapabilityId: 'image-edit',
        },
      ]);

      // 1. Deprecated `relight` immediately disappears from active discovery list
      const discovered = await api.call('openmotion_capability_discover', { action: 'list' });
      assert.ok(!discovered.capabilities.some((c: any) => c.id === 'relight'));
      const rmBg = discovered.capabilities.find((c: any) => c.id === 'remove-background');
      assert.ok(rmBg);
      assert.equal(rmBg.executorKind, 'script');
      assert.equal(rmBg.available, true);

      // 2. Calling deprecated `relight` returns actionable replacement guidance
      await assert.rejects(
        api.call('openmotion_capability_run', {
          action: 'run',
          requestId: 'dep-relight-1',
          capabilityId: 'relight',
          references: [ref],
        }),
        /CAPABILITY_DEPRECATED: relight is no longer active; use image-edit instead/,
      );

      // 3. Calling hot-swapped `remove-background` runs the script and creates a linked v2 on the same asset
      const executed = await api.call('openmotion_capability_run', {
        action: 'run',
        requestId: 'script-rmbg-1',
        capabilityId: 'remove-background',
        assetId: imported.asset.id,
        parentVersionId: imported.asset.currentVersionId,
        references: [ref],
      });
      assert.equal(executed.executorKind, 'script');
      assert.equal(executed.version.capabilityId, 'remove-background');
      assert.equal(executed.version.parentVersionId, ref.versionId);
      assert.deepEqual(executed.version.references, [ref]);
      assert.equal(executed.asset.versions.length, 2);

      // 4. Standalone script execution deduplicates by requestId and rejects input conflicts
      const standalone = await api.call('openmotion_capability_run', {
        action: 'run',
        requestId: 'script-standalone-1',
        capabilityId: 'remove-background',
        references: [ref],
      });
      const standaloneReplay = await api.call('openmotion_capability_run', {
        action: 'run',
        requestId: 'script-standalone-1',
        capabilityId: 'remove-background',
        references: [ref],
      });
      assert.equal(standaloneReplay.asset.id, standalone.asset.id);
      assert.equal(standaloneReplay.version.id, standalone.version.id);
      await assert.rejects(
        api.call('openmotion_capability_run', {
          action: 'run',
          requestId: 'script-standalone-1',
          capabilityId: 'remove-background',
          prompt: 'Different note',
          references: [ref],
        }),
        /REQUEST_ID_CONFLICT/,
      );
    } finally {
      unregisterCapabilityScriptExecutor(scriptId);
    }
  }, false));

test('extension hooks cover dedicated-model structured parameter mapping, remote hot-config sync, spend quotes, and on-demand Library Skills', () =>
  fixture(async store => {
    const api = service(store);
    const gateway = gatewayFor(store);
    gateway.options.detect = async () => [
      { id: 'codex', label: 'Codex', installed: true, authenticated: true, imageGeneration: true, available: true, reason: 'fixture' },
    ];

    try {
      // 1. Remote hot-config lights up `upscale-4k` as a `dedicated-model` with optionToParameter mapping
      setCapabilityRemoteConfigFetcher(async () => [
        {
          id: 'upscale-4k',
          status: 'live',
          channels: { gui: true, mcp: true },
          costTier: 'high',
          requiresExplicitApproval: true,
          executor: {
            kind: 'dedicated-model',
            providers: ['codex'],
            models: ['image-generation'],
            recommendedModel: 'image-generation',
            mode: 'text-to-image',
            defaultParameters: { format: 'png' },
            optionToParameter: { scale: 'upscale_factor' },
          },
        },
      ]);
      await syncCapabilityRemoteConfig(store);

      // 2. Custom cloud quote estimator plugs into both `action=quote` and `dryRun=true`
      registerCapabilityQuoteEstimator(async ({ capability, options, model }) => ({
        capabilityId: capability.id,
        costTier: capability.costTier,
        requiresExplicitApproval: capability.requiresExplicitApproval,
        estimatedCredits: options.scale === '4x' ? 12 : 6,
        currency: 'credits',
        quoteSource: 'cloud-quote',
        selectedModel: model?.id ?? null,
      }));

      const quoted = await api.call('openmotion_capability_discover', {
        action: 'quote',
        capabilityId: 'upscale-4k',
        options: { scale: '4x' },
      });
      assert.equal(quoted.quote.quoteSource, 'cloud-quote');
      assert.equal(quoted.quote.estimatedCredits, 12);
      assert.equal(quoted.quote.requiresExplicitApproval, true);

      const sourcePng = await makePng(store.directory, 'lowres.png', 'navy');
      const imported = await api.call('openmotion_asset_manage', {
        action: 'import',
        requestId: 'import-lowres-1',
        sourcePath: sourcePng,
        name: 'Lowres Shot',
      });
      const ref = { assetId: imported.asset.id, versionId: imported.asset.currentVersionId };

      const dryRun = await api.call('openmotion_capability_run', {
        action: 'run',
        requestId: 'dry-upscale-1',
        capabilityId: 'upscale-4k',
        options: { scale: '4x' },
        references: [ref],
        dryRun: true,
      });
      assert.equal(dryRun.dryRun, true);
      assert.equal(dryRun.executorKind, 'dedicated-model');
      assert.deepEqual(dryRun.effectiveParameters, { format: 'png', upscale_factor: '4x' });
      assert.equal(dryRun.quote.estimatedCredits, 12);
    } finally {
      setCapabilityRemoteConfigFetcher(undefined);
      registerCapabilityQuoteEstimator(undefined);
    }

    // 3. Progressive-disclosure Library Skills for digital-human & video-dubbing are indexed and readable
    const skillIndex = await api.call('openmotion_list_skills', {});
    const rows = (await readFile(skillIndex.indexPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    for (const id of ['openmotion-digital-human-presenter', 'openmotion-video-dubbing']) {
      assert.ok(rows.some(row => row.skillId === id), `missing library skill ${id}`);
      const detail = await api.call('openmotion_get_skill', { skillId: id });
      assert.match(detail.instructions, /openmotion_capability_discover/);
    }
  }, false));
