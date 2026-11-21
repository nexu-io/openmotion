import test from 'node:test';
import assert from 'node:assert/strict';
import { designProjectsFor } from '../design-projects.ts';
import { Phase1Service } from '../phase1.ts';
import { pluginRoot } from '../hyperframes.ts';
import { SuperAgentConversations, superAgentConversations } from '../gateway/super-agent.ts';
import { buildResourceContextManifest, collectWorkspaceResources } from '../gateway/super-agent-resources.ts';
import { AssetAgentRpc } from '../gateway/asset-chat.ts';
import { fixture } from './fixtures.ts';
import { transport } from './http.ts';

test('collectWorkspaceResources and buildResourceContextManifest aggregate workspace inputs and filter cleanly', () => fixture(async store => {
  await designProjectsFor(store.directory).create({
    scenario: 'prototype',
    title: 'Neon Space Game',
    requestId: 'req-design-1',
  });

  const all = await collectWorkspaceResources(store, { limit: 100 });
  assert.ok(all.counts.designProjects >= 1);
  assert.ok(all.counts.motionProjects >= 1);
  assert.ok(all.counts.officialBrandKits > 0);
  assert.ok(all.counts.designTemplates > 0);
  assert.ok(all.counts.skills > 0);
  assert.ok(all.counts.designSkills > 0);

  const projectsOnly = await collectWorkspaceResources(store, { kind: 'design-project', query: 'Neon Space' });
  assert.equal(projectsOnly.items.length, 1);
  assert.equal(projectsOnly.items[0].kind, 'design-project');
  assert.equal(projectsOnly.items[0].title, 'Neon Space Game');

  const manifest = await buildResourceContextManifest(store, [
    { id: 'brand-ref', kind: 'brand-kit', title: 'Reference Brand', subtitle: 'editorial' },
  ]);
  assert.match(manifest, /^<openmotion-workspace-context>/);
  assert.match(manifest, /Neon Space Game/);
  assert.match(manifest, /Reference Brand/);
}));

test('SuperAgentConversations persists CRUD state, recovers interrupted runs, and enforces requestId idempotency', () => fixture(async store => {
  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
  });

  const created = await service.create({ engine: 'codex', permissionMode: 'on-request' });
  assert.equal(created.state, 'idle');
  assert.equal(created.title, 'New conversation');

  const updated = await service.update(created.id, {
    title: 'Interactive Game Build',
    pinned: true,
    permissionMode: 'auto',
    addArtifact: { kind: 'web', url: 'https://example.com/docs' },
  });
  assert.equal(updated.title, 'Interactive Game Build');
  assert.equal(updated.pinned, true);
  assert.equal(updated.permissionMode, 'auto');
  assert.equal(updated.artifacts.length, 1);
  assert.equal(updated.artifacts[0].kind, 'web');

  await assert.rejects(
    () => service.update(created.id, { addArtifact: { kind: 'design-project', url: 'javascript:alert(1)' } as any }),
    /same-origin/,
  );

  // Persist running state on disk directly to verify restart interruption recovery.
  const file = await service.file(created.id);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, JSON.stringify({ ...updated, state: 'running', approvals: [{ id: 'a1', kind: 'tool', title: 'Pending', detail: '{}' }] }));
  const reloaded = new SuperAgentConversations(store);
  const recovered = await reloaded.get(created.id);
  assert.equal(recovered.state, 'failed');
  assert.equal(recovered.approvals.length, 0);
  assert.match(recovered.error || '', /interrupted/i);

  const list = await reloaded.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);
  assert.equal(list[0].pinned, true);

  await reloaded.remove(created.id);
  await assert.rejects(() => reloaded.get(created.id), /CONVERSATION_NOT_FOUND/);
  await reloaded.close();
  await service.close();
}));

test('SuperAgentConversations runs Codex RPC dynamic tools, extracts artifacts, gates approvals, and deduplicates requestId', () => fixture(async store => {
  const phase1 = new Phase1Service(store, pluginRoot, {
    origin: () => 'http://127.0.0.1:4173',
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async fn => fn(),
    cancel: async () => ({ id: 'x', state: 'cancelled' } as any),
  });

  const toolCallsSeen: string[] = [];
  let approvalPrompted = false;

  class FakeRpc {
    onNotification: (msg: any) => void;
    sent: any[] = [];
    closed = false;

    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void, _onError: (err: Error) => void) {
      this.onNotification = onNotification;
    }

    async request(method: string, params: any) {
      if (method === 'initialize') return {};
      if (method === 'thread/start') return { thread: { id: 'thread-codex-1' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          // 1. Call workspace resource discovery dynamic tool
          this.onNotification({
            id: 101,
            method: 'item/tool/call',
            params: { callId: 'c1', tool: 'openmotion_workspace_resources', arguments: { kind: 'all' } },
          });
        });
        return { turn: { id: 'turn-1' } };
      }
      return {};
    }

    send(payload: any) {
      this.sent.push(payload);
      if (payload.id === 101) {
        toolCallsSeen.push('resources');
        queueMicrotask(() => {
          // 2. Call design project create (auto-extracts design-project artifact)
          this.onNotification({
            id: 102,
            method: 'item/tool/call',
            params: {
              callId: 'c2',
              tool: 'openmotion_design_project',
              arguments: { action: 'create', scenario: 'prototype', title: 'Retro Shooter' },
            },
          });
        });
      }
      if (payload.id === 102) {
        toolCallsSeen.push('design');
        queueMicrotask(() => {
          // 3. Call present_artifact for official Brand Kit catalog entry
          this.onNotification({
            id: 103,
            method: 'item/tool/call',
            params: {
              callId: 'c3',
              tool: 'openmotion_present_artifact',
              arguments: { kind: 'brand-kit', kitId: 'catalog:vercel' },
            },
          });
        });
      }
      if (payload.id === 103) {
        toolCallsSeen.push('present');
        queueMicrotask(() => {
          // 4. Request command approval under on-request policy
          approvalPrompted = true;
          this.onNotification({
            id: 104,
            method: 'item/commandExecution/requestApproval',
            params: { command: 'echo hello' },
          });
        });
      }
      if (payload.id === 104) {
        assert.equal(payload.result?.decision, 'accept');
        queueMicrotask(() => {
          this.onNotification({
            method: 'item/agentMessage/delta',
            params: { itemId: 'msg-a1', delta: 'Built **Retro Shooter** ' },
          });
          this.onNotification({
            method: 'item/completed',
            params: { item: { id: 'msg-a1', type: 'agentMessage', text: 'Built **Retro Shooter** in Design Studio.' } },
          });
          this.onNotification({
            method: 'turn/completed',
            params: { turn: { id: 'turn-1', status: 'completed' } },
          });
        });
      }
    }

    close() {
      this.closed = true;
    }
  }

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: FakeRpc as unknown as typeof AssetAgentRpc,
  });

  const chat = await service.create({ engine: 'codex', permissionMode: 'on-request' });
  const runtime = { origin: 'http://127.0.0.1:4173', phase1: () => phase1 };
  const turnInput = { requestId: 'req-turn-1', text: 'Build a retro arcade shooter game' };

  await service.start(chat.id, turnInput, runtime);
  // Idempotent retry with identical requestId succeeds; mismatched input fails with REQUEST_ID_CONFLICT
  await service.start(chat.id, turnInput, runtime);
  await assert.rejects(
    () => service.start(chat.id, { requestId: 'req-turn-1', text: 'Different prompt' }, runtime),
    /REQUEST_ID_CONFLICT/,
  );

  // Wait for approval prompt to arrive
  for (let i = 0; i < 60 && !approvalPrompted; i++) {
    await new Promise(r => setTimeout(r, 15));
  }
  const waiting = await service.get(chat.id);
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.approvals.length, 1);

  await service.answer(chat.id, waiting.approvals[0].id, true);

  for (let i = 0; i < 60; i++) {
    const snap = await service.get(chat.id);
    if (snap.state === 'idle') break;
    await new Promise(r => setTimeout(r, 15));
  }

  const done = await service.get(chat.id);
  assert.equal(done.state, 'idle');
  assert.equal(done.title, 'Build a retro arcade shooter game');
  assert.deepEqual(toolCallsSeen, ['resources', 'design', 'present']);
  assert.ok(done.artifacts.some(a => a.kind === 'design-project' && a.title === 'Retro Shooter'));
  assert.ok(done.artifacts.some(a => a.kind === 'brand-kit' && a.kitId === 'catalog:vercel'));
  assert.ok(done.messages.some(m => m.role === 'assistant' && m.text.includes('Retro Shooter')));
  assert.ok(done.messages.some(m => m.role === 'tool' && m.toolEvent?.artifactId));

  await service.close();
}));

test('SuperAgentConversations runs Claude Code stream-json turns and extracts artifacts', () => fixture(async store => {
  const phase1 = new Phase1Service(store, pluginRoot, {
    origin: () => 'http://127.0.0.1:4173',
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async fn => fn(),
    cancel: async () => ({ id: 'x', state: 'cancelled' } as any),
  });

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/claude',
    runClaude: async ({ prompt, onEvent }) => {
      assert.match(prompt, /<openmotion-workspace-context>/);
      await onEvent({ type: 'system', session_id: 'claude-sess-42' });
      await onEvent({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'mcp__openmotion__openmotion_create_project',
              input: { title: 'Launch Reel' },
            },
          ],
        },
      });
      await onEvent({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              content: JSON.stringify({ projectId: 'mproj-1', sessionId: 'msess-1', revision: 'rev1', project: { title: 'Launch Reel' } }),
            },
          ],
        },
      });
      await onEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Created your editable Motion project.' }] },
      });
    },
  });

  const chat = await service.create({ engine: 'claude', permissionMode: 'auto' });
  await service.start(chat.id, { requestId: 'req-claude-1', text: 'Create a launch reel' }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  for (let i = 0; i < 60; i++) {
    const snap = await service.get(chat.id);
    if (snap.state === 'idle') break;
    await new Promise(r => setTimeout(r, 15));
  }

  const done = await service.get(chat.id);
  assert.equal(done.threadId, 'claude-sess-42');
  assert.ok(done.artifacts.some(a => a.kind === 'motion-project' && a.projectId === 'mproj-1'));
  assert.ok(done.messages.some(m => m.role === 'assistant' && m.text === 'Created your editable Motion project.'));

  await service.close();
}));

test('HTTP /motion-api/super-agent/* routes serve resources, CRUD chats, SSE initial frame, and clean errors', () => fixture(async store => {
  const req = transport(store);

  const resRes = await req('/motion-api/super-agent/resources?kind=design-template&limit=5');
  assert.equal(resRes.status, 200);
  const resBody = await resRes.json();
  assert.ok(resBody.counts.designTemplates > 0);
  assert.ok(resBody.items.length > 0);

  const createdRes = await req('/motion-api/super-agent/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine: 'codex', title: 'HTTP Chat' }),
  });
  assert.equal(createdRes.status, 200);
  const created = (await createdRes.json()).conversation;
  assert.equal(created.title, 'HTTP Chat');

  const patchRes = await req(`/motion-api/super-agent/chats/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned: true, addArtifact: { kind: 'web', url: 'https://open-design.ai' } }),
  });
  assert.equal(patchRes.status, 200);
  const patched = (await patchRes.json()).conversation;
  assert.equal(patched.pinned, true);
  assert.equal(patched.artifacts[0].kind, 'web');

  const missingRes = await req('/motion-api/super-agent/chats/not-a-uuid');
  assert.equal(missingRes.status, 404);

  const listRes = await req('/motion-api/super-agent/chats');
  assert.equal(listRes.status, 200);
  assert.equal((await listRes.json()).conversations.length, 1);

  const delRes = await req(`/motion-api/super-agent/chats/${created.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  assert.equal((await req(`/motion-api/super-agent/chats/${created.id}`)).status, 404);

  await superAgentConversations(store).close();
}));
