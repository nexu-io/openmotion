import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import {
  buildCloudIntegrationInfo,
  integrationConfig,
  isIntegrationInfo,
  manualConnection,
  supportsChatgptCloud,
} from '../../shared/integration.ts';
import { phase1Tools } from '../../shared/phase1-tools.ts';
import {
  InMemoryAuthStore,
  SESSION_COOKIE_NAME,
  createBrowserSession,
  createPat,
  type AuthEnv,
} from '../../src/auth/index.ts';
import { PAT_SCOPES } from '../../src/contracts/auth.ts';
import type { StoragePort } from '../../src/contracts/storage.ts';
import { parseConfig, type AppConfig } from '../../src/infra/config.ts';
import { mcpEventsChannel } from '../../src/infra/redis.ts';
import {
  CloudImportAssetsService,
  InMemoryMcpSessionStore,
  McpStreamableHttpHandler,
  McpToolDispatcher,
  createMcpHttpRoutes,
  type ImportAssetsStore,
  type McpEventBusPort,
  type UploadTicketRecord,
} from '../../src/mcp/index.ts';
import { MockModelGateway } from '../../src/services/mock-model-adapter.ts';

// ---------------------------------------------------------------------------
// Test Doubles for Storage, Queue, EventBus & ImportAssetsStore
// ---------------------------------------------------------------------------

class InMemoryEventBus implements McpEventBusPort {
  private readonly channels = new Map<string, Set<(payload: unknown, ch: string) => void>>();

  async publish(channel: string, payload: unknown): Promise<number> {
    const listeners = this.channels.get(channel);
    if (!listeners) return 0;
    for (const listener of listeners) listener(payload, channel);
    return listeners.size;
  }

  async subscribe(
    channel: string,
    listener: (payload: unknown, channel: string) => void,
  ): Promise<() => Promise<void>> {
    let bucket = this.channels.get(channel);
    if (!bucket) {
      bucket = new Set();
      this.channels.set(channel, bucket);
    }
    bucket.add(listener);
    return async () => {
      bucket?.delete(listener);
    };
  }
}

class InMemoryImportAssetsStore implements ImportAssetsStore {
  readonly activeProjects = new Set<string>(); // `${wid}:${pid}`
  readonly receipts = new Map<
    string,
    { inputHash: string; state: string; responsePayload: Record<string, unknown> | null }
  >();
  readonly tickets = new Map<string, UploadTicketRecord>();
  readonly jobs: Array<{
    id: string;
    workspaceId: string;
    projectId: string;
    state: 'queued' | 'failed';
    errorCode?: string;
    errorMessage?: string;
    inputPayload: Record<string, unknown>;
  }> = [];
  readonly zeroCopyCommits: Array<{ workspaceId: string; projectId: string; assetId: string; versionId: string }> = [];

  async assertActiveProject(workspaceId: string, projectId: string) {
    if (!this.activeProjects.has(`${workspaceId}:${projectId}`)) {
      throw new Error('PROJECT_NOT_FOUND');
    }
    return { id: projectId };
  }

  async findReceipt(workspaceId: string, scope: string, requestId: string) {
    return this.receipts.get(`${workspaceId}:${scope}:${requestId}`) ?? null;
  }

  async saveCompletedReceipt(input: {
    workspaceId: string;
    scope: string;
    requestId: string;
    inputHash: string;
    responsePayload: Record<string, unknown>;
  }) {
    this.receipts.set(`${input.workspaceId}:${input.scope}:${input.requestId}`, {
      inputHash: input.inputHash,
      state: 'completed',
      responsePayload: input.responsePayload,
    });
  }

  async insertUploadTicket(input: {
    id: string;
    workspaceId: string;
    userId: string;
    targetProjectId: string;
    targetPath: string;
    filename: string;
    expectedMimeType: string;
    expectedSha256: string | null;
    maxBytes: number;
    s3StagingKey: string;
    licenseS3StagingKey: string | null;
    licenseFilename: string | null;
    licenseMaxBytes: number | null;
    requestId: string;
    expiresAt: Date;
  }): Promise<UploadTicketRecord> {
    const rec: UploadTicketRecord = { ...input, state: 'issued' };
    this.tickets.set(`${input.workspaceId}:${input.id}`, rec);
    return rec;
  }

  async findUploadTicket(workspaceId: string, ticketId: string) {
    return this.tickets.get(`${workspaceId}:${ticketId}`) ?? null;
  }

  async markUploadTicketProcessing(workspaceId: string, ticketId: string) {
    const rec = this.tickets.get(`${workspaceId}:${ticketId}`);
    if (!rec || (rec.state !== 'issued' && rec.state !== 'uploaded')) return false;
    rec.state = 'processing';
    return true;
  }

  async revertUploadTicketProcessing(
    workspaceId: string,
    ticketId: string,
    previousState: 'issued' | 'uploaded',
  ) {
    const rec = this.tickets.get(`${workspaceId}:${ticketId}`);
    if (rec && rec.state === 'processing') {
      rec.state = previousState;
    }
  }

  async createMediaIngestJob(input: {
    id: string;
    workspaceId: string;
    projectId: string;
    requestId: string;
    inputPayload: Record<string, unknown>;
  }) {
    this.jobs.push({ ...input, state: 'queued' });
  }

  async markMediaIngestJobFailed(
    workspaceId: string,
    jobId: string,
    errorCode: string,
    errorMessage: string,
  ) {
    const job = this.jobs.find((j) => j.workspaceId === workspaceId && j.id === jobId);
    if (job && job.state === 'queued') {
      job.state = 'failed';
      job.errorCode = errorCode;
      job.errorMessage = errorMessage;
    }
  }

  async commitLibraryAssetZeroCopy(input: {
    workspaceId: string;
    projectId: string;
    assetId: string;
    versionId: string;
  }) {
    this.zeroCopyCommits.push(input);
    return {
      assetId: input.assetId,
      versionId: input.versionId,
      path: `assets/imported/${input.assetId}.png`,
      sha256: 'a'.repeat(64),
      bytes: 1024,
      mimeType: 'image/png',
      projectRevision: 'b'.repeat(64),
      projectVersionId: randomUUID(),
      projectVersionNumber: 2,
    };
  }
}

function createMockStorage(stagedSizes: Map<string, number>): StoragePort {
  return {
    async putObject() {},
    async putBlobIfAbsent() {
      return { uploaded: true };
    },
    async getObjectBuffer() {
      return Buffer.alloc(0);
    },
    async getObjectStream() {
      throw new Error('not used');
    },
    async headObject(key) {
      const len = stagedSizes.get(key);
      if (len === undefined) return null;
      return { contentLength: len, contentType: 'image/png' };
    },
    async deleteObject() {},
    async deletePrefix() {
      return 0;
    },
    async presignPut(key) {
      return `https://s3.example.test/openmotion/${key}?X-Amz-Signature=mock`;
    },
    async presignGet(key) {
      return `https://s3.example.test/openmotion/${key}?X-Amz-Signature=mock`;
    },
    async ensureBucketAndCors() {},
  };
}

function makeMcpConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    WORKER_ROLE: 'api',
    APP_PUBLIC_ORIGIN: 'https://motion.example.test',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://idp.example.test',
    OIDC_CLIENT_ID: 'openmotion-cloud',
    SESSION_SECRET: '0'.repeat(32),
    MODEL_GATEWAY_MODE: 'mock',
    MCP_MAX_BODY_BYTES: '10485760',
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/openmotion',
    REDIS_URL: 'redis://127.0.0.1:6379',
    ...overrides,
  });
}

async function rpcPost(
  app: Hono<AuthEnv>,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request('https://motion.example.test/mcp', {
    method: 'POST',
    headers: {
      Host: 'motion.example.test',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Streamable HTTP /mcp Multi-Replica Sessions, 22 Tools, Security & 10 MiB Body Limit', () => {
  it('supports zero-sticky-session multi-replica execution, owner-bound sessions, 22 domain tools, and negotiated MCP Apps UI', async () => {
    const config = makeMcpConfig();
    const authStore = new InMemoryAuthStore();
    const tenantA = authStore.seedWorkspace({ displayName: 'Tenant A' });
    const tenantB = authStore.seedWorkspace({ displayName: 'Tenant B' });

    const patA = await createPat(
      authStore,
      {
        workspaceId: tenantA.workspace.id,
        userId: tenantA.user.id,
        role: 'owner',
        scopes: [...PAT_SCOPES],
        authMode: 'oidc',
        authMethod: 'session_cookie',
      },
      { name: 'Tenant A PAT' },
    );
    const patB = await createPat(
      authStore,
      {
        workspaceId: tenantB.workspace.id,
        userId: tenantB.user.id,
        role: 'owner',
        scopes: [...PAT_SCOPES],
        authMode: 'oidc',
        authMethod: 'session_cookie',
      },
      { name: 'Tenant B PAT' },
    );

    const sharedSessionStore = new InMemoryMcpSessionStore();
    const sharedEventBus = new InMemoryEventBus();
    const mockGateway = new MockModelGateway();
    let editedBytesReceived = 0;

    const dispatcher = new McpToolDispatcher(config, {
      gateway: mockGateway,
      projects: {
        async getProject(auth) {
          return { workspaceId: auth.workspaceId, projects: [] };
        },
        async createProject() {
          return { projectId: randomUUID(), sessionId: randomUUID() };
        },
        async editProject(_auth, args) {
          const files = (args.files as Array<{ content: string }>) ?? [];
          editedBytesReceived = files.reduce((n, f) => n + f.content.length, 0);
          return { ok: true, revision: 'c'.repeat(64), versionId: randomUUID() };
        },
        async openPreview() {
          return { previewUrl: 'https://motion.example.test/sessions/1' };
        },
        async manageProject() {
          return { ok: true };
        },
      },
    });

    // Two completely separate API replicas sharing ONLY sessionStore + eventBus (no sticky sessions!).
    const replicaA = createMcpHttpRoutes({
      config,
      dispatcher,
      sessionStore: sharedSessionStore,
      eventBus: sharedEventBus,
      auth: { config, store: authStore },
    });
    const replicaB = createMcpHttpRoutes({
      config,
      dispatcher,
      sessionStore: sharedSessionStore,
      eventBus: sharedEventBus,
      auth: { config, store: authStore },
    });

    // 1. Initialize on Replica A WITH MCP Apps UI extension
    const initRes = await rpcPost(
      replicaA,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          clientInfo: { name: 'codex-cloud', version: '1.0' },
          capabilities: {
            extensions: {
              'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
            },
          },
        },
      },
      { Authorization: `Bearer ${patA.token}` },
    );
    assert.equal(initRes.status, 200);
    const sessionId = initRes.headers.get('mcp-session-id');
    assert.ok(sessionId, 'initialize must return Mcp-Session-Id');

    // 2. Call tools/list on Replica B using sessionId created on Replica A!
    const listRes = await rpcPost(
      replicaB,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { Authorization: `Bearer ${patA.token}`, 'Mcp-Session-Id': sessionId },
    );
    assert.equal(listRes.status, 200);
    const listBody = (await listRes.json()) as { result: { tools: Array<{ name: string }> } };
    const toolNames = listBody.result.tools.map((t) => t.name);
    // All 22 registered domain tools MUST be present:
    assert.equal(phase1Tools.length, 22);
    for (const def of phase1Tools) {
      assert.ok(toolNames.includes(def.name), `Missing registered tool: ${def.name}`);
    }
    // Negotiated MCP Apps UI extension preserved across replicas:
    assert.ok(toolNames.includes('openmotion_show_video'));

    // 3. Non-App client without UI extension sees strictly 22 domain tools (no openmotion_show_video)
    const plainInit = await rpcPost(
      replicaA,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          clientInfo: { name: 'plain-cli', version: '1.0' },
          capabilities: {},
        },
      },
      { Authorization: `Bearer ${patA.token}` },
    );
    assert.equal(plainInit.status, 200);
    const plainSessionId = plainInit.headers.get('mcp-session-id')!;
    assert.ok(plainSessionId);
    const plainList = await rpcPost(
      replicaB,
      { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
      { Authorization: `Bearer ${patA.token}`, 'Mcp-Session-Id': plainSessionId },
    );
    assert.equal(plainList.status, 200);
    const plainNames = ((await plainList.json()) as { result: { tools: Array<{ name: string }> } })
      .result.tools.map((t) => t.name);
    assert.equal(plainNames.length, 22);
    assert.equal(plainNames.includes('openmotion_show_video'), false);

    // 4. Cross-tenant Mcp-Session-Id replay returns 404 (owner-bound isolation!)
    const crossTenantRes = await rpcPost(
      replicaB,
      { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} },
      { Authorization: `Bearer ${patB.token}`, 'Mcp-Session-Id': sessionId },
    );
    assert.equal(crossTenantRes.status, 404);

    // 5. Browser cookie on /mcp is strictly rejected (401)
    const browserSession = await createBrowserSession(authStore, {
      userId: tenantA.user.id,
      workspaceId: tenantA.workspace.id,
    });
    const cookieReject = await rpcPost(
      replicaA,
      { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} },
      { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` },
    );
    assert.equal(cookieReject.status, 401);

    // 6. Origin/Host/Content-Type hardening
    const nullOrigin = await rpcPost(
      replicaA,
      { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} },
      { Authorization: `Bearer ${patA.token}`, Origin: 'null' },
    );
    assert.equal(nullOrigin.status, 403);

    const foreignOrigin = await rpcPost(
      replicaA,
      { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} },
      { Authorization: `Bearer ${patA.token}`, Origin: 'https://evil.example.net' },
    );
    assert.equal(foreignOrigin.status, 403);

    const wrongCt = await replicaA.request('https://motion.example.test/mcp', {
      method: 'POST',
      headers: {
        Host: 'motion.example.test',
        Authorization: `Bearer ${patA.token}`,
        'Content-Type': 'text/plain',
      },
      body: '{}',
    });
    assert.equal(wrongCt.status, 415);

    // 7. MCP_MAX_BODY_BYTES (10 MiB): 8.5 MiB openmotion_edit_project succeeds; >10 MiB rejected with 413!
    const largeHtml = 'a'.repeat(8_500_000);
    const largeEditRes = await rpcPost(
      replicaB,
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'openmotion_edit_project',
          arguments: {
            projectId: randomUUID(),
            requestId: 'req-large-8mib',
            expectedRevision: 'a'.repeat(64),
            expectedVersionId: randomUUID(),
            files: [{ path: 'index.html', content: largeHtml }],
          },
        },
      },
      { Authorization: `Bearer ${patA.token}`, 'Mcp-Session-Id': sessionId },
    );
    assert.equal(largeEditRes.status, 200);
    assert.equal(editedBytesReceived, 8_500_000);

    const oversizedBody = '{"jsonrpc":"2.0","id":10,"pad":"' + 'x'.repeat(10_600_000) + '"}';
    const tooLargeRes = await rpcPost(replicaA, oversizedBody, {
      Authorization: `Bearer ${patA.token}`,
      'Mcp-Session-Id': sessionId,
    });
    assert.equal(tooLargeRes.status, 413);

    // 8. GET /mcp SSE stream receives RedisEventBus messages across replicas & DELETE /mcp terminates session
    const abortController = new AbortController();
    const sseRes = await replicaB.request('https://motion.example.test/mcp', {
      method: 'GET',
      headers: {
        Host: 'motion.example.test',
        Authorization: `Bearer ${patA.token}`,
        'Mcp-Session-Id': sessionId,
      },
      signal: abortController.signal,
    });
    assert.equal(sseRes.status, 200);
    assert.equal(sseRes.headers.get('x-accel-buffering'), 'no');
    assert.match(sseRes.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = sseRes.body!.getReader();
    const firstChunk = await reader.read();
    assert.match(new TextDecoder().decode(firstChunk.value), /: connected/);

    await sharedEventBus.publish(mcpEventsChannel(tenantA.workspace.id, sessionId), {
      kind: 'tools_list_changed',
    });
    const eventChunk = await reader.read();
    assert.match(new TextDecoder().decode(eventChunk.value), /tools_list_changed/);
    abortController.abort();
    await reader.cancel();

    const delRes = await replicaA.request('https://motion.example.test/mcp', {
      method: 'DELETE',
      headers: {
        Host: 'motion.example.test',
        Authorization: `Bearer ${patA.token}`,
        'Mcp-Session-Id': sessionId,
      },
    });
    assert.equal(delRes.status, 204);

    const afterDelete = await rpcPost(
      replicaB,
      { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} },
      { Authorization: `Bearer ${patA.token}`, 'Mcp-Session-Id': sessionId },
    );
    assert.equal(afterDelete.status, 404);
  });

  it('returns explicit FEATURE_DEFERRED_P2 (501) for P2 tools and serves resources cleanly without local runtime', async () => {
    const config = makeMcpConfig({ OPENDESIGN_ASR_URL: undefined });
    const authStore = new InMemoryAuthStore();
    const tenant = authStore.seedWorkspace({ displayName: 'P2 Tester' });
    const pat = await createPat(
      authStore,
      {
        workspaceId: tenant.workspace.id,
        userId: tenant.user.id,
        role: 'owner',
        scopes: [...PAT_SCOPES],
        authMode: 'oidc',
        authMethod: 'session_cookie',
      },
      { name: 'P2 PAT' },
    );

    const dispatcher = new McpToolDispatcher(config, {
      gateway: new MockModelGateway(),
    });
    const app = createMcpHttpRoutes({
      config,
      dispatcher,
      sessionStore: new InMemoryMcpSessionStore(),
      auth: { config, store: authStore },
    });

    const p2Calls = [
      { name: 'openmotion_design_project', arguments: { action: 'create', scenario: 'deck' } },
      { name: 'openmotion_design_edit', arguments: { action: 'write', projectId: randomUUID() } },
      { name: 'openmotion_design_comments', arguments: { action: 'list', projectId: randomUUID() } },
      {
        name: 'openmotion_manage_project',
        arguments: { action: 'comments', projectId: randomUUID(), operation: 'list' },
      },
      {
        name: 'openmotion_assets_use',
        arguments: {
          action: 'brand_kit',
          brandKit: { operation: 'create', requestId: 'req-bk-1', url: 'https://example.com' },
        },
      },
      {
        name: 'openmotion_assets',
        arguments: {
          action: 'brand_kit',
          brandKit: { operation: 'create', requestId: 'req-bk-alias', url: 'https://example.com' },
        },
      },
      {
        name: 'openmotion_assets_use',
        arguments: {
          action: 'transcript',
          transcript: {
            command: 'submit',
            projectId: randomUUID(),
            sourcePath: 'assets/speech.wav',
            requestId: 'req-asr-1',
          },
        },
      },
      {
        name: 'openmotion_assets',
        arguments: {
          action: 'transcript',
          transcript: {
            command: 'submit',
            projectId: randomUUID(),
            sourcePath: 'assets/speech.wav',
            requestId: 'req-asr-alias',
          },
        },
      },
    ];

    for (const [idx, call] of p2Calls.entries()) {
      const res = await rpcPost(
        app,
        { jsonrpc: '2.0', id: 100 + idx, method: 'tools/call', params: call },
        { Authorization: `Bearer ${pat.token}` },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        result: { isError: boolean; structuredContent: { error: { code: string; status: number; applied: boolean } } };
      };
      assert.equal(body.result.isError, true, `Expected isError on ${call.name}`);
      assert.equal(body.result.structuredContent.error.code, 'FEATURE_DEFERRED_P2');
      assert.equal(body.result.structuredContent.error.status, 501);
      assert.equal(body.result.structuredContent.error.applied, false);
    }

    // Read-only openmotion_design_catalog works in P1!
    const catalogRes = await rpcPost(
      app,
      {
        jsonrpc: '2.0',
        id: 200,
        method: 'tools/call',
        params: { name: 'openmotion_design_catalog', arguments: { action: 'list_scenarios' } },
      },
      { Authorization: `Bearer ${pat.token}` },
    );
    const catalogBody = (await catalogRes.json()) as {
      result: { isError?: boolean; structuredContent: { scenarios: unknown[] } };
    };
    assert.notEqual(catalogBody.result.isError, true);
    assert.ok(Array.isArray(catalogBody.result.structuredContent.scenarios));

    // resources/list and resources/read resolve workflow and engine SKILL.md cleanly
    const resList = await rpcPost(
      app,
      { jsonrpc: '2.0', id: 201, method: 'resources/list', params: {} },
      { Authorization: `Bearer ${pat.token}` },
    );
    const resources = ((await resList.json()) as { result: { resources: Array<{ uri: string }> } })
      .result.resources;
    assert.ok(resources.some((r) => r.uri === 'openmotion://workflow/production/start'));
    assert.ok(resources.some((r) => r.uri === 'openmotion://engine/SKILL.md'));

    const engineRead = await rpcPost(
      app,
      {
        jsonrpc: '2.0',
        id: 202,
        method: 'resources/read',
        params: { uri: 'openmotion://engine/SKILL.md' },
      },
      { Authorization: `Bearer ${pat.token}` },
    );
    const engineBody = (await engineRead.json()) as {
      result: { contents: Array<{ uri: string; text: string }> };
    };
    assert.equal(engineBody.result.contents[0].uri, 'openmotion://engine/SKILL.md');
    assert.ok(engineBody.result.contents[0].text.length > 100);
  });
});

describe('3-Way Cloud openmotion_import_assets & Streamable HTTP Config Contracts', () => {
  it('supports prepare_upload + upload_ticket, SSRF-checked url, zero-copy library_asset, and rejects legacy sourcePath', async () => {
    const config = makeMcpConfig();
    const importStore = new InMemoryImportAssetsStore();
    const stagedSizes = new Map<string, number>();
    const enqueued: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    importStore.activeProjects.add(`${workspaceId}:${projectId}`);

    const importService = new CloudImportAssetsService({
      store: importStore,
      storage: createMockStorage(stagedSizes),
      queues: {
        async enqueueMediaIngest(name, payload) {
          enqueued.push({ name, payload: payload as unknown as Record<string, unknown> });
          return {} as never;
        },
      },
      config,
      urlValidation: {
        resolveDns: true,
        dnsLookup: async (hostname) => {
          if (hostname === 'private.example.test') {
            return [{ address: '10.0.0.5', family: 4 }];
          }
          return [{ address: '93.184.216.34', family: 4 }];
        },
      },
    });

    const auth = {
      workspaceId,
      userId: randomUUID(),
      role: 'editor' as const,
      scopes: [...PAT_SCOPES],
      authMode: 'oidc' as const,
      authMethod: 'pat' as const,
    };

    // Legacy sourcePath rejected explicitly with LOCAL_PATH_UNSUPPORTED_IN_CLOUD
    await assert.rejects(
      () =>
        importService.execute(auth, {
          projectId,
          requestId: 'req-legacy',
          items: [{ itemId: 'legacy-1', sourcePath: '/tmp/local.png' }],
        }),
      /LOCAL_PATH_UNSUPPORTED_IN_CLOUD/,
    );

    // Mode A Step 1: prepare_upload mints presigned PUT ticket + optional license upload
    const prepared = await importService.prepareUpload(auth, {
      action: 'prepare_upload',
      projectId,
      requestId: 'req-prep-1',
      files: [
        {
          itemId: 'font-1',
          filename: 'Inter-Bold.woff2',
          mimeType: 'font/woff2',
          bytes: 4096,
          licenseFilename: 'OFL.txt',
          licenseBytes: 512,
        },
      ],
    });
    assert.equal(prepared.tickets.length, 1);
    assert.equal(prepared.tickets[0].method, 'PUT');
    assert.ok(prepared.tickets[0].uploadUrl.startsWith('https://s3.example.test/'));
    assert.ok(prepared.tickets[0].licenseUpload?.uploadUrl.includes('.license'));

    // Simulate client PUT to staging S3
    const ticket = importStore.tickets.get(`${workspaceId}:${prepared.tickets[0].ticketId}`)!;
    assert.equal(ticket.targetPath, 'fonts/Inter-Bold.woff2');
    stagedSizes.set(ticket.s3StagingKey, 4096);

    // Mode A + Mode B (valid + SSRF blocked) + Mode C (zero-copy library_asset) in one batch
    const assetId = randomUUID();
    const versionId = randomUUID();
    const batch = await importService.importItems(auth, {
      projectId,
      requestId: 'req-import-all',
      items: [
        {
          itemId: 'mode-a',
          source: { kind: 'upload_ticket', ticketId: ticket.id },
          name: 'Inter Bold',
        },
        {
          itemId: 'mode-b-ok',
          source: { kind: 'url', url: 'https://cdn.example.com/hero.png' },
          name: 'Hero Banner',
        },
        {
          itemId: 'mode-b-ssrf-imds',
          source: { kind: 'url', url: 'https://169.254.169.254/latest/meta-data/' },
        },
        {
          itemId: 'mode-b-ssrf-dns',
          source: { kind: 'url', url: 'https://private.example.test/secret.png' },
        },
        {
          itemId: 'mode-b-ssrf-testnet',
          source: { kind: 'url', url: 'https://198.51.100.12/test.png' },
        },
        {
          itemId: 'mode-b-ssrf-localhost-dot',
          source: { kind: 'url', url: 'https://localhost./secret.png' },
        },
        {
          itemId: 'mode-b-ssrf-sublocalhost-dot',
          source: { kind: 'url', url: 'https://sub.localhost./secret.png' },
        },
        {
          itemId: 'mode-b-ssrf-metadata-dot',
          source: { kind: 'url', url: 'https://metadata.google.internal./computeMetadata/v1/' },
        },
        {
          itemId: 'mode-b-ssrf-k8s-dot',
          source: { kind: 'url', url: 'https://postgres.openmotion.svc.cluster.local./a.png' },
        },
        {
          itemId: 'mode-b-ssrf-local-dot',
          source: { kind: 'url', url: 'https://service.local./a.png' },
        },
        {
          itemId: 'mode-b-ssrf-single-label-dot',
          source: { kind: 'url', url: 'https://redis./a.png' },
        },
        {
          itemId: 'mode-c',
          source: { kind: 'library_asset', assetId, versionId },
          name: 'Library Clip',
        },
      ],
    });

    assert.equal(batch.status, 'partial');
    const byId = new Map(batch.items.map((item) => [item.itemId, item]));
    assert.equal(byId.get('mode-a')?.status, 'processing');
    assert.equal(byId.get('mode-b-ok')?.status, 'processing');
    assert.equal(byId.get('mode-b-ssrf-imds')?.error?.code, 'SSRF_BLOCKED');
    assert.equal(byId.get('mode-b-ssrf-dns')?.error?.code, 'SSRF_BLOCKED');
    assert.equal(byId.get('mode-b-ssrf-testnet')?.error?.code, 'SSRF_BLOCKED');
    assert.equal(byId.get('mode-b-ssrf-localhost-dot')?.error?.code, 'SSRF_BLOCKED');
    assert.equal(byId.get('mode-b-ssrf-sublocalhost-dot')?.error?.code, 'SSRF_BLOCKED');
    assert.equal(byId.get('mode-b-ssrf-metadata-dot')?.error?.code, 'SSRF_BLOCKED');
    assert.equal(byId.get('mode-b-ssrf-k8s-dot')?.error?.code, 'SSRF_BLOCKED');
    assert.equal(byId.get('mode-b-ssrf-local-dot')?.error?.code, 'SSRF_BLOCKED');
    assert.equal(byId.get('mode-b-ssrf-single-label-dot')?.error?.code, 'SSRF_BLOCKED');
    assert.equal(byId.get('mode-c')?.status, 'imported');
    assert.equal(byId.get('mode-c')?.zeroCopy, true);

    assert.equal(enqueued.length, 2);
    assert.equal(enqueued[0].name, 'upload_commit');
    assert.equal(enqueued[0].payload.targetPath, 'fonts/Inter-Bold.woff2');
    assert.equal(byId.get('mode-a')?.path, 'fonts/Inter-Bold.woff2');
    assert.equal(enqueued[1].name, 'url_fetch');
    assert.match(String(enqueued[1].payload.targetPath), /^assets\/imported\/[a-f0-9-]+\.png$/);
    assert.equal(byId.get('mode-b-ok')?.path, enqueued[1].payload.targetPath);
    assert.equal(importStore.zeroCopyCommits.length, 1);

    // Idempotent replay returns cached payload without re-enqueueing
    const replayed = await importService.importItems(auth, {
      projectId,
      requestId: 'req-import-all',
      items: [
        { itemId: 'mode-a', source: { kind: 'upload_ticket', ticketId: ticket.id }, name: 'Inter Bold' },
        { itemId: 'mode-b-ok', source: { kind: 'url', url: 'https://cdn.example.com/hero.png' }, name: 'Hero Banner' },
        { itemId: 'mode-b-ssrf-imds', source: { kind: 'url', url: 'https://169.254.169.254/latest/meta-data/' } },
        { itemId: 'mode-b-ssrf-dns', source: { kind: 'url', url: 'https://private.example.test/secret.png' } },
        { itemId: 'mode-b-ssrf-testnet', source: { kind: 'url', url: 'https://198.51.100.12/test.png' } },
        { itemId: 'mode-b-ssrf-localhost-dot', source: { kind: 'url', url: 'https://localhost./secret.png' } },
        { itemId: 'mode-b-ssrf-sublocalhost-dot', source: { kind: 'url', url: 'https://sub.localhost./secret.png' } },
        { itemId: 'mode-b-ssrf-metadata-dot', source: { kind: 'url', url: 'https://metadata.google.internal./computeMetadata/v1/' } },
        { itemId: 'mode-b-ssrf-k8s-dot', source: { kind: 'url', url: 'https://postgres.openmotion.svc.cluster.local./a.png' } },
        { itemId: 'mode-b-ssrf-local-dot', source: { kind: 'url', url: 'https://service.local./a.png' } },
        { itemId: 'mode-b-ssrf-single-label-dot', source: { kind: 'url', url: 'https://redis./a.png' } },
        { itemId: 'mode-c', source: { kind: 'library_asset', assetId, versionId }, name: 'Library Clip' },
      ],
    });
    assert.equal(replayed.replayed, true);
    assert.equal(enqueued.length, 2);
  });

  it('rolls back upload ticket & marks jobs failed without locking receipt on queue enqueue failure, allowing retry with same requestId', async () => {
    const config = makeMcpConfig();
    const importStore = new InMemoryImportAssetsStore();
    const stagedSizes = new Map<string, number>();
    const enqueued: Array<{ name: string; payload: Record<string, unknown> }> = [];
    let failEnqueue = true;

    const workspaceId = randomUUID();
    const projectId = randomUUID();
    importStore.activeProjects.add(`${workspaceId}:${projectId}`);

    const importService = new CloudImportAssetsService({
      store: importStore,
      storage: createMockStorage(stagedSizes),
      queues: {
        async enqueueMediaIngest(name, payload) {
          if (failEnqueue) {
            throw new Error('Redis connection refused');
          }
          enqueued.push({ name, payload: payload as unknown as Record<string, unknown> });
          return {} as never;
        },
      },
      config,
      urlValidation: {
        resolveDns: true,
        dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      },
    });

    const auth = {
      workspaceId,
      userId: randomUUID(),
      role: 'editor' as const,
      scopes: [...PAT_SCOPES],
      authMode: 'oidc' as const,
      authMethod: 'pat' as const,
    };

    const prepared = await importService.prepareUpload(auth, {
      action: 'prepare_upload',
      projectId,
      requestId: 'req-prep-rollback',
      files: [{ itemId: 'img-1', filename: 'logo.png', mimeType: 'image/png', bytes: 2048 }],
    });
    const ticketId = prepared.tickets[0].ticketId;
    const ticket = importStore.tickets.get(`${workspaceId}:${ticketId}`)!;
    stagedSizes.set(ticket.s3StagingKey, 2048);

    // Attempt 1: Redis/BullMQ enqueue fails -> ticket reverts to 'issued', jobs marked 'failed', no completed receipt saved
    const failedBatch = await importService.importItems(auth, {
      projectId,
      requestId: 'req-retryable-import',
      items: [
        { itemId: 'upload-1', source: { kind: 'upload_ticket', ticketId } },
        { itemId: 'url-1', source: { kind: 'url', url: 'https://cdn.example.com/clip.png' } },
      ],
    });

    assert.equal(failedBatch.status, 'failed');
    assert.equal(failedBatch.items[0].error?.code, 'QUEUE_ENQUEUE_FAILED');
    assert.equal(failedBatch.items[1].error?.code, 'QUEUE_ENQUEUE_FAILED');
    assert.equal(ticket.state, 'issued');
    assert.equal(importStore.jobs.length, 2);
    assert.ok(importStore.jobs.every((j) => j.state === 'failed' && j.errorCode === 'QUEUE_ENQUEUE_FAILED'));
    assert.equal(
      await importStore.findReceipt(workspaceId, 'phase1:import_assets', 'req-retryable-import'),
      null,
    );

    // Attempt 2: Queue recovers -> exact same requestId retries cleanly and transitions ticket + enqueues both jobs
    failEnqueue = false;
    const recoveredBatch = await importService.importItems(auth, {
      projectId,
      requestId: 'req-retryable-import',
      items: [
        { itemId: 'upload-1', source: { kind: 'upload_ticket', ticketId } },
        { itemId: 'url-1', source: { kind: 'url', url: 'https://cdn.example.com/clip.png' } },
      ],
    });

    assert.equal(recoveredBatch.status, 'processing');
    assert.equal(recoveredBatch.replayed, undefined);
    assert.equal(ticket.state, 'processing');
    assert.equal(enqueued.length, 2);
    assert.ok(
      await importStore.findReceipt(workspaceId, 'phase1:import_assets', 'req-retryable-import'),
    );
  });

  it('configures .mcp.json and shared/integration.ts for Streamable HTTP while preserving union stdio compatibility', async () => {
    const mcpJson = JSON.parse(
      await readFile(new URL('../../.mcp.json', import.meta.url), 'utf8'),
    ) as { mcpServers: { openmotion: { type: string; url: string } } };
    assert.equal(mcpJson.mcpServers.openmotion.type, 'http');
    assert.equal(mcpJson.mcpServers.openmotion.url, 'http://127.0.0.1:4173/mcp');

    const cloudInfo = buildCloudIntegrationInfo({
      publicOrigin: 'https://motion.open-design.ai',
      version: '1.0.0',
      workspaceId: randomUUID(),
      authMode: 'oidc',
      tools: phase1Tools.map((t) => ({ name: t.name, description: t.description })),
    });
    assert.equal(isIntegrationInfo(cloudInfo), true);
    assert.equal(supportsChatgptCloud(cloudInfo), true);
    assert.match(manualConnection(cloudInfo, 'claude', 'en'), /claude mcp add --transport http/);
    assert.match(manualConnection(cloudInfo, 'codex', 'en'), /codex mcp add openmotion --url/);
    assert.match(integrationConfig(cloudInfo, 'chatgpt').text, /streamable-http/);

    // Legacy stdio IntegrationInfo remains accepted during Wave 2B
    const stdioInfo = {
      name: 'OpenMotion',
      version: '0.0.1',
      previewUrl: 'http://127.0.0.1:4173',
      dataDirectory: '/synthetic/workspace',
      transport: {
        type: 'stdio' as const,
        command: 'node',
        args: ['--experimental-strip-types', 'mcp.ts'],
        env: { MOTION_DATA_DIR: '/synthetic/workspace' },
      },
      tools: [],
    };
    assert.equal(isIntegrationInfo(stdioInfo), true);
    assert.equal(supportsChatgptCloud(stdioInfo), false);
  });
});

// Keep McpStreamableHttpHandler directly exercised to ensure clean export surface.
void McpStreamableHttpHandler;
