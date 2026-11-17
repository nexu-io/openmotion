import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mcpCapabilities, mcpBenefits, mcpFaq } from '../studio/src/motion/mcpCapabilities.ts';
import { phase1Tools } from '../shared/phase1-tools.ts';
import { agentGuide, type IntegrationInfo } from '../shared/integration.ts';

test('MCP onboarding covers every public domain tool exactly once', () => {
  const described = mcpCapabilities.flatMap(capability => [...capability.tools]);
  assert.equal(new Set(described).size, described.length);
  assert.deepEqual([...described].sort(), phase1Tools.map(tool => tool.name).sort());
});

test('every capability and benefit has a real shared icon', () => {
  const sprite = readFileSync(new URL('../packages/design-system/icons.svg', import.meta.url), 'utf8');
  for (const { icon } of [...mcpCapabilities, ...mcpBenefits]) assert.ok(sprite.includes(`id="ri-${icon}"`), icon);
});

test('reference-image and audio guidance is translated in every interface language', () => {
  const translations = JSON.parse(readFileSync(new URL('../studio/src/i18n/mcp-ui.json', import.meta.url), 'utf8'));
  for (const locale of Object.values(translations) as Record<string, string>[]) {
    for (const [question, answer] of mcpFaq.slice(0, 2)) { assert.ok(locale[question]); assert.ok(locale[answer]); }
  }
});

test('connection guidance exposes the maintained media workflow without asking for credentials', () => {
  const info: IntegrationInfo = { name: 'OpenMotion', version: '1.0.0', dataDirectory: '/fixture/data', previewUrl: 'http://127.0.0.1:4567', tools: phase1Tools,
    transport: { type: 'stdio', command: 'node', args: ['/fixture/mcp.ts'], cwd: '/fixture', env: { MOTION_DATA_DIR: '/fixture/data' } } };
  const guide = agentGuide(info, 'codex');
  for (const operation of ['openmotion_media_use', 'inspect', 'reference', 'models', 'schema', 'generate', 'status', 'cancel', 'requestId', 'jobId']) assert.ok(guide.includes(operation), operation);
  assert.doesNotMatch(guide, /不公开生成/);
  assert.match(guide, /Keep credentials in Settings/);
  assert.match(guide, /openmotion_assets_use generate/);
});

test('media example preserves setup and task continuation across supported languages', async () => {
  const media = mcpCapabilities.find(capability => capability.id === 'media')!;
  const translations = JSON.parse(readFileSync(new URL('../studio/src/i18n/mcp-ui.json', import.meta.url), 'utf8'));
  assert.match(media.prompt, /inspect/);
  assert.match(media.prompt, /target=providers/);
  assert.match(media.prompt, /once I have saved/);
  assert.match(media.prompt, /inspect again/);
  assert.match(media.prompt, /original request/);
  assert.ok(translations['zh-CN'][media.prompt]);
  const skill = readFileSync(new URL('../skills/openmotion-media/SKILL.md', import.meta.url), 'utf8');
  const setupLink = skill.match(/\[Discovery and setup\]\(([^)]+)\)/);
  assert.ok(setupLink, 'Media entry must expose provider setup');
  const setup = readFileSync(new URL(setupLink[1], new URL('../skills/openmotion-media/SKILL.md', import.meta.url)), 'utf8');
  assert.match(setup, /target: "providers"/);
  assert.match(setup, /## Media handbook handoff/);
  assert.match(setup, /MCP handbook media-generation example/);
  assert.match(setup, /read-only `inspect`/);
  assert.match(skill, /MCP handbook example \| \[Discovery and setup\]/);
});
