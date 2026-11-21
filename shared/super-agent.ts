export const SUPER_AGENT_API = '/motion-api/super-agent';

export type SuperAgentEngine = string;
export type SuperAgentPermissionMode = 'on-request' | 'auto';

export type SuperAgentResourceKind =
  | 'asset'
  | 'brand-kit'
  | 'motion-template'
  | 'design-template'
  | 'skill'
  | 'design-skill'
  | 'design-project'
  | 'motion-project';

export type SuperAgentResourceAttachment = {
  id: string;
  kind: SuperAgentResourceKind;
  title: string;
  subtitle?: string;
  modality?: 'image' | 'video' | 'audio';
  versionId?: string;
  scenario?: string;
  previewUrl?: string;
  swatches?: string[];
  tags?: string[];
};

export type SuperAgentResourceCounts = {
  assets: number;
  brandKits: number;
  officialBrandKits: number;
  motionTemplates: number;
  designTemplates: number;
  skills: number;
  designSkills: number;
  designProjects: number;
  motionProjects: number;
  mediaProvidersAvailable: number;
};

export type SuperAgentResourceCatalog = {
  counts: SuperAgentResourceCounts;
  items: SuperAgentResourceAttachment[];
  generatedAt: number;
};

export type SuperAgentArtifactKind =
  | 'design-project'
  | 'motion-project'
  | 'motion-export'
  | 'asset-image'
  | 'asset-video'
  | 'asset-audio'
  | 'brand-kit'
  | 'web';

export type SuperAgentArtifact = {
  id: string;
  kind: SuperAgentArtifactKind;
  title: string;
  subtitle?: string;
  projectId?: string;
  sessionId?: string;
  scenario?: string;
  entry?: string;
  revision?: string;
  assetId?: string;
  versionId?: string;
  kitId?: string;
  jobId?: string;
  url?: string;
  downloadUrl?: string;
  mimeType?: string;
  createdAt: number;
  updatedAt: number;
};

export type SuperAgentToolEvent = {
  callId: string;
  tool: string;
  label: string;
  status: 'running' | 'completed' | 'failed';
  summary?: string;
  inputPreview?: string;
  outputPreview?: string;
  artifactId?: string;
  startedAt: number;
  finishedAt?: number;
};

export type SuperAgentMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  createdAt: number;
  attachments?: SuperAgentResourceAttachment[];
  toolEvent?: SuperAgentToolEvent;
  artifactIds?: string[];
};

export type SuperAgentApproval = {
  id: string;
  kind: 'generation' | 'command' | 'file' | 'tool';
  title: string;
  detail: string;
};

export type SuperAgentChat = {
  id: string;
  title: string;
  pinned?: boolean;
  runtimeId?: string;
  engine: SuperAgentEngine;
  model?: string;
  reasoning?: string;
  permissionMode: SuperAgentPermissionMode;
  threadId?: string;
  createdAt: number;
  updatedAt: number;
  state: 'idle' | 'running' | 'waiting' | 'failed' | 'cancelled';
  messages: SuperAgentMessage[];
  artifacts: SuperAgentArtifact[];
  activeArtifactId?: string;
  approvals: SuperAgentApproval[];
  error?: string;
  requestReceipts?: { requestId: string; inputHash: string }[];
};

export type SuperAgentChatSummary = {
  id: string;
  title: string;
  pinned?: boolean;
  runtimeId?: string;
  engine: SuperAgentEngine;
  state: SuperAgentChat['state'];
  artifactCount: number;
  messageCount: number;
  updatedAt: number;
  createdAt: number;
};

export type SuperAgentTurnInput = {
  requestId: string;
  text: string;
  runtimeId?: string;
  engine?: SuperAgentEngine;
  model?: string;
  reasoning?: string;
  permissionMode?: SuperAgentPermissionMode;
  attachments?: SuperAgentResourceAttachment[];
};

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function isSuperAgentId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function normalizeSuperAgentTitle(value: unknown): string {
  if (typeof value !== 'string') return 'New conversation';
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, 100);
  return normalized || 'New conversation';
}

export function artifactCanonicalAddress(artifact: SuperAgentArtifact): string {
  switch (artifact.kind) {
    case 'design-project':
      return `design://${artifact.projectId ?? artifact.id}`;
    case 'motion-project':
      return `motion://${artifact.projectId ?? artifact.id}`;
    case 'motion-export':
      return `export://${artifact.jobId ?? artifact.id}`;
    case 'asset-image':
    case 'asset-video':
    case 'asset-audio':
      return `asset://${artifact.assetId ?? artifact.id}${artifact.versionId ? `/${artifact.versionId}` : ''}`;
    case 'brand-kit':
      return `brand://${artifact.kitId ?? artifact.id}`;
    case 'web':
      return artifact.url || 'about:blank';
  }
}

export function formatSuperAgentToolLabel(tool: string, args?: Record<string, unknown>): string {
  const normalized = tool.replace(/^mcp__openmotion__/, '');
  const action = typeof args?.action === 'string' ? args.action : '';
  switch (normalized) {
    case 'openmotion_workspace_resources':
      return 'Scanned workspace resources';
    case 'openmotion_asset_models':
      return 'Inspected configured media models';
    case 'openmotion_read_workflow':
      return 'Read workflow guidance';
    case 'openmotion_present_artifact':
      return 'Opened artifact in Browser Viewer';
    case 'openmotion_design_catalog':
      return action === 'list_design_systems' || action === 'get_design_system'
        ? 'Browsed design systems'
        : action === 'list_templates' || action === 'get_template'
          ? 'Browsed design templates'
          : action === 'list_skills' || action === 'get_skill'
            ? 'Read design skill'
            : 'Explored Design Studio catalog';
    case 'openmotion_design_project':
      if (action === 'create') return 'Created HTML design project';
      if (action === 'open') return 'Prepared HTML design preview';
      if (action === 'export') return 'Exported HTML design';
      if (action === 'duplicate') return 'Duplicated design project';
      return 'Managed HTML design project';
    case 'openmotion_design_edit':
      if (action === 'write') return 'Updated HTML/CSS/JS source';
      if (action === 'read_file') return 'Read design source file';
      if (action === 'restore_version') return 'Restored design version';
      return 'Inspected design project files';
    case 'openmotion_design_comments':
      return 'Updated design annotations';
    case 'openmotion_create_project':
      return 'Created Motion Studio project';
    case 'openmotion_get_project':
      return args?.projectId ? 'Inspected Motion project' : 'Listed Motion projects';
    case 'openmotion_edit_project':
      return 'Updated Motion composition';
    case 'openmotion_open_preview':
      return args?.target === 'providers'
        ? 'Prepared provider setup'
        : args?.target === 'templates'
          ? 'Prepared template library'
          : 'Prepared Motion Studio preview';
    case 'openmotion_export_request':
      return 'Queued Motion MP4 export';
    case 'openmotion_export_cancel':
      return 'Cancelled Motion export';
    case 'openmotion_list_versions':
      return 'Listed Motion project versions';
    case 'openmotion_restore_version':
      return 'Restored Motion project version';
    case 'openmotion_import_assets':
      return 'Imported files into Motion project';
    case 'openmotion_list_templates':
    case 'openmotion_get_template':
      return 'Browsed Motion templates';
    case 'openmotion_list_skills':
    case 'openmotion_get_skill':
      return 'Read creative Skills';
    case 'openmotion_assets_use':
    case 'openmotion_assets':
      if (action === 'generate') return 'Generated workspace media asset';
      if (action === 'read') return 'Inspected media asset';
      if (action === 'brand_kit') return 'Worked with Brand Kit';
      if (action === 'status') return 'Checked media generation job';
      if (action === 'import_to_project') return 'Adopted asset into Motion project';
      return 'Managed workspace assets';
    case 'openmotion_media_use':
      if (action === 'generate') return 'Generated media';
      if (action === 'models') return 'Listed media models';
      if (action === 'inspect') return 'Checked media providers';
      return 'Checked media gateway';
    case 'openmotion_project_archive':
      return 'Managed project archive';
    case 'openmotion_manage_project':
      return 'Organized workspace projects';
    default:
      return normalized.replace(/^openmotion_/, '').replaceAll('_', ' ');
  }
}
