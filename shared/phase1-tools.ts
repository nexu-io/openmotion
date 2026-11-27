import { projectEditExample } from './clip-move-guide.ts';
import { preparedTextEditsSchema } from './prepared-text-edits-schema.ts';
import { editRequestSchema, editSchemaDefinitions } from '../packages/edit-core/schema.ts';
import { ToolInputError } from './tool-input-error.ts';
import { inlineVideoUri } from './inline-video.ts';
import { templateGuideDraftSchema } from './template-guide.ts';
import { publicToolName, legacyToolName } from './public-names.mjs';
import { templateDiscoveryGuide, skillDiscoveryGuide } from './workflow-entry.js';
import { cloudProjectArchiveTool, projectArchiveTool } from './project-archive.ts';
import { projectManagementTool } from './project-management.ts';
import { assetLibraryTool, workspaceAssetUseTool } from './asset-tools.ts';
import { designTools } from './design-tools.ts';
import { providerSetupEntries } from './workspace-url.ts';
import { canvasPresets } from './composition-canvas.ts';
import { MAX_ASSET_BYTES } from './asset-limits.ts';

// ---------------------------------------------------------------------------
// Cloud 3-Way `openmotion_import_assets` Contract Types
// ---------------------------------------------------------------------------

export type ImportAssetAction = 'prepare_upload' | 'import';

export interface PrepareUploadFileInput {
  itemId: string;
  filename: string;
  mimeType: string;
  bytes: number;
  sha256?: string;
  licenseFilename?: string;
  licenseBytes?: number;
}

export interface PrepareUploadInput {
  action: 'prepare_upload';
  projectId: string;
  requestId: string;
  files: PrepareUploadFileInput[];
}

export interface PrepareUploadTicketResult {
  itemId: string;
  ticketId: string;
  uploadUrl: string;
  method: 'PUT';
  headers: { 'Content-Type': string; 'Content-Length': string };
  expiresAt: string;
  licenseUpload?: {
    uploadUrl: string;
    method: 'PUT';
    headers: { 'Content-Type': 'text/plain; charset=utf-8'; 'Content-Length': string };
  };
}

export interface PrepareUploadResult {
  projectId: string;
  tickets: PrepareUploadTicketResult[];
  replayed?: boolean;
}

export type CloudImportSource =
  | {
      kind: 'upload_ticket';
      ticketId: string;
      expectedSha256?: string;
    }
  | {
      kind: 'url';
      url: string;
      expectedSha256?: string;
      licenseUrl?: string;
    }
  | {
      kind: 'library_asset';
      assetId: string;
      versionId: string;
    };

export interface CloudImportAssetItem {
  itemId: string;
  source: CloudImportSource;
  name?: string;
}

export interface ImportAssetsCloudInput {
  action?: 'import';
  projectId: string;
  requestId: string;
  items: CloudImportAssetItem[];
}

export const MAX_FONT_LICENSE_BYTES = 131_072;

// ---------------------------------------------------------------------------
// Phase-1 Tool Schema Definitions (22 Registered `openmotion_*` Domain Tools)
// ---------------------------------------------------------------------------

const providerEntry = { enum: [...providerSetupEntries], description: 'Optional entry reason when target=providers (for example agent_media_signed_out, agent_media_upgrade_free, agent_media_upgrade_go, agent_media_balance_low, agent_media_key_rejected, agent_media_handbook); defaults to agent_providers.' } as const;
const id = { type: 'string', minLength: 1, maxLength: 100 };
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' };
const projectId = { type: 'string', pattern: '^(project|[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12})$' };
const workId = { type: 'string', pattern: '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' };
const revision = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const text = { type: 'string', minLength: 1, maxLength: 8000 };
const presentation = { enum: ['foreground', 'background', 'now'], description: 'Default foreground shows the calling chat panel when active and queues only while inactive, without switching chats. Use now only for an explicit request to display immediately in this turn; background skips presentation.' };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const review = object({ objectId: id, versionId: id, range: object({ start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 } }, ['start', 'end']),
  conclusion: { enum: ['passed', 'failed', 'pending', 'unable_to_view'] }, evidence: text, source: { enum: ['agent', 'user'] } }, ['objectId', 'versionId', 'conclusion', 'evidence', 'source']);
const display = object({ revision, versionId: id, previewUrl: { type: 'string', minLength: 1, maxLength: 4000 },
  visibility: { enum: ['visible', 'queued', 'hidden', 'unavailable'], description: 'Observed native panel visibility. Use queued only when the host confirms the calling chat is inactive; a queued acknowledgment alone is insufficient. Otherwise use hidden or unavailable and report the display failure.' }, hostStatus: { type: 'string', minLength: 1, maxLength: 80, description: 'Host action acknowledgment, such as queued; independent of observed panel visibility.' }, hostTabId: { ...id, description: 'Actual native host Tab ID, such as providerTabId; never the CUA wrapper id. A reuse hint, not proof of current visibility.' }, contentVerified: { type: 'boolean' }, evidence: text },
  ['revision', 'versionId', 'previewUrl', 'visibility', 'contentVerified', 'evidence']);
const read = { readOnlyHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const cloudImportSourceSchema = {
  oneOf: [
    object(
      {
        kind: { enum: ['upload_ticket'] },
        ticketId: uuid,
        expectedSha256: revision,
      },
      ['kind', 'ticketId'],
    ),
    object(
      {
        kind: { enum: ['url'] },
        url: { type: 'string', minLength: 8, maxLength: 2048 },
        expectedSha256: revision,
        licenseUrl: { type: 'string', minLength: 8, maxLength: 2048 },
      },
      ['kind', 'url'],
    ),
    object(
      {
        kind: { enum: ['library_asset'] },
        assetId: uuid,
        versionId: uuid,
      },
      ['kind', 'assetId', 'versionId'],
    ),
  ],
};

export const phase1Tools = [
  workspaceAssetUseTool,
  assetLibraryTool,
  projectArchiveTool,
  projectManagementTool,
  { name: 'openmotion_media_use', title: 'OpenMotion · Media Use', description: 'Discover unified OpenDesign platform media models with inspect (returns advisory mediaEntitlement, normalized plan and hasBalance, never raw balances or secrets), read the OpenDesign provider guide with reference, then query models and schemas. The preferred route for NEW generation is openmotion_assets_use: supply the full model ID, generate into workspace Assets, poll the original jobId, inspect a pinned assetId/versionId, and import_to_project only when adopting a result. Existing project-direct generation is retained as a COMPATIBILITY route: generate still requires explicit projectId, stable requestId, provider, provider-native model, modality and prompt; it returns queued, not media. Optional referenceAsset uses a project-relative image with a model that supports editing; it snapshots one PNG/JPEG/WebP under 2 MiB for OpenDesign account/Cloud (or under 20 MB for other adapters). Audio follows the selected model: speech uses text-to-speech, music and sound effects use text-to-audio; read its native input schema. Old jobs keep this Tool and their original projectId/jobId for status, cancel, retry_save or resume; do not regenerate them through another Tool. Use retry_save with the original jobId and a stable requestId when savePending is true to retrieve existing results without another generation. Use resume with the original jobId and a stable requestId to check a failed/interrupted Cloud task with a known remoteId, without uploading inputs or submitting another paid generation. Cancelled jobs and confirmed remote failures cannot resume. No automatic paid fallback or resubmission.',
    inputSchema: object({ action: { enum: ['inspect', 'reference', 'models', 'generate', 'status', 'cancel', 'retry_save', 'resume'], description: 'inspect returns platform gateway setup state and reference URIs; reference returns the OpenDesign provider guide; models discovers capabilities; generate submits a job; status reads that original job; cancel requests cancellation; retry_save retries saving using the original jobId and a stable requestId; resume rechecks the original eligible failed Cloud task without another generation.' }, provider: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,80}$', description: 'Required for reference and generate (opendesign); optional provider filter for models.' },
      projectId, requestId: id, jobId: id, model: { type: 'string', minLength: 1, maxLength: 180 }, modality: { enum: ['image', 'video', 'audio'] },
      referenceAsset: { type: 'string', minLength: 1, maxLength: 1024, description: 'Optional project-relative PNG/JPEG/WebP under 2 MiB for OpenDesign account/Cloud, or under 20 MB for other adapters. Requires an image model with supportsImageReference.' },
      mode: { enum: ['text-to-image', 'text-to-video', 'text-to-audio', 'text-to-speech'] }, prompt: { type: 'string', minLength: 1, maxLength: 20000 },
      parameters: { type: 'object', additionalProperties: true }, refresh: { type: 'boolean' }, query: { type: 'string', maxLength: 200 },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['action']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: 'openmotion_list_templates', title: 'OpenMotion · List Templates', description: 'Index templates from the cloud template catalog. Returns source, template summaries or index metadata, total and catalogVersion. Select a template ID and call openmotion_get_template. Rows with shortForm=true are portrait works or original short video posts. No query or pagination arguments. ' + templateDiscoveryGuide, inputSchema: object({}), annotations: { ...read, openWorldHint: true } },
  { name: 'openmotion_get_template', title: 'OpenMotion · Get Template', description: 'Read one exact template ID and its TEMPLATE.md guidance. Library Skill IDs are rejected; read them with openmotion_get_skill. Built-in examples resolve from the ingested catalog without exposing host paths. Guidance-only examples remain distinct from editable Studio projects. Follow the returned workflowGuide: template means openmotion_create_project with projectType=template copies the editable project via zero-copy CAS; recreate means openmotion-recreate rebuilds from the guidance package and its linked reference video. An explicit guideDraft can instead create this entry’s declared title/accent motion example. Known IDs do not require listing first.', inputSchema: object({ templateId: id }, ['templateId']), annotations: { ...read, openWorldHint: true } },
  { name: 'openmotion_list_skills', title: 'OpenMotion · List Skills', description: 'Index every library video Skill (for example de-AI copy, growth teardown, long-to-short) to find a technique by scenario. Returns source, skill inventory, total and skillVersion. Read candidate IDs with openmotion_get_skill. No query or pagination arguments. ' + skillDiscoveryGuide, inputSchema: object({}), annotations: { ...read, openWorldHint: true } },
  { name: 'openmotion_get_skill', title: 'OpenMotion · Get Skill', description: 'Read one exact library Skill ID. Returns the complete SKILL.md in instructions and motionDocument.content plus a relative file inventory. Follow the instructions and create a natural_language project when needed; a Skill is not a template and cannot be applied or copied as one. Known IDs do not require listing first.', inputSchema: object({ skillId: id }, ['skillId']), annotations: { ...read, openWorldHint: true } },
  { name: 'openmotion_create_project', title: 'OpenMotion · Create Project', description: 'Create an independent editable native OpenMotion project from a prompt, an editable template ID or reference-video ID. The host Agent authors the film; creation does not generate a finished video. Persist requirements, namingLanguage and source, return project/session IDs and the initial content version. A requestId is required for safe retries.',
    inputSchema: object({ requestId: id, projectType: { enum: ['natural_language', 'template', 'reference_video'] }, title: { type: 'string', minLength: 1, maxLength: 100 }, requirements: text, namingLanguage: { type: 'string', minLength: 2, maxLength: 50, description: 'BCP 47 language for newly assigned asset names. Choose explicit user preference, otherwise initial brief language, otherwise interface language. Saved once; existing meaningful names remain unchanged.' },
      sessionId: projectId, templateId: id, guideDraft: { ...templateGuideDraftSchema, description: 'Optional title and accent for this catalog entry’s own authored motion-guide example. Creates that canvas example with native Variables, not a reconstruction of its reference film. Requires projectType=template and templateId.' }, referenceVideoId: id, referenceUrl: { type: 'string', maxLength: 2000 } }, ['requestId', 'projectType', 'title', 'requirements']), annotations: write },
  { name: 'openmotion_open_preview', title: 'OpenMotion · Open Preview', description: 'For video production, action=begin with explicit projectId, stable requestId and mode=create|modify creates a business work round silently before authoring. No production or editor action mounts an inline component. Open the editor only after the final authored video is ready for preview; after MP4 verification, prefer the host-native video preview (Codex: one final-reply embed). Use the separately discovered openmotion_show_video only if the host cannot preview the video; never combine both players for the same export. Once the requested video artifact exists, call action=complete_generation with workId, expectedRevision and expectedVersionId. This independently validates the completed artifact and records generation once, including background work, without saving, opening preview or rendering. Carry its workId through saves and the final export; begin does not open Studio or render. Explicit editor-only requests, unchanged template browsing and review flows do not begin a round. Prepare the named project in the shared editable Studio; this Tool does not open the host browser. Use target=templates for the template library or target=providers for model/account setup settings (Settings > Default models when Model providers is gated in Cloud Phase 1, or Settings > Model providers when enabled) without creating/selecting a project; target=templates accepts only action=open, embedded and presentation, while target=providers also accepts optional entry, and both return a page handoff without a project/version identity. Without projectId use only an explicitly bound OpenMotion session, never the global most-recent project. Follow previewHandoff to present the native panel and verify visibility plus latest content for first delivery and continued edits. Default foreground shows the active calling chat panel without switching chats; wait for return only when the host confirms that chat is inactive. A queued acknowledgment, hidden automation tab or markDeliverable does not complete delivery. Only an explicit show-now request uses presentation=now to permit switching for this turn. action=record_display records the current revision/version observation; queued or unverified content stays pending. Report a still-hidden panel as a display failure. action=record_review records evidence about a previously viewed frozen version without changing source.',
    inputSchema: object({ target: { enum: ['project', 'templates', 'providers'] }, action: { enum: ['open', 'record_review', 'record_display', 'begin', 'complete_generation'] }, mode: { enum: ['create', 'modify'] }, generation: { type: 'boolean', description: 'Begin defaults to a generation attempt. Set false only for export-only playback of already accepted content.' }, projectId, sessionId: projectId, workId, embedded: { type: 'boolean' }, presentation, entry: providerEntry, expectedRevision: revision, expectedVersionId: id, requestId: id, review, display }, []), annotations: write },
  { name: 'openmotion_import_assets', title: 'OpenMotion · Import Assets', description: 'Cloud 3-way asset import into a project (at most 500 MB / 500000000 bytes per file). Use action=prepare_upload with files[] to mint short-lived presigned S3 PUT upload tickets (plus optional companion font license upload URLs). Then call action=import (default when action is omitted) with items[] where each item specifies source.kind: (1) upload_ticket (ticketId from prepare_upload or /motion-api/uploads/tickets), (2) url (public HTTPS URL, SSRF-checked and fetched asynchronously by worker-media), or (3) library_asset (assetId + versionId from the workspace Asset Library, committed synchronously via zero-copy CAS refcount++). Legacy local host sourcePath values are unsupported in cloud deployments and rejected with LOCAL_PATH_UNSUPPORTED_IN_CLOUD. Successful items survive other failures. Existing history is not overwritten. Import does not place media on the timeline. Reuse the same requestId/itemId to retry safely without duplicate assets.',
    inputSchema: object({
      action: { enum: ['prepare_upload', 'import'], description: 'prepare_upload mints presigned staging PUT URLs; import (default) commits upload_ticket, url, or library_asset sources into the project.' },
      projectId,
      requestId: id,
      files: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        description: 'Required when action=prepare_upload. Declares each file to stage via presigned PUT.',
        items: object(
          {
            itemId: id,
            filename: { type: 'string', minLength: 1, maxLength: 256 },
            mimeType: { type: 'string', minLength: 1, maxLength: 128 },
            bytes: { type: 'integer', minimum: 1, maximum: MAX_ASSET_BYTES },
            sha256: revision,
            licenseFilename: { type: 'string', minLength: 1, maxLength: 256 },
            licenseBytes: { type: 'integer', minimum: 1, maximum: MAX_FONT_LICENSE_BYTES },
          },
          ['itemId', 'filename', 'mimeType', 'bytes'],
        ),
      },
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        description: 'Required when action=import (or action omitted). Each item references an upload_ticket, public HTTPS url, or workspace library_asset.',
        items: object(
          {
            itemId: id,
            source: cloudImportSourceSchema,
            name: { type: 'string', minLength: 1, maxLength: 200, description: 'Readable display name. Preserve meaningful source names; name generated or unnamed assets by content and optional purpose in the project namingLanguage. Never use UUIDs or the full generation prompt.' },
          },
          ['itemId', 'source'],
        ),
      },
    }, ['projectId', 'requestId']),
    annotations: write },
  { name: 'openmotion_get_project', title: 'OpenMotion · Get Project', description: 'Without projectId list projects in the current workspace, newest creation first, exactly five per page (except the last); use nextCursor. Set trashed=true to list projects in Trash instead. With projectId read that project, current revision/version, requirements, native file inventory, asset references and associated export state. inspect={compositionPath,offset?,limit?} lists editable elements with sourceFile, stable hfId, track, time and animation IDs without opening a browser. When available, localEditCli identifies this deployment’s Node CLI for preparing the same edits locally. file={path} reads only that file. Optional mode=read returns paged text (offset and length in UTF-16 units), download returns a short-lived URL for fixed text or binary bytes, and sync returns ordered patches from fromFileVersion or a downloadable baseline plus patches. Pass atFileVersion from the first read on later pages or when renewing a link. atProjectVersion selects a saved project manifest; exportJobId reads a historical task. With workId read one fixed work round; includeVideo=true returns its verified media privately to the component. This does not switch Studio or create projects.',
    inputSchema: object({ projectId, sessionId: projectId, trashed: { type: 'boolean' }, cursor: { type: 'string', maxLength: 2000 }, inspect: object({ compositionPath: { type: 'string', minLength: 1, maxLength: 240 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['compositionPath']), file: object({ path: { type: 'string', minLength: 1, maxLength: 240 }, mode: { enum: ['read', 'download', 'sync'] }, fromFileVersion: id, atFileVersion: id, atProjectVersion: uuid, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 2097152 } }, ['path']), expectedRevision: revision, exportJobId: id, workId, includeVideo: { type: 'boolean' } }, []), annotations: read },
  { name: 'openmotion_edit_project', title: 'OpenMotion · Edit Project',
    description: [
      'To change text or a style on an existing element, read its data-hf-id and the current project revision and version, then use this example.',
      projectEditExample,
      'Submit edit alone for one editing command or kind=batch with ordered commands across compositions. A batch creates one undo step. A CLI-capable host can instead submit textEdits alone using the release-matched localEditCli returned by openmotion_get_project. For moveClip choose an unlocked, unlinked timed clip within the current composition duration. Read its data-hf-id from the composition source. start is absolute in composition seconds. The clip and its supported GSAP tweens move together. Optional canvas changes a native composition to a preset ratio with contain (letterbox) or cover (center crop), without stretching. Existing authored content stays grouped at its original design size; subsequent ratio changes reuse it. Supply files and/or canvas with expectedRevision and expectedVersionId. Save the host Agent\'s native text-file batch, optional assetNames display metadata and namingLanguage into the explicitly named project. Check both expectedRevision and expectedVersionId, commit all files or none, protect GUI writes, record one complete content version and let Studio refresh. Production saves with workId defer editor presentation until the final video is ready. Every save returns a version-bound previewHandoff: preserve the current chat by default, queue when inactive and confirm the latest content on return. An accepted queued preview may be reported as saved and waiting for return. Only an explicit show-now request permits presentation=now for this turn; background skips presentation. The service does not generate code. Read project/version again after conflicts.',
    ].join('\n'),
    inputSchema: { $defs: editSchemaDefinitions, ...object({ edit: editRequestSchema, textEdits: preparedTextEditsSchema, canvas: object({ compositionPath: { type: 'string', minLength: 1, maxLength: 240 }, ratio: { enum: canvasPresets.map(item => item.ratio) }, fit: { enum: ['contain', 'cover'] } }, ['compositionPath', 'ratio', 'fit']), projectId, requestId: id, workId, expectedRevision: revision, expectedVersionId: id, presentation, requirements: text, summary: { type: 'string', maxLength: 300 },
      namingLanguage: { type: 'string', minLength: 2, maxLength: 50, description: 'Set a missing project naming language; change an existing value only on explicit user request. Does not translate existing names.' },
      assetNames: { type: 'array', maxItems: 100, items: object({ path: { type: 'string', minLength: 1, maxLength: 240 }, name: { type: 'string', minLength: 1, maxLength: 200 } }, ['path', 'name']), description: 'Metadata-only display names for existing media or fonts. Paths, IDs and composition references stay unchanged. Explicit renames or missing-name repairs only.' },
      files: { type: 'array', maxItems: 100, items: object({ path: { type: 'string', minLength: 1, maxLength: 240 }, content: { type: 'string' } }, ['path', 'content']) } }, ['projectId', 'requestId', 'expectedRevision', 'expectedVersionId']) }, annotations: write },
  { name: 'openmotion_export_request', title: 'OpenMotion · Export Request', description: 'Queue a background MP4 of the explicit project version and immutable source/media snapshot. Optional compositionPath exports an existing scene instead of index.html. Automatically lint and fully technically verify the result. Return jobId; read progress/results with openmotion_get_project exportJobId. On render failure, correlate exportJob.lintFindings with errorMessage and the failed source. Repair only confirmed causes via openmotion_edit_project against the latest revision/version, then retry the corrected version once with a new requestId and original export options. Report unresolved findings or missing assets. Export does not open the editor or complete an outstanding editable-preview handoff; follow openmotion_open_preview separately for creation/edit delivery. Repeated requestId returns the original task. action=record_review only records actual playback/visual/audio evidence for an existing job; it never starts another render.',
    inputSchema: object({ action: { enum: ['request', 'record_review'] }, projectId, requestId: id, workId, expectedRevision: revision, versionId: id, jobId: id,
      compositionPath: { type: 'string', minLength: 1, maxLength: 240, description: 'Optional existing HTML composition to export; defaults to index.html. Uses the same immutable project snapshot and native render engine.' }, audio: { enum: ['required', 'silent', 'optional'], description: 'Verify the encoded MP4 before download: required needs an AAC audio track, silent needs no audio tracks, and optional accepts either.' }, review }, ['projectId', 'requestId']), annotations: write },
  { name: 'openmotion_list_versions', title: 'OpenMotion · List Versions', description: 'List consistent project content snapshots, not individual file save counts. Return current-version identity and five snapshots per page with a cursor for older pages, including stable IDs, vN labels, source, summary and restorability. Five is a page size, not a retention limit.',
    inputSchema: object({ projectId, cursor: { type: 'string', maxLength: 2000 } }, ['projectId']), annotations: read },
  { name: 'openmotion_restore_version', title: 'OpenMotion · Restore Version', description: 'Restore the explicitly selected project snapshot as a NEW version. Restoring v3 while current is v5 produces v6 with v3 content; v4 and v5 remain. Check current version/revision, restore native source, styles, timing and retained media together, and reject missing historical resources without changing the current project. Returns the same previewHandoff as a source edit; explicit background requests use presentation=background.',
    inputSchema: object({ projectId, requestId: id, versionId: id, expectedRevision: revision, expectedVersionId: id, presentation }, ['projectId', 'requestId', 'versionId', 'expectedRevision', 'expectedVersionId']), annotations: write },
  { name: 'openmotion_export_cancel', title: 'OpenMotion · Export Cancel', description: 'Cancel the specified export owned by this project. Distinguish cancellation accepted/cancelling from a confirmed cancelled terminal state. A completed task stays completed. Cancellation does not restore source, delete older results or promise a refund. Stopping a host conversation does not automatically call this tool.',
    inputSchema: object({ projectId, requestId: id, jobId: id }, ['projectId', 'requestId', 'jobId']), annotations: write },
  ...designTools,
];

// Increment for incompatible request/response semantics; optional fields and new Tools are additive.
export function cloudPhase1Tools(publicOrigin: string) {
  return phase1Tools.map(tool => tool.name === projectArchiveTool.name ? cloudProjectArchiveTool(publicOrigin) : tool);
}

export const phase1McpCapabilities = { protocol: 1, tools: phase1Tools.map(tool => tool.name) };

export function phase1TransportTool(health: { mcp?: { protocol?: unknown; tools?: unknown } }, tool?: string): string | undefined {
  const name = publicToolName(tool);
  if (typeof name !== 'string' || !phase1McpCapabilities.tools.includes(name)
    || health.mcp?.protocol !== phase1McpCapabilities.protocol || !Array.isArray(health.mcp.tools)) return;
  // An older asset handler does not advertise the new read contract.
  if (name === 'openmotion_assets_use') return health.mcp.tools.includes(name) ? name : undefined;
  return [name, legacyToolName(name)].find(candidate => (health.mcp!.tools as unknown[]).includes(candidate));
}

export function supportsPhase1Tool(health: { mcp?: { protocol?: unknown; tools?: unknown } }, tool?: string): boolean {
  return phase1TransportTool(health, tool) !== undefined;
}

export function validateInput(schema: any, value: any, field = 'arguments', knownField = 'arguments', definitions = schema.$defs): void {
  if (schema.$ref) {
    const key = String(schema.$ref).slice('#/$defs/'.length);
    if (!String(schema.$ref).startsWith('#/$defs/') || !definitions || !Object.hasOwn(definitions, key)) throw new Error('Unknown tool schema reference');
    return validateInput(definitions[key], value, field, knownField, definitions);
  }
  const childField = (key: string) => knownField === 'arguments' ? key : knownField === 'unknown_field' ? knownField : knownField + '.' + key;
  if (schema.anyOf && !schema.anyOf.some((variant: Record<string, unknown>) => {
    try {
      validateInput(variant.properties || variant.required ? { type: 'object', additionalProperties: true, ...variant } : variant,
        value, field, knownField, definitions);
      return true;
    } catch (error) {
      if (!(error instanceof ToolInputError)) throw error;
      return false;
    }
  })) throw new ToolInputError(field + ' must match an allowed form', knownField, 'invalid_combination');
  if (schema.oneOf) {
    const variants: any[] = schema.oneOf;
    // Tool commands use disjoint tags. Only validate the selected branch, including in batches.
    const discriminator = ['kind', 'action', 'command', 'operation'].find(key => {
      const tags = variants.map(variant => variant.properties?.[key]?.enum);
      return tags.every(tag => tag?.length === 1) && new Set(tags.map(tag => tag[0])).size === tags.length;
    });
    if (discriminator) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ToolInputError(field + ' must be an object', knownField, 'invalid_type');
      }
      const selected = variants.find(variant => variant.properties[discriminator].enum[0] === value[discriminator]);
      if (!selected) throw new ToolInputError(field + '.' + discriminator, childField(discriminator),
        value[discriminator] === undefined ? 'missing' : 'invalid_enum');
      validateInput(selected, value, field, knownField, definitions);
    } else {
      const matches = variants.filter(variant => {
        try { validateInput(variant, value, field, knownField, definitions); return true; }
        catch (error) { if (error instanceof ToolInputError) return false; throw error; }
      });
      if (matches.length !== 1) throw new ToolInputError(field + ' must match one action and its required fields', knownField,
        variants.every(variant => variant.type === 'object') && (!value || typeof value !== 'object' || Array.isArray(value))
          ? 'invalid_type' : 'invalid_combination');
    }
  }
  if (Array.isArray(schema.type)) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!schema.type.includes(actual)) throw new ToolInputError(field, knownField, 'invalid_type');
    return validateInput({ ...schema, type: actual }, value, field, knownField, definitions);
  }
  if (schema.const !== undefined && schema.const !== value) throw new ToolInputError(field, knownField, 'invalid_enum');
  if (schema.enum && !schema.enum.includes(value)) throw new ToolInputError(field, knownField, 'invalid_enum');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ToolInputError(field + ' must be an object', knownField, 'invalid_type');
    if (Object.keys(value).length < (schema.minProperties ?? 0)) throw new ToolInputError(field, knownField, 'out_of_range');
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) throw new ToolInputError(field + '.' + key + ' is required', childField(key), 'missing');
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) validateInput(schema.properties[key], child, field + '.' + key, childField(key), definitions);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateInput(schema.additionalProperties, child, field + '.' + key, 'unknown_field', definitions);
      } else if (schema.additionalProperties !== true) {
        throw new ToolInputError('unknown ' + field + '.' + key, 'unknown_field', 'unknown_field');
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new ToolInputError(field, knownField, 'invalid_type');
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw new ToolInputError(field, knownField, 'out_of_range');
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) throw new ToolInputError(field, knownField, 'invalid_combination');
    value.forEach((item, i) => validateInput(schema.prefixItems?.[i] ?? schema.items, item, field + '[' + i + ']', knownField === 'unknown_field' ? knownField : knownField + '[]', definitions));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') throw new ToolInputError(field, knownField, 'invalid_type');
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) throw new ToolInputError(field, knownField, 'out_of_range');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new ToolInputError(field, knownField, 'invalid_format');
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') throw new ToolInputError(field, knownField, 'invalid_type');
  else if (['number', 'integer'].includes(schema.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isSafeInteger(value)) throw new ToolInputError(field, knownField, 'invalid_type');
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity) || value <= (schema.exclusiveMinimum ?? -Infinity)) throw new ToolInputError(field, knownField, 'out_of_range');
  }
}

/** Presentation is separate from business operations so authoring never mounts an App. */
export const finalVideoTool = {
  name: 'openmotion_show_video', title: 'OpenMotion · Final Video',
  description: 'Optional fallback player for a final completed, technically verified MP4. Prefer the host-native video preview; Codex defaults to one final-reply video embed and does not need this Tool. Use only when native preview is unavailable. Never combine this player with a native embed of the same export. When selected, call once after export completes, never during generation or editing. This read-only presentation creates no project, work round, render or editor page. Keep workId from the silent openmotion_open_preview(action=begin) through saves and export. Old final videos remain bound to their own immutable export. A ready editable Studio handoff is separate; use only discovered Tools.',
  inputSchema: object({ projectId, workId }, ['projectId', 'workId']), annotations: read,
  _meta: { ui: { resourceUri: inlineVideoUri }, 'openai/ui': { preferredModelDisplayMode: 'inline' } },
};
