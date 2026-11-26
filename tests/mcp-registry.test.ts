import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { cloudMcpPostAuthorizationInstructions } from '../shared/integration.ts';
import { createToolRegistry } from '../shared/mcp-registry.ts';
import { phase1Tools } from '../shared/phase1-tools.ts';
import { workflowEntryGuide, packagedSkills } from '../shared/workflow.ts';
import { templateDiscoveryGuide, skillDiscoveryGuide } from '../shared/workflow-entry.js';
import { parseConfig } from '../src/infra/config.ts';
import {
  InMemoryMcpSessionStore,
  McpStreamableHttpHandler,
  McpToolDispatcher,
} from '../src/mcp/index.ts';
import type { AuthContext } from '../src/contracts/auth.ts';
import { PAT_SCOPES } from '../src/contracts/auth.ts';

const phase1 = JSON.parse(readFileSync(new URL('../shared/mcp-profiles.json', import.meta.url), 'utf8')).phase1;
const target: string[] = phase1.tools;

function makeTestMcp() {
  const config = parseConfig({
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/openmotion',
    REDIS_URL: 'redis://127.0.0.1:6379',
    AUTH_MODE: 'dev',
    MODEL_GATEWAY_MODE: 'mock',
  });
  const auth: AuthContext = {
    workspaceId: config.DEV_WORKSPACE_ID,
    userId: config.DEV_USER_ID,
    role: 'owner',
    scopes: [...PAT_SCOPES],
    authMode: 'dev',
    authMethod: 'dev_bypass',
  };
  const handler = new McpStreamableHttpHandler({
    config,
    dispatcher: new McpToolDispatcher(config, {}),
    sessionStore: new InMemoryMcpSessionStore(),
  });
  const post = async (body: unknown, sessionId?: string) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Host: '127.0.0.1:4173',
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const res = await handler.handle(
      new Request('http://127.0.0.1:4173/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
      auth,
    );
    return { status: res.status, sessionId: res.headers.get('mcp-session-id'), json: await res.json() as any };
  };
  return { post, config };
}

test('MCP-only discovery connects template recommendations to a project-free host presentation', async () => {
  const { post } = makeTestMcp();
  const initialized = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
  });
  assert.equal(initialized.status, 200);
  const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, initialized.sessionId ?? undefined);
  assert.equal(listed.status, 200);
  for (const guidance of [
    initialized.json.result.instructions,
    listed.json.result.tools.find((tool: any) => tool.name === 'openmotion_list_templates').description,
  ]) {
    assert.match(guidance, /browse, compare or recommend/);
    assert.match(guidance, /target=templates/);
    assert.match(guidance, /same turn/);
    assert.match(guidance, /text-only/);
    assert.match(guidance, /does not authorize project creation/);
  }
});

test('phase-one target is explicit, unique, and validated by createToolRegistry', () => {
  const registry = createToolRegistry(phase1Tools, 'phase1');
  assert.deepEqual(registry.tools.map((tool) => tool.name), target);
  const localArchive = registry.tools.find(tool => tool.name === 'openmotion_project_archive');
  assert.deepEqual(localArchive?.inputSchema.properties.action.enum, ['export', 'import']);
  assert.equal(localArchive?.inputSchema.properties.sourcePath.type, 'string');
  assert.throws(() => createToolRegistry(phase1Tools, 'unknown'), /Unknown MCP release profile/);
  assert.throws(() => createToolRegistry([...phase1Tools, phase1Tools[0]], 'phase1'), /Duplicate MCP implementation/);
});

test('one registry governs discovery and rejects hidden calls before domain handlers', async () => {
  const { post, config } = makeTestMcp();
  const initialized = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
  });
  const sid = initialized.sessionId ?? undefined;
  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid);
  assert.deepEqual(list.json.result.tools.map((tool: any) => tool.name), target);

  const call = await post(
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'openmotion_write_files',
        arguments: { files: [{ path: 'notes.md', content: 'must not persist' }] },
      },
    },
    sid,
  );
  assert.equal(call.json.result.isError, true);
  assert.match(call.json.result.content[0].text, /MCP_TOOL_NOT_EXPOSED/);
  assert.equal(
    initialized.json.result.instructions,
    workflowEntryGuide
      + ' '
      + templateDiscoveryGuide
      + ' '
      + skillDiscoveryGuide
      + ' '
      + phase1.instructions
      + `\n\nConnected cloud server origin: ${config.APP_PUBLIC_ORIGIN} (workspace: ${config.DEV_WORKSPACE_ID}, auth: dev).`
      + '\n\n' + cloudMcpPostAuthorizationInstructions(config.APP_PUBLIC_ORIGIN),
  );
  assert.ok(!initialized.json.result.instructions.includes('openmotion_get_workflow'));
});

test('a missing implementation cannot produce a partial public registry', () => {
  assert.throws(
    () => createToolRegistry(phase1Tools.filter((tool) => tool.name !== 'openmotion_create_project'), 'phase1'),
    /MCP_PROFILE_INCOMPLETE.*openmotion_create_project/,
  );
  assert.deepEqual(createToolRegistry(phase1Tools, 'phase1').tools.map((tool) => tool.name), target);
});

test('packaged Skills reference only publicly callable Tool names', () => {
  for (const skill of packagedSkills) {
    const root = new URL('../skills/' + skill + '/', import.meta.url);
    for (const filename of readdirSync(root, { recursive: true }) as string[]) {
      if (!filename.endsWith('.md')) continue;
      const document = readFileSync(new URL(filename, root), 'utf8');
      for (const match of document.matchAll(/\b(?:openmotion|motion|design)_[a-z_]+\b/g)) {
        assert.ok([...target, 'openmotion_show_video'].includes(match[0]), `${skill}/${filename} calls hidden ${match[0]}`);
      }
    }
  }
});
