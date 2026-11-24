import { installMotionComponent, listMotionComponents, type MotionComponentFiles } from '../services/motion-component-registry.ts';
import { readFile } from 'node:fs/promises';
import { assetReadToolResult, type AssetReadResult } from '../../shared/asset-library.ts';
import { designScenarios } from '../../shared/design-project.ts';
import { inlineVideoUri } from '../../shared/inline-video.ts';
import {
  finalVideoTool,
  phase1Tools,
  validateInput,
} from '../../shared/phase1-tools.ts';
import { publicToolName, publicToolResult } from '../../shared/public-names.mjs';
import { ToolInputError } from '../../shared/tool-input-error.ts';
import {
  hasMinRole,
  hasScope,
  type AuthContext,
  type PatScope,
} from '../contracts/auth.ts';
import {
  CloudError,
  featureDeferredP2,
  isCloudError,
} from '../contracts/errors.ts';
import type { AppConfig } from '../infra/config.ts';
import {
  GatewayError,
  buildGatewayStatus,
  gatewayCallContextFromAuth,
  type PlatformModelGateway,
} from '../services/model-gateway.ts';
import type { CloudImportAssetsService } from './import-assets.ts';
import {
  TEMPLATE_PRESENTATION_TOOL_NAME,
  type McpTemplatePresentation,
} from './resources.ts';

// ---------------------------------------------------------------------------
// Injected Domain Service Ports (Wired to Wave 2B Services in Wave 2C)
// ---------------------------------------------------------------------------

export interface McpDomainPorts {
  componentFiles?: MotionComponentFiles;
  projects?: {
    getProject(auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
    createProject(auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
    editProject(auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
    openPreview(auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
    manageProject(auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  versions?: {
    listVersions(auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
    restoreVersion(auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  exports?: {
    exportRequest(auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
    exportCancel(auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  catalog?: {
    listTemplates(auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
    getTemplate(auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
    listSkills(auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
    getSkill(auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  assets?: {
    handleAssetsUse(
      auth: AuthContext,
      args: Record<string, unknown>,
      options: { compatAlias: boolean },
    ): Promise<Record<string, unknown>>;
  };
  archive?: {
    handleProjectArchive(auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  mediaJobs?: {
    handleMediaAction(auth: AuthContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  importAssets?: CloudImportAssetsService;
  gateway?: PlatformModelGateway;
  getWorkspaceDefaultModels?: (workspaceId: string) => Promise<Record<string, string | undefined>>;
}

export interface McpDispatchContext {
  auth: AuthContext;
  boundSessionId?: string;
  boundProjectId?: string;
  supportsMcpAppsUi: boolean;
  templatePresentation?: McpTemplatePresentation | null;
  renderTemplateRecommendations?: (
    presentation: McpTemplatePresentation,
    args: { templateIds: string[]; onboarding?: boolean; language?: string },
  ) => Record<string, unknown> & { recommendationId: string; onboarding?: boolean };
  onBindSelection?: (selection: { projectId: string; sessionId: string }) => Promise<void> | void;
}

export interface McpToolCallResponse {
  [key: string]: unknown;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; mimeType: string; data: string }
    | { type: 'audio'; mimeType: string; data: string }
  >;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

const DEFERRED_P2_DESIGN_TOOLS = new Set([
  'openmotion_design_project',
  'openmotion_design_edit',
  'openmotion_design_comments',
]);

function requireToolScopes(auth: AuthContext, scopes: readonly PatScope[]): void {
  if (!hasScope(auth, 'mcp:tools')) {
    throw new CloudError('INSUFFICIENT_SCOPE', "Missing required scope 'mcp:tools'", {
      status: 403,
      applied: false,
      details: { requiredScope: 'mcp:tools' },
    });
  }
  for (const scope of scopes) {
    if (!hasScope(auth, scope)) {
      throw new CloudError('INSUFFICIENT_SCOPE', `Missing required scope '${scope}'`, {
        status: 403,
        applied: false,
        details: { requiredScope: scope },
      });
    }
  }
}

function handleStaticDesignCatalog(args: Record<string, unknown>): Record<string, unknown> {
  const action = String(args.action ?? 'list_scenarios');
  if (action === 'list_scenarios') {
    return {
      scenarios: designScenarios,
      cloudMode: 'p1_readonly',
      note: 'Design Studio project authoring is deferred to P2; static scenario discovery is available.',
    };
  }
  if (action === 'list_templates' || action === 'list_skills' || action === 'list_design_systems') {
    return {
      items: [],
      total: 0,
      cloudMode: 'p1_readonly',
      note: 'Design Studio catalog entries beyond scenarios are deferred to P2.',
    };
  }
  throw new CloudError('NOT_FOUND', `Design catalog entry not found for action '${action}'`, {
    status: 404,
    applied: false,
  });
}

function formatErrorResult(error: unknown): McpToolCallResponse {
  if (error instanceof ToolInputError) {
    const payload = {
      error: {
        code: error.code,
        status: 400,
        message: error.message,
        invalid_field: error.invalid_field,
        validation_rule: error.validation_rule,
        applied: false,
      },
    };
    return {
      isError: true,
      content: [{ type: 'text', text: error.message }],
      structuredContent: payload,
    };
  }

  if (isCloudError(error)) {
    const legacyCode =
      typeof error.details?.legacyCode === 'string' ? error.details.legacyCode : undefined;
    const payload = {
      error: {
        code: legacyCode ?? error.code,
        status: error.status,
        message: error.message,
        applied: error.applied ?? false,
        ...(error.details ? { details: error.details } : {}),
      },
    };
    return {
      isError: true,
      content: [{ type: 'text', text: error.message }],
      structuredContent: payload,
    };
  }

  if (error instanceof GatewayError) {
    const payload = {
      error: {
        code: error.code,
        status: error.status ?? 502,
        message: error.message,
        retryable: error.retryable,
        outcomeUnknown: error.outcomeUnknown,
        applied: error.outcomeUnknown ? 'unknown' : false,
      },
    };
    return {
      isError: true,
      content: [{ type: 'text', text: error.message }],
      structuredContent: payload,
    };
  }

  const message = error instanceof Error ? error.message : 'Tool execution failed';
  const rawCode =
    (error as { code?: string })?.code ?? /^([A-Z][A-Z0-9_]+):?/.exec(message)?.[1] ?? 'TOOL_FAILED';
  const payload = {
    error: {
      code: rawCode,
      status: 500,
      message,
      applied: 'unknown',
    },
  };
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: payload,
  };
}

export class McpToolDispatcher {
  private readonly config: AppConfig;
  private readonly ports: McpDomainPorts;
  private readonly phase1ByName: Map<string, (typeof phase1Tools)[number]>;

  constructor(config: AppConfig, ports: McpDomainPorts) {
    this.config = config;
    this.ports = ports;
    this.phase1ByName = new Map(phase1Tools.map((tool) => [tool.name, tool]));
  }

  async dispatch(
    rawToolName: string,
    rawArgs: unknown,
    ctx: McpDispatchContext,
  ): Promise<McpToolCallResponse> {
    try {
      const name = publicToolName(rawToolName);
      const argsObj =
        rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? ({ ...(rawArgs as Record<string, unknown>) })
          : {};

      // 1. Optional negotiated MCP Apps presentation tools.
      if (name === TEMPLATE_PRESENTATION_TOOL_NAME) {
        if (!ctx.supportsMcpAppsUi || !ctx.templatePresentation || !ctx.renderTemplateRecommendations) {
          throw new CloudError('NOT_FOUND', `MCP_TOOL_NOT_EXPOSED: ${rawToolName}`, {
            status: 404,
            applied: false,
          });
        }
        requireToolScopes(ctx.auth, ['projects:read']);
        validateInput(ctx.templatePresentation.tool.inputSchema, argsObj);
        const value = ctx.renderTemplateRecommendations(
          ctx.templatePresentation,
          argsObj as { templateIds: string[]; onboarding?: boolean; language?: string },
        );
        return {
          content: [
            {
              type: 'text',
              text: value.onboarding
                ? 'The native onboarding component includes the complete welcome and three template cards. Wait for the user before creating a project.'
                : 'Preview these templates, then choose a card or reply with its number. No project has been created.',
            },
          ],
          structuredContent: value as unknown as Record<string, unknown>,
          _meta: {
            ui: { resourceUri: ctx.templatePresentation.uri },
            'openai/widgetSessionId': value.recommendationId,
          },
        };
      }

      if (name === finalVideoTool.name) {
        if (!ctx.supportsMcpAppsUi) {
          throw new CloudError('NOT_FOUND', `MCP_TOOL_NOT_EXPOSED: ${rawToolName}`, {
            status: 404,
            applied: false,
          });
        }
        requireToolScopes(ctx.auth, ['projects:read']);
        validateInput(finalVideoTool.inputSchema, argsObj);
        if (!this.ports.projects) {
          throw new CloudError('SERVICE_UNAVAILABLE', 'Project service is not wired', {
            status: 503,
            applied: false,
          });
        }
        const projectState = await this.ports.projects.getProject(ctx.auth, {
          projectId: argsObj.projectId,
          workId: argsObj.workId,
          includeVideo: true,
        });
        const inlineWork = projectState.inlineWork as Record<string, unknown> | undefined;
        if (!inlineWork?.playable || inlineWork.state !== 'completed') {
          throw new CloudError(
            'INVALID_ARGUMENT',
            'FINAL_VIDEO_NOT_READY: Display only after the MP4 export completes and passes verification',
            { status: 400, applied: false },
          );
        }
        const presentation = publicToolResult({
          ...projectState,
          inlineVideoTransport: 'presigned-url',
        }) as Record<string, unknown>;
        return {
          content: [{ type: 'text', text: JSON.stringify(presentation) }],
          structuredContent: presentation,
          _meta: { ui: { resourceUri: inlineVideoUri } },
        };
      }

      // 2. Domain tools (all 22 registered `openmotion_*` names).
      const definition = this.phase1ByName.get(name);
      if (!definition) {
        throw new CloudError('NOT_FOUND', `MCP_TOOL_NOT_EXPOSED: ${rawToolName}`, {
          status: 404,
          applied: false,
        });
      }

      // 3. Explicit P2 gating BEFORE legacy schema validation so callers receive deterministic
      //    FEATURE_DEFERRED_P2 (501) responses rather than legacy local-FS schema errors.
      if (DEFERRED_P2_DESIGN_TOOLS.has(name)) {
        requireToolScopes(ctx.auth, ['projects:read']);
        throw featureDeferredP2(name);
      }
      if (name === 'openmotion_manage_project' && argsObj.action === 'comments') {
        requireToolScopes(ctx.auth, ['projects:read']);
        throw featureDeferredP2('openmotion_manage_project.comments');
      }
      const isAssetsUseTool = name === 'openmotion_assets_use' || name === 'openmotion_assets';
      if (isAssetsUseTool && argsObj.action === 'brand_kit') {
        const brandKit = (argsObj.brandKit ?? {}) as Record<string, unknown>;
        const operation = String(brandKit.operation ?? brandKit.command ?? '');
        if (['create', 'rescan'].includes(operation)) {
          requireToolScopes(ctx.auth, ['assets:write']);
          throw featureDeferredP2('brand_kit_website_capture');
        }
      }
      if (isAssetsUseTool && argsObj.action === 'transcript') {
        const transcript = (argsObj.transcript ?? {}) as Record<string, unknown>;
        if (transcript.command === 'submit' && !this.config.OPENDESIGN_ASR_URL) {
          requireToolScopes(ctx.auth, ['media:generate']);
          throw featureDeferredP2('transcript.submit');
        }
      }
      if (isAssetsUseTool && argsObj.action === 'scenario') {
        requireToolScopes(ctx.auth, ['assets:read']);
        throw featureDeferredP2('scenario_workflows');
      }

      // Legacy host sourcePath check for openmotion_import_assets BEFORE strict cloud schema validation
      // so callers get an explicit `LOCAL_PATH_UNSUPPORTED_IN_CLOUD` error with guidance.
      if (name === 'openmotion_import_assets' && this.ports.importAssets) {
        requireToolScopes(ctx.auth, ['assets:write', 'projects:write']);
        this.ports.importAssets.assertNoLegacySourcePath(argsObj);
      }

      // Validate input against canonical phase1 schema.
      validateInput(definition.inputSchema, argsObj);

      const result = await this.dispatchDomainTool(name, argsObj, ctx);

      // Update Redis-backed session selection binding if projectId & sessionId were returned.
      if (
        typeof result.projectId === 'string' &&
        typeof result.sessionId === 'string' &&
        ctx.onBindSelection
      ) {
        await ctx.onBindSelection({
          projectId: result.projectId,
          sessionId: result.sessionId,
        });
      }

      if (isAssetsUseTool && argsObj.action === 'read' && Array.isArray(result.content)) {
        return assetReadToolResult(result as unknown as AssetReadResult) as McpToolCallResponse;
      }

      const normalized = publicToolResult(result) as Record<string, unknown>;
      return {
        content: [{ type: 'text', text: JSON.stringify(normalized) }],
        structuredContent: normalized,
      };
    } catch (error) {
      return formatErrorResult(error);
    }
  }

  private async dispatchDomainTool(
    name: string,
    args: Record<string, unknown>,
    ctx: McpDispatchContext,
  ): Promise<Record<string, unknown>> {
    const { auth } = ctx;

    switch (name) {
      case 'openmotion_design_catalog': {
        requireToolScopes(auth, ['projects:read']);
        return handleStaticDesignCatalog(args);
      }

      case 'openmotion_get_project': {
        requireToolScopes(auth, ['projects:read']);
        if (!this.ports.projects) {
          throw new CloudError('SERVICE_UNAVAILABLE', 'Project service is not wired', { status: 503, applied: false });
        }
        return this.ports.projects.getProject(auth, args);
      }

      case 'openmotion_create_project': {
        requireToolScopes(auth, ['projects:write']);
        if (!this.ports.projects) {
          throw new CloudError('SERVICE_UNAVAILABLE', 'Project service is not wired', { status: 503, applied: false });
        }
        return this.ports.projects.createProject(auth, args);
      }

      case 'openmotion_edit_project': {
        requireToolScopes(auth, ['projects:write']);
        if (!this.ports.projects) {
          throw new CloudError('SERVICE_UNAVAILABLE', 'Project service is not wired', { status: 503, applied: false });
        }
        return this.ports.projects.editProject(auth, args);
      }

      case 'openmotion_open_preview': {
        requireToolScopes(auth, ['projects:read']);
        if (args.action === 'begin' || args.action === 'complete_generation' || args.action === 'record_display' || args.action === 'record_review') {
          requireToolScopes(auth, ['projects:write']);
        }
        if (!this.ports.projects) {
          throw new CloudError('SERVICE_UNAVAILABLE', 'Project service is not wired', { status: 503, applied: false });
        }
        const effectiveArgs = { ...args };
        if (
          effectiveArgs.target !== 'templates' &&
          effectiveArgs.target !== 'providers' &&
          !effectiveArgs.projectId &&
          !effectiveArgs.sessionId &&
          effectiveArgs.action !== 'record_review' &&
          ctx.boundSessionId
        ) {
          effectiveArgs.sessionId = ctx.boundSessionId;
        }
        return this.ports.projects.openPreview(auth, effectiveArgs);
      }

      case 'openmotion_import_assets': {
        requireToolScopes(auth, ['assets:write', 'projects:write']);
        if (!this.ports.importAssets) {
          throw new CloudError('SERVICE_UNAVAILABLE', 'Import assets service is not wired', { status: 503, applied: false });
        }
        const res = await this.ports.importAssets.execute(auth, args);
        return res as unknown as Record<string, unknown>;
      }

      case 'openmotion_list_versions': {
        requireToolScopes(auth, ['projects:read']);
        if (!this.ports.versions) {
          throw new CloudError('SERVICE_UNAVAILABLE', 'Version service is not wired', { status: 503, applied: false });
        }
        return this.ports.versions.listVersions(auth, args);
      }

      case 'openmotion_restore_version': {
        requireToolScopes(auth, ['projects:write']);
        if (!this.ports.versions) {
          throw new CloudError('SERVICE_UNAVAILABLE', 'Version service is not wired', { status: 503, applied: false });
        }
        return this.ports.versions.restoreVersion(auth, args);
      }

      case 'openmotion_export_request': {
        requireToolScopes(auth, ['exports:write']);
        if (!this.ports.exports) {
          throw new CloudError('SERVICE_UNAVAILABLE', 'Export service is not wired', { status: 503, applied: false });
        }
        return this.ports.exports.exportRequest(auth, args);
      }

      case 'openmotion_export_cancel': {
        requireToolScopes(auth, ['exports:write']);
        if (!this.ports.exports) {
          throw new CloudError('SERVICE_UNAVAILABLE', 'Export service is not wired', { status: 503, applied: false });
        }
        return this.ports.exports.exportCancel(auth, args);
      }

      case 'openmotion_list_templates': {
        requireToolScopes(auth, ['projects:read']);
        if (!this.ports.catalog) {
          throw new CloudError('SERVICE_UNAVAILABLE', 'Catalog service is not wired', { status: 503, applied: false });
        }
        return this.ports.catalog.listTemplates(auth, args);
      }

      case 'openmotion_get_template': {
        requireToolScopes(auth, ['projects:read']);
        if (!this.ports.catalog) {
          throw new CloudError('SERVICE_UNAVAILABLE', 'Catalog service is not wired', { status: 503, applied: false });
        }
        return this.ports.catalog.getTemplate(auth, args);
      }

      case 'openmotion_list_skills': {
        requireToolScopes(auth, ['projects:read']);
        if (!this.ports.catalog) {
          throw new CloudError('SERVICE_UNAVAILABLE', 'Catalog service is not wired', { status: 503, applied: false });
        }
        return this.ports.catalog.listSkills(auth, args);
      }

      case 'openmotion_get_skill': {
        requireToolScopes(auth, ['projects:read']);
        if (!this.ports.catalog) {
          throw new CloudError('SERVICE_UNAVAILABLE', 'Catalog service is not wired', { status: 503, applied: false });
        }
        return this.ports.catalog.getSkill(auth, args);
      }

      case 'openmotion_manage_project': {
        const action = String(args.action ?? '');
        if (action === 'comments') {
          requireToolScopes(auth, ['projects:read']);
          throw featureDeferredP2('openmotion_manage_project.comments');
        }
        if (action === 'reveal') {
          requireToolScopes(auth, ['projects:read']);
          throw new CloudError(
            'INVALID_ARGUMENT',
            'LOCAL_HOST_UNAVAILABLE: Server file manager is unavailable in cloud deployment.',
            {
              status: 400,
              applied: false,
              details: { legacyCode: 'LOCAL_HOST_UNAVAILABLE' },
            },
          );
        }
        if (action === 'info') {
          requireToolScopes(auth, ['projects:read']);
        } else if (action === 'delete') {
          requireToolScopes(auth, ['workspace:admin']);
          if (!hasMinRole(auth, 'admin')) {
            throw new CloudError(
              'FORBIDDEN',
              'Permanent project deletion requires admin or owner role',
              { status: 403, applied: false },
            );
          }
        } else {
          requireToolScopes(auth, ['projects:write']);
        }
        if (!this.ports.projects) {
          throw new CloudError('SERVICE_UNAVAILABLE', 'Project service is not wired', { status: 503, applied: false });
        }
        return this.ports.projects.manageProject(auth, args);
      }

      case 'openmotion_project_archive': {
        requireToolScopes(auth, args.action === 'export' ? ['projects:read'] : ['projects:write']);
        if (!this.ports.archive) {
          throw new CloudError('SERVICE_UNAVAILABLE', 'Project archive service is not wired', { status: 503, applied: false });
        }
        return this.ports.archive.handleProjectArchive(auth, args);
      }

      case 'openmotion_media_use': {
        return this.handleMediaUse(auth, args);
      }

      case 'openmotion_assets_use':
      case 'openmotion_assets': {
        return this.handleAssetsUse(auth, args, name === 'openmotion_assets');
      }

      default:
        throw new CloudError('NOT_FOUND', `MCP_TOOL_NOT_EXPOSED: ${name}`, {
          status: 404,
          applied: false,
        });
    }
  }

  private async handleMediaUse(
    auth: AuthContext,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const action = String(args.action ?? '');

    if (action === 'inspect') {
      requireToolScopes(auth, ['assets:read']);
      if (!this.ports.gateway) {
        throw new CloudError('SERVICE_UNAVAILABLE', 'Model gateway is not wired', { status: 503, applied: false });
      }
      const callCtx = gatewayCallContextFromAuth(auth);
      const [models, defaults, billing] = await Promise.all([
        this.ports.gateway.listMediaModels(callCtx),
        this.ports.getWorkspaceDefaultModels
          ? this.ports.getWorkspaceDefaultModels(auth.workspaceId)
          : Promise.resolve({}),
        this.ports.gateway.getBillingSummary
          ? this.ports.gateway.getBillingSummary(callCtx)
          : Promise.resolve(null),
      ]);
      // Never leak raw balanceUsd to MCP inspect (advisory entitlement/plan/hasBalance only).
      const safeBilling = billing
        ? {
            plan: billing.plan,
            mediaEntitlement: billing.mediaEntitlement,
            ...(billing.hasBalance !== undefined ? { hasBalance: billing.hasBalance } : {}),
          }
        : null;
      return {
        ...buildGatewayStatus(models, defaults, safeBilling, this.ports.gateway.statusIdentity),
        references: { opendesign: 'openmotion://workflow/media/opendesign' },
      };
    }

    if (action === 'reference') {
      requireToolScopes(auth, ['assets:read']);
      const provider = typeof args.provider === 'string' ? args.provider : 'opendesign';
      if (provider !== 'opendesign') {
        throw new CloudError(
          'NOT_FOUND',
          `Provider '${provider}' is not enabled in cloud deployment. Use provider='opendesign'.`,
          { status: 404, applied: false },
        );
      }
      const guideUrl = new URL(
        '../../skills/openmotion-media/references/providers/opendesign.md',
        import.meta.url,
      );
      const content = await readFile(guideUrl, 'utf8');
      return {
        provider: 'opendesign',
        uri: 'openmotion://workflow/media/opendesign',
        content,
      };
    }

    if (action === 'models') {
      requireToolScopes(auth, ['assets:read']);
      if (!this.ports.gateway) {
        throw new CloudError('SERVICE_UNAVAILABLE', 'Model gateway is not wired', { status: 503, applied: false });
      }
      const models = await this.ports.gateway.listMediaModels(
        gatewayCallContextFromAuth(auth),
        { refresh: args.refresh === true },
      );
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      const modality = typeof args.modality === 'string' ? args.modality : undefined;
      const mode = typeof args.mode === 'string' ? args.mode : undefined;
      const filtered = models.filter((m) => {
        if (modality && m.modality !== modality) return false;
        if (mode && m.mode !== mode) return false;
        if (query && !m.id.toLowerCase().includes(query) && !m.label.toLowerCase().includes(query)) {
          return false;
        }
        return true;
      });
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      const limit = typeof args.limit === 'number' ? args.limit : 100;
      return {
        provider: 'opendesign',
        total: filtered.length,
        offset,
        limit,
        models: filtered.slice(offset, offset + limit),
      };
    }

    if (['generate', 'cancel', 'resume', 'retry_save'].includes(action)) {
      requireToolScopes(auth, ['media:generate']);
    } else {
      requireToolScopes(auth, ['assets:read']);
    }

    if (!this.ports.mediaJobs) {
      throw new CloudError('SERVICE_UNAVAILABLE', 'Media generation job service is not wired', {
        status: 503,
        applied: false,
      });
    }
    return this.ports.mediaJobs.handleMediaAction(auth, args);
  }

  private async handleAssetsUse(
    auth: AuthContext,
    args: Record<string, unknown>,
    compatAlias: boolean,
  ): Promise<Record<string, unknown>> {
    const action = String(args.action ?? '');

    if (action === 'list_components') {
      requireToolScopes(auth, ['projects:read']);
      return listMotionComponents(args.query as string | undefined, args.offset as number | undefined, args.limit as number | undefined);
    }
    if (action === 'install_component') {
      requireToolScopes(auth, ['projects:write']);
      if (!hasMinRole(auth, 'editor')) throw new CloudError('FORBIDDEN', 'Editor access is required to install components', { status: 403 });
      if (!this.ports.componentFiles) throw new CloudError('SERVICE_UNAVAILABLE', 'Project file service is not wired', { status: 503 });
      return installMotionComponent(auth, this.ports.componentFiles, String(args.projectId), String(args.name), { requestId: String(args.requestId), hostFile: args.hostFile });
    }

    // P2 explicit gating for headless Brand Kit website capture.
    if (action === 'brand_kit') {
      const brandKit = (args.brandKit ?? {}) as Record<string, unknown>;
      const operation = String(brandKit.operation ?? brandKit.command ?? '');
      if (['create', 'rescan'].includes(operation)) {
        requireToolScopes(auth, ['assets:write']);
        throw featureDeferredP2('brand_kit_website_capture');
      }
      requireToolScopes(auth, ['assets:read']);
      if (operation === 'catalog' || operation === 'list') {
        return {
          items: [],
          total: 0,
          cloudMode: 'p1_readonly',
        };
      }
    }

    // P2 explicit gating for Workflows / Scenario runs in Cloud P1.
    if (action === 'scenario') {
      requireToolScopes(auth, ['assets:read']);
      throw featureDeferredP2('scenario_workflows');
    }

    // P2 explicit gating for cloud ASR transcription when OPENDESIGN_ASR_URL is unset.
    if (action === 'transcript') {
      const transcript = (args.transcript ?? {}) as Record<string, unknown>;
      const command = String(transcript.command ?? '');
      if (command === 'submit' && !this.config.OPENDESIGN_ASR_URL) {
        requireToolScopes(auth, ['media:generate']);
        throw featureDeferredP2('transcript.submit');
      }
      requireToolScopes(
        auth,
        ['caption_tracks', 'caption_export', 'get', 'list'].includes(command)
          ? ['projects:read']
          : ['projects:write'],
      );
    } else if (['list', 'get', 'jobs', 'status', 'read'].includes(action)) {
      requireToolScopes(auth, ['assets:read']);
    } else if (['generate', 'cancel', 'resume', 'retry_save'].includes(action)) {
      requireToolScopes(auth, ['media:generate']);
    } else if (action === 'import_to_project') {
      requireToolScopes(auth, ['assets:read', 'projects:write']);
      if (this.ports.importAssets && typeof args.projectId === 'string' && typeof args.assetId === 'string' && typeof args.versionId === 'string') {
        const res = await this.ports.importAssets.importItems(auth, {
          projectId: args.projectId,
          requestId: String(args.requestId ?? ''),
          items: [
            {
              itemId: String(args.assetId),
              source: {
                kind: 'library_asset',
                assetId: args.assetId,
                versionId: args.versionId,
              },
              ...(typeof args.name === 'string' ? { name: args.name } : {}),
            },
          ],
        });
        return res as unknown as Record<string, unknown>;
      }
    } else {
      requireToolScopes(auth, ['assets:write']);
    }

    if (!this.ports.assets) {
      throw new CloudError('SERVICE_UNAVAILABLE', 'Asset library service is not wired', {
        status: 503,
        applied: false,
      });
    }
    return this.ports.assets.handleAssetsUse(auth, args, { compatAlias });
  }
}
