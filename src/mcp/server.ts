import { Server } from '@modelcontextprotocol/server';
import { createToolRegistry } from '../../shared/mcp-registry.ts';
import { cloudMcpPostAuthorizationInstructions } from '../../shared/integration.ts';
import { cloudPhase1Tools, finalVideoTool } from '../../shared/phase1-tools.ts';
import { VERSION } from '../../shared/version.ts';
import type { AuthContext } from '../contracts/auth.ts';
import {
  listCloudMcpResources,
  readCloudMcpResource,
  type McpTemplatePresentation,
} from './resources.ts';
import type { McpToolDispatcher } from './tool-dispatcher.ts';

export interface McpSessionState {
  sessionId: string;
  workspaceId: string;
  userId: string;
  protocolVersion: string;
  clientInfo?: { name?: string; version?: string };
  supportsMcpAppsUi: boolean;
  templatePresentationUri?: string;
  boundSessionId?: string;
  boundProjectId?: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface CreatePerRequestMcpServerOptions {
  auth: AuthContext;
  sessionState: McpSessionState | null;
  dispatcher: McpToolDispatcher;
  publicOrigin: string;
  templatePresentation?: McpTemplatePresentation | null;
  onBindSelection?: (selection: { projectId: string; sessionId: string }) => Promise<void> | void;
}

let cachedTemplatePresentation: McpTemplatePresentation | null | undefined;
let cachedShowTemplateRecommendations:
  | ((
      presentation: McpTemplatePresentation,
      args: { templateIds: string[]; onboarding?: boolean; language?: string },
    ) => Record<string, unknown> & { recommendationId: string; onboarding?: boolean })
  | null = null;

/**
 * Lazily loads optional prebuilt template recommendation presentation assets at runtime
 * without creating a static compile-time dependency on legacy `template-library.ts`/`hyperframes.ts`.
 */
export async function loadOptionalTemplatePresentation(): Promise<McpTemplatePresentation | null> {
  if (cachedTemplatePresentation !== undefined) return cachedTemplatePresentation;
  if (process.env.OPENMOTION_TEMPLATE_CARDS === '0') {
    cachedTemplatePresentation = null;
    return null;
  }
  try {
    const modPath = '../../shared/mcp-template-recommendations' + '.ts';
    const mod = (await import(modPath)) as {
      loadTemplatePresentation: () => McpTemplatePresentation;
      showTemplateRecommendations: (
        presentation: McpTemplatePresentation,
        args: { templateIds: string[]; onboarding?: boolean; language?: string },
      ) => Record<string, unknown> & { recommendationId: string; onboarding?: boolean };
    };
    cachedShowTemplateRecommendations = mod.showTemplateRecommendations;
    cachedTemplatePresentation = mod.loadTemplatePresentation();
  } catch {
    cachedTemplatePresentation = null;
  }
  return cachedTemplatePresentation;
}

export function getCachedTemplatePresentation(): McpTemplatePresentation | null {
  return cachedTemplatePresentation ?? null;
}

export function getTemplateRecommendationRenderer() {
  return cachedShowTemplateRecommendations;
}

export function detectMcpAppsUiSupport(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false;
  const extensions = (capabilities as Record<string, unknown>).extensions;
  if (!extensions || typeof extensions !== 'object') return false;
  const ui = (extensions as Record<string, unknown>)['io.modelcontextprotocol/ui'];
  if (!ui || typeof ui !== 'object') return false;
  const mimeTypes = (ui as Record<string, unknown>).mimeTypes;
  return Array.isArray(mimeTypes) && mimeTypes.includes('text/html;profile=mcp-app');
}

/**
 * Constructs a lightweight per-request `@modelcontextprotocol/server@2.4.0` `Server`
 * hydrated with `(auth, sessionState)` so multi-replica `api` pods need ZERO sticky sessions
 * while preserving negotiated MCP Apps UI extensions and HostContext.
 */
export function createPerRequestMcpServer(options: CreatePerRequestMcpServerOptions): Server {
  const supportsUi = options.sessionState?.supportsMcpAppsUi === true;
  const templatePresentation = supportsUi
    ? (options.templatePresentation ?? getCachedTemplatePresentation())
    : null;

  const extensions = supportsUi
    ? [...(templatePresentation ? [templatePresentation.tool] : []), finalVideoTool]
    : [];

  const registry = createToolRegistry(cloudPhase1Tools(options.publicOrigin), 'phase1', extensions);
  const envLine = `Connected cloud server origin: ${options.publicOrigin.replace(/\/+$/, '')} (workspace: ${options.auth.workspaceId}, auth: ${options.auth.authMode}).`;
  const instructions = [registry.instructions, envLine, cloudMcpPostAuthorizationInstructions(options.publicOrigin)]
    .filter(Boolean).join('\n\n');

  const server = new Server(
    {
      name: 'openmotion',
      title: 'OpenMotion',
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions,
    },
  );

  server.setRequestHandler('tools/list', async () => {
    return {
      tools: registry.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema as { type: 'object'; [key: string]: unknown },
        annotations: tool.annotations,
        ...('_meta' in tool && tool._meta ? { _meta: tool._meta } : {}),
      })),
    };
  });

  server.setRequestHandler('tools/call', async (request) => {
    const result = await options.dispatcher.dispatch(
      request.params.name,
      request.params.arguments ?? {},
      {
        auth: options.auth,
        boundSessionId: options.sessionState?.boundSessionId,
        boundProjectId: options.sessionState?.boundProjectId,
        supportsMcpAppsUi: supportsUi,
        templatePresentation,
        renderTemplateRecommendations: cachedShowTemplateRecommendations ?? undefined,
        onBindSelection: options.onBindSelection,
      },
    );
    return result;
  });

  server.setRequestHandler('resources/list', async () => {
    return {
      resources: listCloudMcpResources({ templatePresentation }),
    };
  });

  server.setRequestHandler('resources/read', async (request) => {
    const content = await readCloudMcpResource(request.params.uri, {
      templatePresentation,
      publicOrigin: options.publicOrigin,
    });
    return { contents: [content] };
  });

  return server;
}
