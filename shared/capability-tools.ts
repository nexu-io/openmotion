import { brandKitToolArguments } from './brand-kit-tool.ts';

const uuid = { type: 'string', pattern: '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' };
const requestId = { type: 'string', pattern: '^[\\w-]{1,100}$' };
const projectId = { type: 'string', pattern: '^(project|[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12})$' };
const capabilityId = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,80}$' };
const object = <T extends Record<string, unknown>>(properties: T, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const reference = object({ assetId: uuid, versionId: uuid }, ['assetId', 'versionId']);

export const capabilityDiscoverActions = ['list', 'describe', 'quote', 'providers', 'models'] as const;
export const capabilityRunActions = ['run'] as const;
export const jobManageActions = ['list', 'status', 'cancel', 'retry_save', 'resume'] as const;
export const assetManageActions = ['list', 'get', 'read', 'import', 'update', 'import_to_project', 'brand_kit'] as const;

export const capabilityDiscoverTool = {
  name: 'openmotion_capability_discover',
  title: 'OpenMotion · Capability Discover',
  description:
    'Discover the Unified Capability Center shared by Studio GUI and MCP. Call action=list for a compact menu of live atomic and generative capabilities (such as remove-background, relight, character, camera-control, multi-shot, native-audio, text-to-image, text-to-video, music, speech, asr-transcribe), provider availability, account mediaEntitlement and settingsHandoff; set includeComingSoon=true only when inspecting upcoming capabilities. Call action=describe with capabilityId to read its dynamic options schema, reference count limits, compatible configured models and cost/approval policy before running. Call action=quote with capabilityId (and optional options/parameters/model) to preview spend tier, estimated credits and approval requirements before submitting high-cost work. Call action=providers (with optional provider for its setup guide) or action=models to inspect raw BYOK/Cloud models when no dedicated capability applies. Prefer dedicated atomic capabilities over simulating edits with generic model prompts.',
  inputSchema: {
    ...object(
      {
        action: { enum: [...capabilityDiscoverActions] },
        capabilityId,
        modality: { enum: ['image', 'video', 'audio', '3d'] },
        includeComingSoon: { type: 'boolean' },
        provider: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,80}$' },
        model: { type: 'string', minLength: 1, maxLength: 300 },
        options: { type: 'object', additionalProperties: true },
        parameters: { type: 'object', additionalProperties: true },
        query: { type: 'string', maxLength: 200 },
        refresh: { type: 'boolean' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      ['action'],
    ),
    oneOf: Object.entries({
      list: [],
      describe: ['capabilityId'],
      quote: ['capabilityId'],
      providers: [],
      models: [],
    }).map(([action, required]) => ({
      type: 'object',
      properties: { action: { enum: [action] } },
      required,
      additionalProperties: true,
    })),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

export const capabilityRunTool = {
  name: 'openmotion_capability_run',
  title: 'OpenMotion · Capability Run',
  description:
    'Execute a registered capability from the Unified Capability Center (preferred: supply capabilityId such as remove-background, relight, character, camera-control, multi-shot, native-audio, text-to-image, image-edit, text-to-video, image-to-video, music, speech, or asr-transcribe) or run a configured model directly when no dedicated capability fits. Routes transparently to the active executor (OpenDesign Cloud/account model, BYOK model, dedicated small model, domain service or local script) while recording capabilityId, options, model and pinned asset version provenance in Workspace Assets. Requires a stable requestId; never resubmit a paid task with a new requestId on timeout—poll or recover through openmotion_job_manage.',
  inputSchema: object(
    {
      action: { enum: [...capabilityRunActions] },
      requestId,
      capabilityId,
      model: { type: 'string', minLength: 1, maxLength: 300 },
      modality: { enum: ['image', 'video', 'audio'] },
      mode: { enum: ['text-to-image', 'text-to-video', 'text-to-audio', 'text-to-speech'] },
      prompt: { type: 'string', minLength: 0, maxLength: 20000 },
      options: { type: 'object', additionalProperties: true, description: 'Structured capability control choices matching openmotion_capability_discover action=describe.' },
      parameters: { type: 'object', additionalProperties: true, description: 'Optional provider-native model parameters.' },
      name: { type: 'string', minLength: 1, maxLength: 200 },
      assetId: uuid,
      parentVersionId: uuid,
      references: { type: 'array', items: reference },
      conversationId: uuid,
      projectId,
      sourcePath: { type: 'string', minLength: 1, maxLength: 4096, description: 'Used by service/script capabilities such as asr-transcribe when transcribing a local or project media file.' },
      language: { type: 'string', minLength: 2, maxLength: 32 },
      dryRun: { type: 'boolean', description: 'When true, validates inputs and returns the resolved executor, model and spend quote without submitting a paid job.' },
    },
    [],
  ),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

export const jobManageTool = {
  name: 'openmotion_job_manage',
  title: 'OpenMotion · Job Manage',
  description:
    'Unified async job lifecycle manager across Workspace Assets and project media tasks. list returns recent jobs (optionally filtered by projectId or conversationId); status reads one jobId; cancel requests cancellation; retry_save saves retained local outputs (savePending=true) without another model call; resume rechecks an eligible interrupted Cloud task or account image download without another paid submission.',
  inputSchema: {
    ...object(
      {
        action: { enum: [...jobManageActions] },
        jobId: uuid,
        requestId,
        projectId,
        conversationId: uuid,
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      ['action'],
    ),
    oneOf: Object.entries({
      list: [],
      status: ['jobId'],
      cancel: ['jobId'],
      retry_save: ['jobId', 'requestId'],
      resume: ['jobId', 'requestId'],
    }).map(([action, required]) => ({
      type: 'object',
      properties: { action: { enum: [action] } },
      required,
      additionalProperties: true,
    })),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

export const assetManageTool = {
  name: 'openmotion_asset_manage',
  title: 'OpenMotion · Asset Manage',
  description:
    'Pure Workspace Asset, immutable version, capability provenance and Brand Kit manager, decoupled from generation and job polling. list/get inspect assets, versions, capabilityId/capabilityOptions and parent/reference provenance; read returns bounded image previews, video frames or 16 kHz audio clips for a pinned assetId+versionId; import copies a real local file (max 500 MB); update renames, trashes/restores or switches currentVersionId while retaining history; import_to_project copies a pinned version into a target project without altering its timeline; brand_kit manages style-only Brand Kits.',
  inputSchema: {
    ...object(
      {
        action: { enum: [...assetManageActions] },
        requestId,
        assetId: uuid,
        versionId: uuid,
        parentVersionId: uuid,
        projectId,
        name: { type: 'string', minLength: 1, maxLength: 200 },
        sourcePath: { type: 'string', minLength: 1, maxLength: 4096 },
        modality: { enum: ['image', 'video', 'audio'] },
        source: { enum: ['upload', 'generated'] },
        query: { type: 'string', maxLength: 200 },
        trash: { type: 'boolean' },
        sort: { enum: ['newest', 'oldest', 'name'] },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        timestamps: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'number', minimum: 0 } },
        start: { type: 'number', minimum: 0 },
        duration: { type: 'number', minimum: 0.1, maximum: 15 },
        changes: object({ name: { type: 'string', minLength: 1, maxLength: 200 }, trashed: { type: 'boolean' }, currentVersionId: uuid }),
        brandKit: brandKitToolArguments,
      },
      ['action'],
    ),
    oneOf: Object.entries({
      list: [],
      get: ['assetId'],
      read: ['assetId', 'versionId'],
      import: ['requestId', 'sourcePath'],
      update: ['assetId', 'changes'],
      import_to_project: ['projectId', 'requestId', 'assetId', 'versionId'],
      brand_kit: ['brandKit'],
    }).map(([action, required]) => ({
      type: 'object',
      properties: { action: { enum: [action] } },
      required,
      additionalProperties: true,
    })),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};

export const capabilityMetaTools = [
  capabilityDiscoverTool,
  capabilityRunTool,
  jobManageTool,
  assetManageTool,
];
