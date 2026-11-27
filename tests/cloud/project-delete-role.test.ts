import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { AuthContext, PatScope, WorkspaceRole } from '../../src/contracts/auth.ts';
import { createProjectsRouter } from '../../src/routes/projects.ts';

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

const ALL_SCOPES: readonly PatScope[] = [
  'projects:read',
  'projects:write',
  'assets:read',
  'assets:write',
  'exports:write',
  'media:generate',
  'mcp:tools',
  'workspace:admin',
];

function buildApp(auth: AuthContext, deletions: string[]) {
  const workspace = {
    async deleteProjectPermanently(_auth: AuthContext, projectId: string) {
      deletions.push(projectId);
      return { projectId, deleted: true, decrementedBlobRefs: 0 };
    },
  };
  return createProjectsRouter({
    workspace: workspace as never,
    files: {} as never,
    history: {} as never,
    assetNames: {} as never,
    workRounds: {} as never,
    resolveAuth: () => auth,
  });
}

describe('DELETE /motion-api/projects/:id authorization parity with the MCP delete action', () => {
  it('rejects an editor: permanent deletion is admin-only on both entry points', async () => {
    const deletions: string[] = [];
    const app = buildApp(
      makeAuth('editor', [
        'projects:read',
        'projects:write',
        'assets:read',
        'assets:write',
        'exports:write',
        'media:generate',
        'mcp:tools',
      ]),
      deletions,
    );

    const response = await app.request(`/motion-api/projects/${randomUUID()}`, { method: 'DELETE' });

    assert.equal(response.status, 403);
    assert.equal(deletions.length, 0, 'workspace service must not be called for an editor');
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, 'FORBIDDEN');
  });

  it('rejects an admin whose token was minted without the workspace:admin scope', async () => {
    // Role alone is not enough: a restricted PAT keeps the admin role but drops workspace:admin,
    // and the route must fail on the scope half of the policy rather than fall back to write.
    const deletions: string[] = [];
    const app = buildApp(
      makeAuth(
        'admin',
        ALL_SCOPES.filter((scope) => scope !== 'workspace:admin'),
      ),
      deletions,
    );

    const response = await app.request(`/motion-api/projects/${randomUUID()}`, { method: 'DELETE' });

    assert.equal(response.status, 403);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, 'INSUFFICIENT_SCOPE');
    assert.deepEqual(deletions, []);
  });

  it('allows an admin to permanently delete a project', async () => {
    const deletions: string[] = [];
    const projectId = randomUUID();
    const app = buildApp(makeAuth('admin', ALL_SCOPES), deletions);

    const response = await app.request(`/motion-api/projects/${projectId}`, { method: 'DELETE' });

    assert.equal(response.status, 200);
    assert.deepEqual(deletions, [projectId]);
  });

  it('allows an owner to permanently delete a project', async () => {
    const deletions: string[] = [];
    const projectId = randomUUID();
    const app = buildApp(makeAuth('owner', ALL_SCOPES), deletions);

    const response = await app.request(`/motion-api/projects/${projectId}`, { method: 'DELETE' });

    assert.equal(response.status, 200);
    assert.deepEqual(deletions, [projectId]);
  });
});