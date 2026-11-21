import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import sharp from 'sharp';
import { mediaType } from '../../gateway/network.ts';
import {
  InMemoryAuthStore,
  SESSION_COOKIE_NAME,
  createAuthMiddleware,
  createBrowserSession,
  createPat,
  type AuthEnv,
} from '../../src/auth/index.ts';
import { isCloudError } from '../../src/contracts/errors.ts';
import { parseConfig, type AppConfig } from '../../src/infra/config.ts';
import { createAccountRoutes } from '../../src/routes/account.ts';
import { createModelRoutes } from '../../src/routes/models.ts';
import {
  MockModelGateway,
  generateDeterministicMp4,
  generateDeterministicPng,
  generateDeterministicWav,
} from '../../src/services/mock-model-adapter.ts';
import {
  GatewayError,
  createPlatformModelGateway,
} from '../../src/services/model-gateway.ts';
import { OpenDesignModelGateway } from '../../src/services/opendesign-adapter.ts';

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function makeGatewayConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    WORKER_ROLE: 'api',
    APP_PUBLIC_ORIGIN: 'https://motion.example.test',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://idp.example.test',
    OIDC_CLIENT_ID: 'openmotion-cloud',
    SESSION_SECRET: '0'.repeat(32),
    MODEL_GATEWAY_MODE: 'mock',
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/openmotion',
    REDIS_URL: 'redis://127.0.0.1:6379',
    ...overrides,
  });
}

describe('MockModelGateway Deterministic Valid PNG/MP4/WAV Generation', () => {
  it('generates valid PNG (Sharp-decodable), WAV (RIFF/PCM), and MP4 (ISO BMFF) buffers deterministically', async () => {
    const gateway = new MockModelGateway({ pollCountBeforeSuccess: 1 });
    const ctx = { workspaceId: randomUUID(), idempotencyKey: 'idem-mock-1' };

    const models = await gateway.listMediaModels(ctx);
    assert.equal(models.length, 4);
    assert.ok(models.every((m) => m.provider === 'opendesign'));

    // Upload reference image
    const refPng = generateDeterministicPng('ref-seed');
    const uploaded = await gateway.uploadReference(ctx, {
      bytes: refPng,
      mimeType: 'image/png',
      idempotencyKey: 'ref-1',
    });
    assert.ok(uploaded.remoteAssetId.startsWith('mock_ref_'));

    // Image generation -> 1 running poll -> succeeded -> Sharp verifies 64x64 RGBA PNG
    const imgSubmit = await gateway.submitTask(ctx, {
      jobId: 'job-img-1',
      modality: 'image',
      mode: 'text-to-image',
      modelId: 'mock-image-1',
      prompt: 'neon city skyline',
      parameters: {},
      inputs: [{ remoteAssetId: uploaded.remoteAssetId }],
    });
    // Idempotent repeat returns same remoteTaskId
    const imgSubmitRepeat = await gateway.submitTask(ctx, {
      jobId: 'job-img-1',
      modality: 'image',
      mode: 'text-to-image',
      modelId: 'mock-image-1',
      prompt: 'neon city skyline',
      parameters: {},
      inputs: [{ remoteAssetId: uploaded.remoteAssetId }],
    });
    assert.equal(imgSubmitRepeat.remoteTaskId, imgSubmit.remoteTaskId);

    const poll1 = await gateway.pollTask(ctx, { modality: 'image', remoteTaskId: imgSubmit.remoteTaskId });
    assert.equal(poll1.status, 'running');
    const poll2 = await gateway.pollTask(ctx, { modality: 'image', remoteTaskId: imgSubmit.remoteTaskId });
    assert.equal(poll2.status, 'succeeded');
    const imgBytes = await streamToBuffer(await gateway.downloadOutput(ctx, poll2.outputs![0]));
    assert.deepEqual(mediaType(imgBytes, 'image'), { mimeType: 'image/png', extension: 'png' });
    const meta = await sharp(imgBytes).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.width, 64);
    assert.equal(meta.height, 64);

    // Video generation -> valid MP4 container
    const vidGateway = new MockModelGateway();
    const vidSubmit = await vidGateway.submitTask(
      { workspaceId: ctx.workspaceId, idempotencyKey: 'idem-vid' },
      {
        jobId: 'job-vid-1',
        modality: 'video',
        mode: 'text-to-video',
        modelId: 'mock-video-1',
        prompt: 'camera dolly shot',
        parameters: {},
        inputs: [],
      },
    );
    const vidPoll = await vidGateway.pollTask(ctx, { modality: 'video', remoteTaskId: vidSubmit.remoteTaskId });
    assert.equal(vidPoll.status, 'succeeded');
    const mp4Bytes = await streamToBuffer(await vidGateway.downloadOutput(ctx, vidPoll.outputs![0]));
    assert.deepEqual(mediaType(mp4Bytes, 'video'), { mimeType: 'video/mp4', extension: 'mp4' });
    assert.equal(mp4Bytes.subarray(4, 8).toString('ascii'), 'ftyp');
    assert.ok(mp4Bytes.includes(Buffer.from('moov', 'ascii')));
    assert.ok(mp4Bytes.includes(Buffer.from('mdat', 'ascii')));

    // Speech generation -> valid WAV + sentence timing metadata
    const audioSubmit = await vidGateway.submitTask(
      { workspaceId: ctx.workspaceId, idempotencyKey: 'idem-aud' },
      {
        jobId: 'job-aud-1',
        modality: 'audio',
        mode: 'text-to-speech',
        modelId: 'mock-speech-1',
        prompt: 'Welcome to OpenMotion',
        parameters: { voice: 'default' },
        inputs: [],
      },
    );
    const audioPoll = await vidGateway.pollTask(ctx, { modality: 'audio', remoteTaskId: audioSubmit.remoteTaskId });
    assert.equal(audioPoll.status, 'succeeded');
    assert.ok(Array.isArray(audioPoll.metadata?.sentences));
    const wavBytes = await streamToBuffer(await vidGateway.downloadOutput(ctx, audioPoll.outputs![0]));
    assert.deepEqual(mediaType(wavBytes, 'audio'), { mimeType: 'audio/wav', extension: 'wav' });
    assert.equal(wavBytes.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wavBytes.subarray(8, 12).toString('ascii'), 'WAVE');

    // Error hooks: insufficient_balance on submit & audio_outcome_unknown on poll
    await assert.rejects(
      () =>
        vidGateway.submitTask(ctx, {
          jobId: 'job-fail-1',
          modality: 'image',
          mode: 'text-to-image',
          modelId: 'mock-image-1',
          prompt: '[mock:fail=insufficient_balance] test',
          parameters: {},
          inputs: [],
        }),
      (err: unknown) => err instanceof GatewayError && err.code === 'insufficient_balance',
    );

    const unknownSub = await vidGateway.submitTask(
      { workspaceId: ctx.workspaceId, idempotencyKey: 'idem-unk' },
      {
        jobId: 'job-unk-1',
        modality: 'audio',
        mode: 'text-to-audio',
        modelId: 'mock-music-1',
        prompt: '[mock:fail=audio_outcome_unknown] track',
        parameters: {},
        inputs: [],
      },
    );
    const unknownPoll = await vidGateway.pollTask(ctx, { modality: 'audio', remoteTaskId: unknownSub.remoteTaskId });
    assert.equal(unknownPoll.status, 'failed');
    assert.equal(unknownPoll.error?.code, 'audio_outcome_unknown');
    assert.equal(unknownPoll.error?.outcomeUnknown, true);
  });
});

describe('OpenDesignModelGateway Direct S2S HTTP Contract (Zero vela-cli / Zero BYOK)', () => {
  it('sends S2S Bearer, x-vela-workspace-id, Idempotency-Key and strips Authorization on presigned PUT and video redirect', async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
    const sampleMp4 = generateDeterministicMp4('s2s-video');

    const mockFetcher: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      const method = (init.method ?? 'GET').toUpperCase();
      const hdrs = Object.fromEntries(new Headers(init.headers).entries());
      calls.push({
        url,
        method,
        headers: hdrs,
        body: typeof init.body === 'string' ? init.body : undefined,
      });

      if (url === 'https://amr-api.open-design.ai/api/v1/media/models') {
        return new Response(
          JSON.stringify({
            models: [
              {
                model: 'wan-2.7',
                kind: 'video',
                enabled: true,
                capabilities: { max_input_images: 1, ratios: ['16:9', '9:16'], durations: [5] },
              },
              {
                model: 'flux-pro',
                kind: 'image',
                enabled: true,
                capabilities: {
                  edits: true,
                  max_input_images: 4,
                  profiles: {
                    generations: {
                      profiles: [{ aspect_ratio: '16:9', resolution: '1K' }],
                      default: { aspect_ratio: '16:9', resolution: '1K' },
                    },
                  },
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url === 'https://amr-api.open-design.ai/api/v1/media/uploads' && method === 'POST') {
        return new Response(
          JSON.stringify({
            asset_id: 'od_asset_123',
            upload_url: 'https://storage.example.test/presigned/od_asset_123',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url === 'https://storage.example.test/presigned/od_asset_123' && method === 'PUT') {
        // CRITICAL security invariant: presigned PUT must NEVER include Authorization header!
        assert.equal(hdrs.authorization, undefined);
        return new Response(null, { status: 200 });
      }

      if (url === 'https://amr-api.open-design.ai/api/v1/media/uploads/od_asset_123/commit') {
        return new Response(JSON.stringify({ status: 'ready', asset_id: 'od_asset_123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === 'https://amr-api.open-design.ai/api/v1/media/images/edits') {
        return new Response(JSON.stringify({ task_id: 'img_task_99' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === 'https://amr-api.open-design.ai/api/v1/media/videos/tasks') {
        return new Response(JSON.stringify({ task_id: 'vid_task_77' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === 'https://amr-api.open-design.ai/api/v1/media/videos/tasks/vid_task_77') {
        return new Response(JSON.stringify({ task_id: 'vid_task_77', status: 'succeeded' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === 'https://amr-api.open-design.ai/api/v1/media/videos/tasks/vid_task_77/content') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://cdn-signed.example.test/videos/vid_task_77.mp4' },
        });
      }

      if (url === 'https://cdn-signed.example.test/videos/vid_task_77.mp4') {
        // CRITICAL security invariant: redirected signed download MUST NOT receive Authorization header!
        assert.equal(hdrs.authorization, undefined);
        return new Response(new Uint8Array(sampleMp4), {
          status: 200,
          headers: { 'Content-Type': 'video/mp4' },
        });
      }

      return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
    };

    const gateway = new OpenDesignModelGateway({
      apiUrl: 'https://amr-api.open-design.ai',
      linkUrl: 'https://amr-link.open-design.ai',
      s2sApiKey: 'test-s2s-service-key',
      billingSyncEnabled: false,
      fetcher: mockFetcher,
    });

    const ctx = {
      workspaceId: randomUUID(),
      externalWorkspaceId: 'vela-ws-88',
      externalUserId: 'vela-user-55',
      idempotencyKey: 'idem-job-1',
    };

    // 1. Model catalog discovery
    const models = await gateway.listMediaModels(ctx);
    assert.ok(models.some((m) => m.id === 'opendesign:wan-2.7'));
    assert.ok(models.some((m) => m.id === 'opendesign:flux-pro' && m.supportsImageReference === true));
    assert.ok(models.some((m) => m.id === 'opendesign:elevenlabs-music-v2'));
    assert.equal(calls[0].headers.authorization, 'Bearer test-s2s-service-key');
    assert.equal(calls[0].headers['x-vela-workspace-id'], 'vela-ws-88');

    // 2. 3-step reference upload
    const refBytes = generateDeterministicPng('ref-s2s');
    const uploaded = await gateway.uploadReference(ctx, {
      bytes: refBytes,
      mimeType: 'image/png',
      idempotencyKey: 'upload-1',
    });
    assert.equal(uploaded.remoteAssetId, 'od_asset_123');
    assert.equal(calls[1].headers['idempotency-key'], 'upload-1-upload');
    assert.equal(calls[3].headers['idempotency-key'], 'upload-1-commit');

    // 3. Image edit with paired aspect_ratio + resolution -> wire output object
    const imgSubmitted = await gateway.submitTask(ctx, {
      jobId: 'job-edit-1',
      modality: 'image',
      mode: 'text-to-image',
      modelId: 'flux-pro',
      prompt: 'make it golden hour',
      parameters: { aspect_ratio: '16:9', resolution: '1K' },
      inputs: [{ remoteAssetId: 'od_asset_123' }],
    });
    assert.equal(imgSubmitted.remoteTaskId, 'img_task_99');
    const editPayload = JSON.parse(calls[4].body!) as { output?: { aspect_ratio: string; resolution: string }; images?: string[] };
    assert.deepEqual(editPayload.output, { aspect_ratio: '16:9', resolution: '1K' });
    assert.deepEqual(editPayload.images, ['od_asset_123']);

    // 4. Video submit -> poll -> /content 302 credential-free download
    const vidSubmitted = await gateway.submitTask(ctx, {
      jobId: 'job-vid-s2s',
      modality: 'video',
      mode: 'text-to-video',
      modelId: 'wan-2.7',
      prompt: 'cinematic glide',
      parameters: {},
      inputs: [{ remoteAssetId: 'od_asset_123', role: 'first_frame' }],
    });
    assert.equal(vidSubmitted.remoteTaskId, 'vid_task_77');
    const polled = await gateway.pollTask(ctx, { modality: 'video', remoteTaskId: 'vid_task_77' });
    assert.equal(polled.status, 'succeeded');
    const downloaded = await streamToBuffer(await gateway.downloadOutput(ctx, polled.outputs![0]));
    assert.deepEqual(downloaded, sampleMp4);

    // 5. Billing sync disabled by default (no upstream call)
    const billing = await gateway.getBillingSummary(ctx);
    assert.equal(billing.unavailable, true);

    // 6. ASR without OPENDESIGN_ASR_URL returns explicit FEATURE_DEFERRED_P2 (501)
    await assert.rejects(
      () => gateway.transcribeAudio(ctx, { audioWav: generateDeterministicWav('asr') }),
      (err: unknown) => isCloudError(err) && err.code === 'FEATURE_DEFERRED_P2' && err.status === 501,
    );
  });
});

describe('Hono Routes: /motion-api/models/* & /motion-api/account/*', () => {
  it('enforces RBAC + strict scope checks on model defaults and workspace switch', async () => {
    const config = makeGatewayConfig();
    const authStore = new InMemoryAuthStore();
    const ws1 = authStore.seedWorkspace({ role: 'owner', name: 'Studio Alpha' });
    const ws2 = authStore.seedWorkspace({ role: 'owner', name: 'Studio Beta' });
    // Grant ws1.user editor membership in ws2
    authStore.setRole(ws2.workspace.id, ws1.user.id, 'editor');
    const ws3 = authStore.seedWorkspace({ role: 'owner', name: 'Forbidden Studio' });

    const session = await createBrowserSession(authStore, {
      userId: ws1.user.id,
      workspaceId: ws1.workspace.id,
    });
    const restrictedOwnerPat = await createPat(
      authStore,
      {
        workspaceId: ws1.workspace.id,
        userId: ws1.user.id,
        role: 'owner',
        scopes: ['assets:read'],
        authMode: 'oidc',
        authMethod: 'session_cookie',
      },
      { name: 'Read Only Owner PAT' },
    );

    const gateway = createPlatformModelGateway(config);
    const app = new Hono<AuthEnv>();
    const authMw = createAuthMiddleware({ config, store: authStore });
    app.use('/motion-api/*', authMw);
    app.route('/motion-api/models', createModelRoutes({ gateway, authStore }));
    app.route('/motion-api/account', createAccountRoutes({ config, authStore, gateway }));

    // 1. Model catalog & status
    const catalogRes = await app.request('/motion-api/models', {
      headers: { Authorization: `Bearer ${restrictedOwnerPat.token}` },
    });
    assert.equal(catalogRes.status, 200);
    const catalogBody = (await catalogRes.json()) as { provider: string; models: unknown[] };
    assert.equal(catalogBody.provider, 'opendesign');
    assert.equal(catalogBody.models.length, 4);

    // 2. Removed BYOK providers return 404; opendesign reference returns guide
    const falRef = await app.request('/motion-api/models/providers/fal/reference', {
      headers: { Authorization: `Bearer ${restrictedOwnerPat.token}` },
    });
    assert.equal(falRef.status, 404);

    const odRef = await app.request('/motion-api/models/providers/opendesign/reference', {
      headers: { Authorization: `Bearer ${restrictedOwnerPat.token}` },
    });
    assert.equal(odRef.status, 200);

    // 3. PUT /motion-api/models/defaults rejects restricted owner PAT (403) and succeeds for full browser admin session
    const patPutRes = await app.request('/motion-api/models/defaults', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${restrictedOwnerPat.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ image: 'opendesign:mock-image-1' }),
    });
    assert.equal(patPutRes.status, 403);

    const browserPutRes = await app.request('/motion-api/models/defaults', {
      method: 'PUT',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${session.token}`,
        Origin: 'https://motion.example.test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ image: 'opendesign:mock-image-1', video: 'opendesign:mock-video-1' }),
    });
    assert.equal(browserPutRes.status, 200);
    const savedDefaults = (await browserPutRes.json()) as {
      defaults: { image: string; video: string };
    };
    assert.equal(savedDefaults.defaults.image, 'opendesign:mock-image-1');

    // 4. Account summary, integration discovery & workspace switch isolation
    const summaryRes = await app.request('/motion-api/account/summary', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` },
    });
    assert.equal(summaryRes.status, 200);
    const summary = (await summaryRes.json()) as {
      activeWorkspace: { id: string };
      workspaces: Array<{ id: string }>;
    };
    assert.equal(summary.activeWorkspace.id, ws1.workspace.id);
    assert.equal(summary.workspaces.length, 2);

    const integrationRes = await app.request('/motion-api/account/integration', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` },
    });
    assert.equal(integrationRes.status, 200);
    const integration = (await integrationRes.json()) as {
      transport: { type: string; url: string };
      tools: unknown[];
    };
    assert.equal(integration.transport.type, 'streamable-http');
    assert.equal(integration.transport.url, 'https://motion.example.test/mcp');
    assert.equal(integration.tools.length, 22);

    // Switching to non-member workspace ws3 is rejected with 403 WORKSPACE_FORBIDDEN
    const forbiddenSwitch = await app.request('/motion-api/account/workspaces/switch', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${session.token}`,
        Origin: 'https://motion.example.test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workspaceId: ws3.workspace.id }),
    });
    assert.equal(forbiddenSwitch.status, 403);

    // Switching to member workspace ws2 succeeds
    const okSwitch = await app.request('/motion-api/account/workspaces/switch', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${session.token}`,
        Origin: 'https://motion.example.test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workspaceId: ws2.workspace.id }),
    });
    assert.equal(okSwitch.status, 200);
    assert.equal(((await okSwitch.json()) as { activeWorkspace: { id: string } }).activeWorkspace.id, ws2.workspace.id);
  });
});
