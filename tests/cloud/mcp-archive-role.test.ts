import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { AuthContext, PatScope, WorkspaceRole } from '../../src/contracts/auth.ts';
import { parseConfig, type AppConfig } from '../../src/infra/config.ts';
import { McpToolDispatcher } from '../../src/mcp/index.ts';
import { MockModelGateway } from '../../src/services/mock-model-adapter.ts';

function makeConfig(): AppConfig {
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
  });
}

function makeAuth(role: WorkspaceRole, scopes: readonly PatScope[]): AuthContext {
  return {
    userId: randomUUID(),
    workspaceId: randomUUID(),
    role,
    scopes: [...scopes],
    authMode: 'oidc',
    authMethod: 'pat',
  };
}

function makeDispatcher(onExport: () => void): McpToolDispatcher {
  return new McpToolDispatcher(makeConfig(), {
    gateway: new MockModelGateway(),
    archive: {
      async handleProjectArchive() {
        onExport();
        return { archiveId: randomUUID() };
      },
    },
  });
}

const archiveArgs = () => ({ action: 'export', requestId: `req-${randomUUID()}`, all: true });

describe('openmotion_project_archive authorization parity with the HTTP export route', () => {
  it('denies a read-only viewer token before the archive service runs', async () => {
    let exports = 0;
    const dispatcher = makeDispatcher(() => {
      exports += 1;
    });
    // Exactly the scopes a viewer holds (src/auth/store.ts VIEWER_SCOPES).
    const viewer = makeAuth('viewer', ['projects:read', 'assets:read', 'mcp:tools']);

    const result = await dispatcher.dispatch('openmotion_project_archive', archiveArgs(), {
      auth: viewer,
      supportsMcpAppsUi: false,
    });

    assert.equal(exports, 0, 'archive export must not run for a viewer token');
    const serialized = JSON.stringify(result);
    assert.match(serialized, /INSUFFICIENT_SCOPE/, 'viewer must be rejected on scope');
  });

  it('denies a caller that holds projects:write without the editor role', async () => {
    let exports = 0;
    const dispatcher = makeDispatcher(() => {
      exports += 1;
    });
    // A PAT can never mint this combination (scopes are intersected with the live role), but the
    // dispatcher must still fail closed if it ever reaches it.
    const impossible = makeAuth('viewer', ['projects:read', 'projects:write', 'mcp:tools']);

    const result = await dispatcher.dispatch('openmotion_project_archive', archiveArgs(), {
      auth: impossible,
      supportsMcpAppsUi: false,
    });

    assert.equal(exports, 0);
    assert.match(JSON.stringify(result), /FORBIDDEN/);
  });

  it('allows an editor with projects:write, matching the HTTP route policy', async () => {
    let exports = 0;
    const dispatcher = makeDispatcher(() => {
      exports += 1;
    });
    const editor = makeAuth('editor', [
      'projects:read',
      'projects:write',
      'assets:read',
      'assets:write',
      'exports:write',
      'media:generate',
      'mcp:tools',
    ]);

    const result = await dispatcher.dispatch('openmotion_project_archive', archiveArgs(), {
      auth: editor,
      supportsMcpAppsUi: false,
    });

    assert.equal(exports, 1);
    assert.match(JSON.stringify(result), /archiveId/);
  });
});