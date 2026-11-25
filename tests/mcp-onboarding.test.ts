import { projectFileExample, projectFileInstruction } from '../shared/project-file-guide.ts';
import { clipMoveExample, projectEditExample } from '../shared/clip-move-guide.ts';
import { reviewCommentsPrompt } from '../shared/review-comments.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mcpCapabilities, mcpScenarios, platformExportExample, mcpBenefits, mcpReviewGuide, mcpFaq, mcpClientComparison } from '../studio/src/motion/mcpCapabilities.ts';
import { assetNamingInstruction } from '../shared/asset-names.ts';
import { phase1Tools, validateInput } from '../shared/phase1-tools.ts';
import {
  agentGuide,
  buildCloudIntegrationInfo,
  integrationConfig,
  isIntegrationInfo,
  isStreamableHttpTransport,
  manualConnection,
  setupPrompt,
  supportsChatgptCloud,
  type IntegrationInfo,
} from '../shared/integration.ts';
import { imageFeaturePrompt } from '../shared/image-features.ts';
import { videoFeatureParameters, videoFeaturePrompt } from '../shared/video-features.ts';
import { findScenario, scenarioAgentPrompt, scenarioRecipeTools } from '../shared/scenarios.ts';

test('MCP onboarding covers every public domain tool (22 registered) and scenarios only compose real tools', () => {
  const described = mcpCapabilities.flatMap(capability => [...capability.tools]);
  assert.equal(phase1Tools.length, 22);
  assert.deepEqual([...new Set(described)].sort(), phase1Tools.map(tool => tool.name).sort());
  for (const capability of mcpCapabilities) assert.equal(new Set(capability.tools).size, capability.tools.length);
});

test('Streamable HTTP /mcp integration info validates and configures all clients including ChatGPT Cloud', () => {
  const localHttp = buildCloudIntegrationInfo({
    publicOrigin: 'http://127.0.0.1:4173',
    version: '1.0.0',
    workspaceId: 'ws-dev',
    authMode: 'dev',
    tools: phase1Tools,
  });
  assert.equal(isIntegrationInfo(localHttp), true);
  assert.equal(isStreamableHttpTransport(localHttp.transport), true);
  assert.equal(localHttp.transport.type === 'streamable-http' && localHttp.transport.url, 'http://127.0.0.1:4173/mcp');
  assert.equal(supportsChatgptCloud(localHttp), false);
  assert.throws(() => integrationConfig(localHttp, 'chatgpt'), /HTTPS/);
  assert.match(manualConnection(localHttp, 'codex', 'en'), /codex mcp add openmotion-local --url 'http:\/\/127\.0\.0\.1:4173\/mcp'/);
  assert.match(manualConnection(localHttp, 'claude', 'en'), /claude mcp add --scope user --transport http openmotion-local 'http:\/\/127\.0\.0\.1:4173\/mcp'/);
  assert.match(integrationConfig(localHttp, 'mcp').text, /"openmotion-local"/);
  assert.match(integrationConfig(localHttp, 'mcp').text, /"type": "http"/);
  assert.match(integrationConfig(localHttp, 'deepseek').text, /transport: streamable-http/);
  assert.doesNotMatch(setupPrompt(localHttp, 'codex', 'en'), /docker exec -i/);
  assert.match(setupPrompt(localHttp, 'codex', 'en'), /upload_ticket/);

  const testCloud = buildCloudIntegrationInfo({
    publicOrigin: 'https://openmotion.powerformer.net',
    version: '1.0.0',
    workspaceId: 'ws-test',
    authMode: 'oidc',
    oauth2Enabled: true,
    patEnabled: true,
    tools: phase1Tools,
  });
  assert.match(manualConnection(testCloud, 'codex', 'en'), /codex mcp add openmotion-test --url 'https:\/\/openmotion\.powerformer\.net\/mcp'/);
  assert.match(manualConnection(testCloud, 'codex', 'en'), /codex mcp login openmotion-test/);
  assert.match(manualConnection(testCloud, 'claude', 'en'), /claude mcp add --scope user --transport http openmotion-test 'https:\/\/openmotion\.powerformer\.net\/mcp'/);
  assert.match(manualConnection(testCloud, 'claude', 'en'), /\/mcp/);

  const cloudHttps = buildCloudIntegrationInfo({
    publicOrigin: 'https://motion.open-design.ai',
    version: '1.0.0',
    workspaceId: 'ws-prod',
    authMode: 'oidc',
    oauth2Enabled: true,
    patEnabled: true,
    tools: phase1Tools,
  });
  assert.equal(isIntegrationInfo(cloudHttps), true);
  assert.equal(supportsChatgptCloud(cloudHttps), true);
  const chatgptCfg = integrationConfig(cloudHttps, 'chatgpt');
  assert.equal(chatgptCfg.filename, 'openmotion-chatgpt.json');
  assert.match(chatgptCfg.text, /"authentication": "oauth2"/);
  assert.match(chatgptCfg.text, /https:\/\/motion\.open-design\.ai\/mcp/);
  assert.match(manualConnection(cloudHttps, 'chatgpt', 'en'), /OAuth 2\.1/);
  assert.match(manualConnection(cloudHttps, 'codex', 'en'), /codex mcp login openmotion/);
  assert.match(setupPrompt(cloudHttps, 'codex', 'zh-CN'), /settings\/account#tokens/);
  assert.match(agentGuide(cloudHttps, 'mcp'), /settings\/mcp/);
  assert.match(agentGuide(cloudHttps, 'mcp'), /settings\/account\?preset=readonly#tokens/);
});

test('cloud clip move example uses the public edit contract in the handbook and guide', () => {
  const card = mcpCapabilities.find(item => item.id === 'clip-move')!;
  const locales = JSON.parse(readFileSync(new URL('../studio/src/i18n/mcp-ui.json', import.meta.url), 'utf8'));
  for (const strings of Object.values(locales) as Record<string, string>[]) {
    for (const key of [card.title, card.description, card.prompt]) assert.ok(strings[key]);
  }
  const guide = agentGuide(buildCloudIntegrationInfo({
    publicOrigin: 'https://motion.example.com', version: '1', workspaceId: 'w', authMode: 'dev', tools: phase1Tools,
  }), 'codex');
  for (const text of [card.prompt, card.description, clipMoveExample]) assert.ok(guide.includes(text));
  const args = JSON.parse(clipMoveExample.slice('openmotion_edit_project('.length, -1));
  assert.deepEqual(Object.keys(args).sort(), ['edit', 'expectedRevision', 'expectedVersionId', 'projectId', 'requestId']);
  assert.deepEqual(args.edit, { kind: 'moveClip', compositionPath: 'index.html', hfId: '<data-hf-id>', start: 5 });
  const reference = readFileSync(new URL('../docs/mcp-phase1-tools.md', import.meta.url), 'utf8');
  assert.ok(reference.includes(clipMoveExample));
});

test('the single-file handbook example covers pinned pages, syncing and download renewal', () => {
  const card = mcpCapabilities.find(item => item.id === 'project-file')!;
  assert.deepEqual(card.tools, ['openmotion_get_project']);
  assert.equal(card.prompt, projectFileInstruction);
  const info = buildCloudIntegrationInfo({ publicOrigin: 'https://motion.example.com', version: '1', workspaceId: 'w', authMode: 'dev', tools: phase1Tools });
  const guide = agentGuide(info, 'codex');
  const reference = readFileSync(new URL('../docs/mcp-phase1-tools.md', import.meta.url), 'utf8');
  assert.ok(guide.includes(card.prompt) && guide.includes(projectFileExample()) && reference.includes(projectFileExample()));
  const schema = phase1Tools.find(tool => tool.name === 'openmotion_get_project')!.inputSchema;
  const files = projectFileExample('project').split('\n').map(call => {
    const args = JSON.parse(call.slice('openmotion_get_project('.length, -1));
    validateInput(schema, args);
    assert.equal(args.projectId, 'project');
    return args.file;
  });
  assert.deepEqual(files.map(file => file.mode), ['read', 'read', 'sync', 'download']);
  assert.equal(files[1].offset, files[0].length);
  assert.equal(files[1].atFileVersion, '<first page fileVersion>');
  assert.equal(files[2].fromFileVersion, '<local fileVersion>');
  assert.equal(files[3].atFileVersion, '<target fileVersion>');
  assert.match(card.prompt, /baseline.*before applying the patches in order/);
  assert.match(card.prompt, /link expires.*same atFileVersion/);
  const translations = JSON.parse(readFileSync(new URL('../studio/src/i18n/mcp-ui.json', import.meta.url), 'utf8'));
  for (const values of Object.values(translations) as Record<string, string>[]) {
    for (const key of [card.title, card.description, card.prompt]) assert.ok(values[key]?.trim() && values[key] !== key);
  }
});

test('the documented element edit works alone or inside one atomic batch', () => {
  const guide = agentGuide(buildCloudIntegrationInfo({
    publicOrigin: 'https://motion.example.com', version: '1', workspaceId: 'w', authMode: 'dev', tools: phase1Tools,
  }), 'codex');
  assert.ok(guide.includes(projectEditExample));
  const args = { ...JSON.parse(projectEditExample.slice('openmotion_edit_project('.length, -1)),
    projectId: 'project', expectedRevision: 'a'.repeat(64) };
  const schema = phase1Tools.find(tool => tool.name === 'openmotion_edit_project')!.inputSchema;
  validateInput(schema, args);
  const batch = (commands: unknown[]) => ({ ...args, edit: { kind: 'batch', commands } });
  validateInput(schema, batch([args.edit, { ...args.edit, compositionPath: 'compositions/title.html' }]));
  assert.throws(() => validateInput(schema, batch([{ ...args.edit, patches: [] }])));
  assert.throws(() => validateInput(schema, batch([batch([args.edit]).edit])));
});

test('every capability and benefit has a real shared icon', () => {
  const sprite = readFileSync(new URL('../packages/design-system/icons.svg', import.meta.url), 'utf8');
  for (const { icon } of [...mcpCapabilities, ...mcpScenarios, ...mcpBenefits]) assert.ok(sprite.includes(`id="ri-${icon}"`), icon);
});

test('review comments and their handbook scenario are localized across all interface languages', () => {
  const translations = JSON.parse(readFileSync(new URL('../studio/src/i18n/review-ui.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(translations).length, 10);
  const keys = Object.keys(translations['zh-CN']).sort();
  const scenario = mcpScenarios.find(item => item.id === 'review-comments')!;
  for (const [language, values] of Object.entries(translations) as [string, Record<string, string>][]) {
    assert.deepEqual(Object.keys(values).sort(), keys, language);
    for (const key of [scenario.title, scenario.description, 'Review data and Agent actions', ...mcpReviewGuide.flat(), ...keys]) assert.ok(values[key]?.trim(), `${language}: ${key}`);
    assert.equal(values.Open, undefined, 'Review status must not override the general Open action');
  }
});

test('handbook scenarios compose public tools and keep their copyable instructions aligned', () => {
  const names = new Set(phase1Tools.map(tool => tool.name));
  for (const scenario of mcpScenarios) {
    assert.ok(scenario.title && scenario.description);
    if (scenario.id === 'review-comments') assert.equal(scenario.prompt, reviewCommentsPrompt());
    if (scenario.id === 'asset-naming') assert.equal(scenario.prompt, assetNamingInstruction);
    for (const tool of scenario.tools) {
      assert.ok(names.has(tool), tool);
      assert.ok((scenario.id === 'platform-export' ? platformExportExample('en') : scenario.prompt).includes(tool), tool);
    }
  }
});

test('guide-draft handoff is discoverable and translated with its actual recovery boundaries', () => {
  const scenario = mcpScenarios.find(item => item.id === 'template-guide')!;
  assert.match(scenario.prompt, /guideDraft.*stable requestId/);
  assert.match(scenario.prompt, /applied=false.*new requestId.*unknown outcomes/);
  assert.match(scenario.prompt, /not a reconstruction of the reference film/);
  const translations = JSON.parse(readFileSync(new URL('../studio/src/i18n/mcp-ui.json', import.meta.url), 'utf8'));
  for (const [locale, values] of Object.entries(translations) as [string, Record<string, string>][]) {
    for (const text of [scenario.title, scenario.description, scenario.prompt]) assert.ok(values[text]?.trim(), locale + ': ' + text);
  }
  const shared = readFileSync(new URL('../shared/integration.ts', import.meta.url), 'utf8');
  assert.match(shared, /\$\{templateGuideContinuationInstruction\}/);
  const templateSkill = readFileSync(new URL('../skills/openmotion-template-to-video/SKILL.md', import.meta.url), 'utf8');
  const reference = readFileSync(new URL('../skills/openmotion-production/references/templates.md', import.meta.url), 'utf8');
  assert.match(templateSkill, /guideDraft.*narrow exception/);
  assert.match(reference, /guideDraft.*projectType|projectType.*guideDraft/s);
  assert.match(reference, /applied=false.*unknown outcomes/s);
});

test('reference-image and audio guidance is translated in every interface language', () => {
  const translations = JSON.parse(readFileSync(new URL('../studio/src/i18n/mcp-ui.json', import.meta.url), 'utf8'));
  for (const locale of Object.values(translations) as Record<string, string>[]) {
    for (const [question, answer] of mcpFaq.slice(0, 2)) { assert.ok(locale[question]); assert.ok(locale[answer]); }
  }
  const refAnswer = mcpFaq.find(([question]) => question === 'Can I generate from a reference image?')![1];
  assert.match(refAnswer, /OpenDesign Cloud and account video models with first-frame support can animate one image/);
  assert.match(refAnswer, /2 MiB/);
  const mediaTool = phase1Tools.find(tool => tool.name === 'openmotion_media_use')!;
  assert.match(mediaTool.description, /2 MiB for OpenDesign account\/Cloud.*20 MB/);
  assert.match((mediaTool.inputSchema.properties as Record<string, { description: string }>).referenceAsset.description, /2 MiB for OpenDesign account\/Cloud.*20 MB/);
});

test('cloud Streamable HTTP and legacy connection guidance expose the maintained media workflow and 3-way cloud import', () => {
  const cloudInfo = buildCloudIntegrationInfo({
    publicOrigin: 'https://motion.open-design.ai',
    version: '1.0.0',
    workspaceId: 'ws-1',
    authMode: 'oidc',
    tools: phase1Tools,
  });
  const cloudGuide = agentGuide(cloudInfo, 'codex');
  assert.ok(cloudGuide.includes(reviewCommentsPrompt({ dataDirectory: cloudInfo.dataDirectory, previewUrl: cloudInfo.previewUrl })));
  for (const token of [
    'https://motion.open-design.ai/mcp',
    'prepare_upload',
    'upload_ticket',
    'library_asset',
    'OpenDesign Model Gateway',
    'openmotion_media_use',
    'openmotion_assets_use generate',
    'FEATURE_DEFERRED_P2',
    'action=scenario',
    '/motion-api/games/*',
  ]) {
    assert.ok(cloudGuide.includes(token), token);
  }
  assert.doesNotMatch(cloudGuide, /openmotion_game_create|action=batch|action=trigger/);

  const stdioInfo: IntegrationInfo = {
    name: 'OpenMotion', version: '1.0.0', dataDirectory: '/fixture/data', previewUrl: 'http://127.0.0.1:4567', tools: phase1Tools,
    transport: { type: 'stdio', command: 'node', args: ['/fixture/mcp.ts'], cwd: '/fixture', env: { MOTION_DATA_DIR: '/fixture/data' } },
  };
  const guide = agentGuide(stdioInfo, 'codex');
  assert.ok(guide.includes(reviewCommentsPrompt({ dataDirectory: stdioInfo.dataDirectory, previewUrl: stdioInfo.previewUrl })));
  for (const operation of ['openmotion_media_use', 'inspect', 'reference', 'models', 'schema', 'generate', 'status', 'cancel', 'requestId', 'jobId']) assert.ok(guide.includes(operation), operation);
  assert.doesNotMatch(guide, /不公开生成/);
  assert.doesNotMatch(guide, /openmotion_game_create|action=batch|action=trigger/);
  assert.match(guide, /openmotion_assets_use generate/);
  for (const scenarioToken of ['action=scenario', 'add_pool', 'recordIteration=true', 'link_design', 'link_motion']) {
    assert.ok(guide.includes(scenarioToken), scenarioToken);
  }
});

test('media example uses unified OpenDesign Model Gateway and preserves setup continuation across languages', async () => {
  const media = mcpCapabilities.find(capability => capability.id === 'media')!;
  const assets = mcpCapabilities.find(capability => capability.id === 'assets')!;
  const translations = JSON.parse(readFileSync(new URL('../studio/src/i18n/mcp-ui.json', import.meta.url), 'utf8'));
  assert.match(media.prompt, /inspect/);
  assert.match(media.prompt, /Plus or above/);
  assert.match(media.prompt, /mediaEntitlement/);
  assert.match(media.prompt, /OpenDesign Cloud/);
  assert.match(media.prompt, /OpenDesign Model Gateway/);
  assert.doesNotMatch(media.prompt, /BYOK API key/);
  assert.match(media.prompt, /target=providers/);
  assert.match(media.prompt, /inspect again/);
  assert.match(media.prompt, /original request/);
  assert.match(assets.description, /prepare_upload \+ upload_ticket.*HTTPS URL.*library_asset/);
  assert.ok(translations['zh-CN'][media.prompt]);
  assert.ok(translations['zh-CN'][assets.description]);
  const skill = readFileSync(new URL('../skills/openmotion-media/SKILL.md', import.meta.url), 'utf8');
  const setupLink = skill.match(/\[Discovery and setup\]\(([^)]+)\)/);
  assert.ok(setupLink, 'Media entry must expose provider setup');
  const setup = readFileSync(new URL(setupLink[1], new URL('../skills/openmotion-media/SKILL.md', import.meta.url)), 'utf8');
  assert.match(setup, /target: "providers"/);
  assert.match(setup, /## Media handbook handoff/);
  assert.match(setup, /settingsHandoff.*openmotion_open_preview.*target: "providers".*page handoff/);
  assert.match(setup, /signed-in account.*available: true.*unknown/);
  assert.match(setup, /not-included.*agent_media_upgrade_go.*agent_media_upgrade_free.*Upgrade to Plus.*directly/);
  assert.match(setup, /MCP handbook media-generation example/);
  assert.match(setup, /read-only `inspect`/);
  assert.match(skill, /MCP handbook example \| \[Discovery and setup\]/);
});

test('asset naming scenario is localized in all eleven interface languages', () => {
  const translations = JSON.parse(readFileSync(new URL('../studio/src/i18n/mcp-ui.json', import.meta.url), 'utf8'));
  const scenario = mcpScenarios.find(item => item.id === 'asset-naming')!;
  for (const locale of Object.values(translations) as Record<string, string>[]) {
    for (const message of [scenario.title, scenario.description, scenario.prompt]) assert.ok(locale[message], message);
  }
});

test('Streamable HTTP client comparison and final-video recovery are localized across all interface languages', () => {
  const answer = mcpFaq.find(([question]) => question === 'What if the final video cannot load?')![1];
  const matrix = mcpClientComparison.find(([capability]) => capability === 'Inline template cards and final video')!;
  const connectionRow = mcpClientComparison.find(([capability]) => capability === 'Connection')!;
  const translations = JSON.parse(readFileSync(new URL('../studio/src/i18n/mcp-ui.json', import.meta.url), 'utf8'));
  assert.match(connectionRow[1], /Streamable HTTP \(\/mcp\)/);
  assert.match(connectionRow[3], /HTTPS \+ OAuth 2\.1/);
  assert.match(answer, /Codex normally shows it in the final reply/);
  assert.match(answer, /never both for the same video/);
  assert.match(answer, /without rendering again/);
  for (const [language, values] of Object.entries(translations) as [string, Record<string, string>][]) {
    for (const key of [answer, matrix[1], matrix[2], connectionRow[3]]) {
      assert.ok(values[key]?.trim(), `${language}: missing localized guidance for "${key}"`);
      assert.notEqual(values[key], key, `${language}: English fallback for "${key}"`);
    }
  }
});

test('canvas and caption controls expose atomic operations and an actionable handbook example', () => {
  const capability = mcpCapabilities.find(item => item.id === 'canvas-captions')!;
  assert.match(capability.prompt, /openmotion_edit_project.*canvas=/);
  assert.match(capability.prompt, /caption_toggle/);
  assert.match(capability.prompt, /stable requestId/);
  assert.match(capability.description, /Locked tracks.*Conflicts.*without automatic subject detection/);
  const schema = phase1Tools.find(tool => tool.name === 'openmotion_edit_project')!.inputSchema;
  assert.ok(schema.properties.canvas); assert.ok(!schema.required.includes('files'));
  const translations = JSON.parse(readFileSync(new URL('../studio/src/i18n/canvas-ui.json', import.meta.url), 'utf8'));
  for (const [language, values] of Object.entries(translations) as [string, Record<string, string>][]) {
    for (const key of [capability.title, capability.description, capability.prompt]) assert.ok(values[key]?.trim() && values[key] !== key, `${language}: missing canvas guidance`);
  }
});

test('fullscreen guidance distinguishes browser presentation from an Agent project operation', () => {
  const capability = mcpCapabilities.find(item => item.id === 'fullscreen')!;
  assert.deepEqual(capability.tools, ['openmotion_open_preview']);
  assert.match(capability.description, /Embedded hosts may block/); assert.match(capability.prompt, /do not render or edit/);
  const translations = JSON.parse(readFileSync(new URL('../studio/src/i18n/fullscreen-ui.json', import.meta.url), 'utf8'));
  for (const [language, values] of Object.entries(translations) as [string, Record<string, string>][]) {
    for (const key of [capability.title, capability.description, capability.prompt]) assert.ok(values[key]?.trim() && values[key] !== key, `${language}: missing fullscreen guidance`);
  }
});

test('timeline hover inspection remains a localized, non-mutating preview scenario', () => {
  const capability = mcpCapabilities.find(item => item.id === 'timeline-hover')!;
  assert.deepEqual(capability.tools, ['openmotion_open_preview']);
  assert.match(capability.description, /Pause playback.*Click the ruler.*if loading fails/);
  assert.match(capability.prompt, /Preserve the source and selection; do not export or generate media/);
  const translations = JSON.parse(readFileSync(new URL('../studio/src/i18n/timeline-hover-ui.json', import.meta.url), 'utf8'));
  for (const [language, values] of Object.entries(translations) as [string, Record<string, string>][]) {
    for (const key of [capability.title, capability.description, capability.prompt]) assert.ok(values[key]?.trim() && values[key] !== key, `${language}: missing hover guidance`);
  }
});

test('image feature handbook scenarios cover background removal, relight and character consistency with limits and recovery', () => {
  const translations = JSON.parse(readFileSync(new URL('../studio/src/i18n/mcp-ui.json', import.meta.url), 'utf8'));
  const removeBg = mcpScenarios.find(item => item.id === 'image-remove-background')!;
  const relight = mcpScenarios.find(item => item.id === 'image-relight')!;
  const character = mcpScenarios.find(item => item.id === 'image-character')!;
  assert.ok(removeBg.prompt.includes(imageFeaturePrompt('remove-background', '')));
  assert.match(removeBg.prompt, /"background":"transparent"/);
  assert.match(removeBg.prompt, /gpt-image-2\.6-sunburst/);
  assert.ok(relight.prompt.includes(imageFeaturePrompt('relight', 'Keep the logo sharp.', { direction: 'left', temperature: 'warm', mood: 'golden-hour' })));
  assert.match(relight.prompt, /seedream-5\.5/);
  assert.ok(character.prompt.includes(imageFeaturePrompt('character', 'Show the character walking through a sunlit café.')));
  assert.match(character.prompt, /drop seedream-5\.5 when using 2 or more references/);
  for (const scenario of [removeBg, relight, character]) {
    assert.match(scenario.prompt, /target=providers/);
    assert.match(scenario.prompt, /action=resume/);
    assert.match(scenario.prompt, /2 MiB/);
    for (const locale of Object.values(translations) as Record<string, string>[]) {
      assert.ok(locale[scenario.title]?.trim());
      assert.ok(locale[scenario.description]?.trim());
    }
  }
});

test('video feature handbook scenarios cover camera control and multi-shot with limits and recovery', () => {
  const translations = JSON.parse(readFileSync(new URL('../studio/src/i18n/mcp-ui.json', import.meta.url), 'utf8'));
  const camera = mcpScenarios.find(item => item.id === 'video-camera-control')!;
  const multiShot = mcpScenarios.find(item => item.id === 'video-multi-shot')!;
  assert.ok(camera.prompt.includes(videoFeaturePrompt('camera-control', 'A vintage camera on dark stone with warm rim lighting.', { movement: 'orbit', pace: 'slow' })));
  assert.ok(multiShot.prompt.includes(videoFeaturePrompt('multi-shot', 'An astronaut crossing a silver lunar ridge.', { shots: '3', style: 'narrative' })));
  assert.ok(multiShot.prompt.includes(JSON.stringify(videoFeatureParameters('multi-shot', { provider: 'opendesign', modelId: 'doubao-seedance-2-5-260628' }))));
  for (const scenario of [camera, multiShot]) {
    assert.match(scenario.prompt, /target=providers/);
    assert.match(scenario.prompt, /2 MiB/);
    assert.match(scenario.prompt, /omit fixed ratio/i);
    for (const locale of Object.values(translations) as Record<string, string>[]) {
      assert.ok(locale[scenario.title]?.trim());
      assert.ok(locale[scenario.description]?.trim());
    }
  }
});

test('Workflows capability, Black Friday recipe and design asset embedding stay aligned and localized', () => {
  const translations = JSON.parse(readFileSync(new URL('../studio/src/i18n/mcp-ui.json', import.meta.url), 'utf8'));
  const capability = mcpCapabilities.find(item => item.id === 'scenario-workflows')!;
  const blackFriday = mcpScenarios.find(item => item.id === 'scenario-black-friday')!;
  const writeback = mcpScenarios.find(item => item.id === 'scenario-agent-writeback')!;
  const embedAssets = mcpScenarios.find(item => item.id === 'design-embed-assets')!;
  const writebackFaq = mcpFaq.find(([question]) => question === 'How does my Agent run a workflow and save results to Assets?')!;

  assert.ok(capability);
  assert.equal(capability.title, 'Run a workflow end to end');
  assert.deepEqual([...capability.tools], ['openmotion_assets_use', 'openmotion_design_edit', 'openmotion_design_project']);
  assert.match(capability.prompt, /openmotion_get_skill/);
  assert.match(capability.prompt, /openmotion:\/\/workflow\/\*/);
  for (const tool of capability.tools) assert.ok(capability.prompt.includes(tool), tool);
  assert.equal(blackFriday.title, 'Run the Black Friday campaign workflow');
  assert.equal(blackFriday.prompt, scenarioAgentPrompt(findScenario('black-friday')!));
  assert.deepEqual([...blackFriday.tools], [...scenarioRecipeTools]);
  for (const tool of scenarioRecipeTools) assert.ok(blackFriday.prompt.includes(tool), tool);
  assert.ok(writeback);
  assert.equal(writeback.title, 'Run a workflow and save back to Assets');
  assert.deepEqual([...writeback.tools], [...scenarioRecipeTools]);
  assert.match(writeback.prompt, /recordIteration=true/);
  assert.match(writeback.prompt, /openmotion_get_skill/);
  for (const tool of scenarioRecipeTools) assert.ok(writeback.prompt.includes(tool), tool);
  assert.ok(writebackFaq);
  assert.match(writebackFaq[1], /Copy for Agent/);
  assert.match(writebackFaq[1], /Copy MCP prompt/);
  assert.match(writebackFaq[1], /openmotion_get_skill/);
  assert.match(writebackFaq[1], /action=scenario/);
  assert.match(writebackFaq[1], /recordIteration=true/);
  assert.match(writebackFaq[1], /Sync/);
  assert.deepEqual([...embedAssets.tools], ['openmotion_assets_use', 'openmotion_design_edit']);
  assert.ok(embedAssets.prompt.includes('openmotion_assets_use'));
  assert.ok(embedAssets.prompt.includes('openmotion_design_edit'));
  assert.ok(embedAssets.prompt.includes('import_asset'));

  for (const [locale, values] of Object.entries(translations) as [string, Record<string, string>][]) {
    for (const key of [
      capability.title, capability.description, capability.prompt,
      blackFriday.title, blackFriday.description,
      writeback.title, writeback.description, writeback.prompt,
      writebackFaq[0], writebackFaq[1],
      embedAssets.title, embedAssets.description, embedAssets.prompt,
    ]) {
      assert.ok(values[key]?.trim(), `${locale}: missing ${key}`);
      assert.notEqual(values[key], key, `${locale}: untranslated ${key}`);
    }
  }
});
