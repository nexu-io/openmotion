import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  WebStandardStreamableHTTPServerTransport,
  isInitializeRequest,
  isJsonContentType,
  readRequestBody,
  validateHostHeader,
  validateOriginHeader,
  type AuthInfo,
  type ServerEvent,
  type ServerEventBus,
} from '@modelcontextprotocol/server';
import {
  createMcpBearerAuthMiddleware,
  getAuthContext,
  type AuthEnv,
  type AuthMiddlewareDeps,
} from '../auth/middleware.ts';
import {
  isAllowedHttpsHost,
  isAllowedNativeAppScheme,
  parseAllowedHttpsHosts,
} from '../auth/oauth21.ts';
import type { AuthContext } from '../contracts/auth.ts';
import type { AppConfig } from '../infra/config.ts';
import {
  mcpEventsChannel,
  mcpSessionKey,
  type RateLimiter,
  type RedisEventBus,
} from '../infra/redis.ts';
import {
  createPerRequestMcpServer,
  detectMcpAppsUiSupport,
  loadOptionalTemplatePresentation,
  type McpSessionState,
} from './server.ts';
import type { McpToolDispatcher } from './tool-dispatcher.ts';

export const DEFAULT_MCP_SESSION_TTL_SEC = 86_400; // 24 hours
export const DEFAULT_MCP_MAX_BODY_BYTES = 10_485_760; // 10 MiB (supports 8 MiB openmotion_edit_project + envelope)
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

// ---------------------------------------------------------------------------
// Redis-Backed Multi-Replica `Mcp-Session-Id` Store (Zero Sticky Sessions)
// ---------------------------------------------------------------------------

export interface McpSessionStore {
  get(sessionId: string): Promise<McpSessionState | null>;
  set(state: McpSessionState, ttlSec?: number): Promise<void>;
  delete(sessionId: string): Promise<boolean>;
}

export class RedisMcpSessionStore implements McpSessionStore {
  private readonly redis: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: 'EX', duration: number): Promise<unknown>;
    del(key: string): Promise<number>;
  };
  private readonly defaultTtlSec: number;

  constructor(
    redis: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string, mode: 'EX', duration: number): Promise<unknown>;
      del(key: string): Promise<number>;
    },
    defaultTtlSec = DEFAULT_MCP_SESSION_TTL_SEC,
  ) {
    this.redis = redis;
    this.defaultTtlSec = defaultTtlSec;
  }

  async get(sessionId: string): Promise<McpSessionState | null> {
    let key: string;
    try {
      key = mcpSessionKey(sessionId);
    } catch {
      return null;
    }
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as McpSessionState;
    } catch {
      return null;
    }
  }

  async set(state: McpSessionState, ttlSec = this.defaultTtlSec): Promise<void> {
    const key = mcpSessionKey(state.sessionId);
    await this.redis.set(key, JSON.stringify(state), 'EX', Math.max(60, Math.floor(ttlSec)));
  }

  async delete(sessionId: string): Promise<boolean> {
    let key: string;
    try {
      key = mcpSessionKey(sessionId);
    } catch {
      return false;
    }
    const deleted = await this.redis.del(key);
    return deleted > 0;
  }
}

export class InMemoryMcpSessionStore implements McpSessionStore {
  private readonly map = new Map<string, { state: McpSessionState; expiresAt: number }>();
  private readonly defaultTtlSec: number;

  constructor(defaultTtlSec = DEFAULT_MCP_SESSION_TTL_SEC) {
    this.defaultTtlSec = defaultTtlSec;
  }

  async get(sessionId: string): Promise<McpSessionState | null> {
    const entry = this.map.get(sessionId);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.map.delete(sessionId);
      return null;
    }
    return { ...entry.state };
  }

  async set(state: McpSessionState, ttlSec = this.defaultTtlSec): Promise<void> {
    this.map.set(state.sessionId, {
      state: { ...state },
      expiresAt: Date.now() + Math.max(1, ttlSec) * 1000,
    });
  }

  async delete(sessionId: string): Promise<boolean> {
    return this.map.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// RedisEventBus Bridge for MCP `ServerEventBus` & SSE Streams
// ---------------------------------------------------------------------------

export interface McpEventBusPort {
  publish(channel: string, payload: unknown): Promise<number>;
  subscribe(
    channel: string,
    listener: (payload: unknown, channel: string) => void,
  ): Promise<() => Promise<void>>;
}

/**
 * Adapts `src/infra/redis.ts`'s `RedisEventBus` onto `@modelcontextprotocol/server`'s
 * `ServerEventBus` interface scoped to a tenant's MCP session channel.
 */
export class RedisMcpServerEventBus implements ServerEventBus {
  private readonly eventBus: McpEventBusPort;
  private readonly channel: string;

  constructor(eventBus: Pick<RedisEventBus, 'publish' | 'subscribe'>, workspaceId: string, sessionId: string) {
    this.eventBus = eventBus;
    this.channel = mcpEventsChannel(workspaceId, sessionId);
  }

  publish(event: ServerEvent): void {
    void this.eventBus.publish(this.channel, event).catch(() => {});
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    let active = true;
    let releasePromise: Promise<() => Promise<void>> | null = null;
    releasePromise = this.eventBus.subscribe(this.channel, (payload) => {
      if (!active || !payload || typeof payload !== 'object') return;
      listener(payload as ServerEvent);
    });
    return () => {
      active = false;
      if (releasePromise) {
        void releasePromise.then((unsubscribe) => unsubscribe()).catch(() => {});
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Host / Origin Security & Streamable HTTP Handler
// ---------------------------------------------------------------------------

export function buildAllowedHostnames(publicOrigin: string, extraHosts: readonly string[] = []): string[] {
  const hosts = new Set<string>(extraHosts.map((h) => h.trim()).filter(Boolean));
  try {
    const parsed = new URL(publicOrigin);
    hosts.add(parsed.hostname);
    if (LOOPBACK_HOSTS.has(parsed.hostname)) {
      hosts.add('localhost');
      hosts.add('127.0.0.1');
      hosts.add('[::1]');
    }
  } catch {
    hosts.add('localhost');
    hosts.add('127.0.0.1');
  }
  return [...hosts];
}

function toSdkAuthInfo(auth: AuthContext): AuthInfo {
  return {
    token: auth.tokenId ?? auth.authMethod,
    clientId: auth.clientId ?? auth.userId,
    scopes: [...auth.scopes],
    extra: {
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      clientId: auth.clientId ?? null,
      role: auth.role,
      authMode: auth.authMode,
      authMethod: auth.authMethod,
      entry: auth.entry ?? 'mcp',
    },
  };
}

function jsonRpcErrorResponse(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    },
  );
}

/**
 * Ensures the request passed into `@modelcontextprotocol/server`'s `WebStandardStreamableHTTPServerTransport`
 * carries a compatible `Accept` header even when minimal HTTP clients send only `Accept: application/json`.
 */
function normalizeStreamableHttpRequest(request: Request): Request {
  const accept = request.headers.get('accept') ?? '';
  const hasJson = accept.includes('application/json') || accept.includes('*/*');
  const hasSse = accept.includes('text/event-stream');
  if (hasJson && hasSse) return request;

  const headers = new Headers(request.headers);
  headers.set('accept', 'application/json, text/event-stream');
  return new Request(request.url, {
    method: request.method,
    headers,
  });
}

export interface McpHttpTransportDeps {
  config: AppConfig;
  dispatcher: McpToolDispatcher;
  sessionStore: McpSessionStore;
  eventBus?: McpEventBusPort;
  rateLimiter?: Pick<RateLimiter, 'consume'>;
  extraAllowedHosts?: readonly string[];
  sseKeepAliveMs?: number;
}

export function isAllowedMcpOrigin(
  originHeader: string,
  allowedHosts: readonly string[],
  allowedHttpsOrigins: readonly string[],
): boolean {
  const trimmed = originHeader.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol === 'http:') {
    if (LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return true;
    return validateOriginHeader(trimmed, [...allowedHosts]).ok;
  }
  if (parsed.protocol === 'https:') {
    if (validateOriginHeader(trimmed, [...allowedHosts]).ok) return true;
    return isAllowedHttpsHost(parsed.hostname, allowedHttpsOrigins);
  }
  if (isAllowedNativeAppScheme(parsed.protocol)) {
    return parsed.hostname.length > 0 || (parsed.pathname.length > 0 && parsed.pathname !== '/');
  }
  return false;
}

export class McpStreamableHttpHandler {
  private readonly deps: McpHttpTransportDeps;
  private readonly allowedHosts: string[];
  private readonly allowedHttpsOrigins: string[];
  private readonly maxBodyBytes: number;
  private readonly sseKeepAliveMs: number;

  constructor(deps: McpHttpTransportDeps) {
    this.deps = deps;
    this.allowedHosts = buildAllowedHostnames(
      deps.config.APP_PUBLIC_ORIGIN,
      deps.extraAllowedHosts,
    );
    this.allowedHttpsOrigins = parseAllowedHttpsHosts(deps.config.OAUTH_DCR_ALLOWED_HTTPS_HOSTS);
    this.maxBodyBytes = deps.config.MCP_MAX_BODY_BYTES ?? DEFAULT_MCP_MAX_BODY_BYTES;
    this.sseKeepAliveMs = deps.sseKeepAliveMs ?? 15_000;
  }

  private validateHeaders(request: Request): Response | null {
    const hostHeader = request.headers.get('host');
    if (hostHeader !== null) {
      const hostResult = validateHostHeader(hostHeader, this.allowedHosts);
      if (hostResult.ok === false) {
        const msg = 'message' in hostResult ? hostResult.message : 'Invalid Host header';
        return jsonRpcErrorResponse(403, -32000, `Forbidden Host header: ${msg}`);
      }
    }

    const originHeader = request.headers.get('origin');
    if (originHeader !== null) {
      if (!isAllowedMcpOrigin(originHeader, this.allowedHosts, this.allowedHttpsOrigins)) {
        return jsonRpcErrorResponse(
          403,
          -32000,
          `Forbidden Origin header: Origin "${originHeader}" is not allowed`,
        );
      }
    }
    return null;
  }

  private async loadOwnedSession(
    sessionId: string,
    auth: AuthContext,
  ): Promise<McpSessionState | null> {
    const state = await this.deps.sessionStore.get(sessionId);
    if (!state) return null;
    // Strict multi-tenant owner binding: cross-workspace or cross-user replay returns 404.
    if (state.workspaceId !== auth.workspaceId || state.userId !== auth.userId) {
      return null;
    }
    return state;
  }

  async handle(request: Request, auth: AuthContext): Promise<Response> {
    const headerRejection = this.validateHeaders(request);
    if (headerRejection) return headerRejection;

    const method = request.method.toUpperCase();
    const parsedBody = method === 'POST' ? await this.readPostBody(request) : undefined;
    if (this.deps.rateLimiter) {
      // A JSON-RPC envelope can carry multiple messages. A single tool call may itself edit several files.
      const cost = Array.isArray(parsedBody) ? Math.max(1, parsedBody.length) : 1;
      const rl = await this.deps.rateLimiter.consume(`mcp:${auth.workspaceId}`, 120, 60_000, cost);
      if (!rl.allowed) {
        const res = jsonRpcErrorResponse(429, -32000, 'MCP rate limit exceeded');
        res.headers.set('Retry-After', String(rl.retryAfterSec));
        return res;
      }
    }

    if (parsedBody instanceof Response) return parsedBody;
    if (method === 'POST') return this.handlePost(request, auth, parsedBody);
    if (method === 'GET') return this.handleGet(request, auth);
    if (method === 'DELETE') return this.handleDelete(request, auth);

    const res = jsonRpcErrorResponse(405, -32000, 'Method not allowed');
    res.headers.set('Allow', 'GET, POST, DELETE');
    return res;
  }

  private async readPostBody(request: Request): Promise<unknown> {
    if (!isJsonContentType(request.headers.get('content-type'))) {
      return jsonRpcErrorResponse(
        415,
        -32000,
        'Unsupported Media Type: Content-Type must be application/json',
      );
    }

    const bodyRead = await readRequestBody(request, this.maxBodyBytes);
    if (bodyRead.tooLarge) {
      return jsonRpcErrorResponse(
        413,
        -32000,
        `Payload Too Large: MCP request exceeds limit of ${this.maxBodyBytes} bytes`,
      );
    }

    const bodyText = 'text' in bodyRead ? bodyRead.text : '';
    try {
      return JSON.parse(bodyText);
    } catch {
      return jsonRpcErrorResponse(400, -32700, 'Parse error: Invalid JSON');
    }
  }

  private async handlePost(request: Request, auth: AuthContext, parsedBody: unknown): Promise<Response> {
    const incomingSessionId = request.headers.get('mcp-session-id')?.trim() || null;
    const isInit = isInitializeRequest(parsedBody);
    let sessionState: McpSessionState | null = null;
    let newlyCreatedSessionId: string | null = null;

    if (isInit) {
      const params = (parsedBody as { params?: Record<string, unknown> }).params ?? {};
      const supportsMcpAppsUi = detectMcpAppsUiSupport(params.capabilities);
      const presentation = supportsMcpAppsUi ? await loadOptionalTemplatePresentation() : null;
      const rawClientInfo =
        params.clientInfo && typeof params.clientInfo === 'object'
          ? (params.clientInfo as { name?: string; version?: string })
          : undefined;
      const protocolVersion =
        typeof params.protocolVersion === 'string' && params.protocolVersion
          ? params.protocolVersion
          : '2025-11-25';
      const now = Date.now();
      newlyCreatedSessionId = randomUUID();
      sessionState = {
        sessionId: newlyCreatedSessionId,
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        protocolVersion,
        ...(rawClientInfo ? { clientInfo: rawClientInfo } : {}),
        supportsMcpAppsUi,
        ...(presentation ? { templatePresentationUri: presentation.uri } : {}),
        createdAt: now,
        lastSeenAt: now,
      };
    } else if (incomingSessionId) {
      sessionState = await this.loadOwnedSession(incomingSessionId, auth);
      if (!sessionState) {
        return jsonRpcErrorResponse(404, -32001, 'Session not found');
      }
      sessionState.lastSeenAt = Date.now();
      await this.deps.sessionStore.set(sessionState, DEFAULT_MCP_SESSION_TTL_SEC);
    }

    const onBindSelection = sessionState
      ? async (selection: { projectId: string; sessionId: string }) => {
          sessionState!.boundProjectId = selection.projectId;
          sessionState!.boundSessionId = selection.sessionId;
          sessionState!.lastSeenAt = Date.now();
          await this.deps.sessionStore.set(sessionState!, DEFAULT_MCP_SESSION_TTL_SEC);
        }
      : undefined;

    const templatePresentation =
      sessionState?.supportsMcpAppsUi === true ? await loadOptionalTemplatePresentation() : null;

    const server = createPerRequestMcpServer({
      auth,
      sessionState,
      dispatcher: this.deps.dispatcher,
      publicOrigin: this.deps.config.APP_PUBLIC_ORIGIN,
      templatePresentation,
      onBindSelection,
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: this.maxBodyBytes,
    });

    try {
      await server.connect(transport);
      const response = await transport.handleRequest(normalizeStreamableHttpRequest(request), {
        parsedBody,
        authInfo: toSdkAuthInfo(auth),
      });

      if (newlyCreatedSessionId && sessionState) {
        // Persist newly initialized session ONLY if initialize succeeded without JSON-RPC error.
        let initSucceeded = response.ok;
        let responseBodyText: string | null = null;
        if (initSucceeded && isJsonContentType(response.headers.get('content-type'))) {
          responseBodyText = await response.text();
          try {
            const parsedRes = JSON.parse(responseBodyText) as { error?: unknown };
            if (parsedRes.error !== undefined) initSucceeded = false;
          } catch {
            initSucceeded = false;
          }
        }
        const headers = new Headers(response.headers);
        if (initSucceeded) {
          await this.deps.sessionStore.set(sessionState, DEFAULT_MCP_SESSION_TTL_SEC);
          headers.set('Mcp-Session-Id', newlyCreatedSessionId);
        }
        return new Response(responseBodyText ?? response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      if (sessionState) {
        const headers = new Headers(response.headers);
        headers.set('Mcp-Session-Id', sessionState.sessionId);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
      return response;
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  }

  /**
   * Optional server-initiated SSE stream (`GET /mcp`) backed by `RedisEventBus`
   * channel `om:mcp:events:{workspaceId}:{sessionId}` — zero sticky sessions across pods!
   */
  private async handleGet(request: Request, auth: AuthContext): Promise<Response> {
    const sessionId = request.headers.get('mcp-session-id')?.trim();
    if (!sessionId) {
      return jsonRpcErrorResponse(400, -32600, 'Missing Mcp-Session-Id header for SSE stream');
    }
    const session = await this.loadOwnedSession(sessionId, auth);
    if (!session) {
      return jsonRpcErrorResponse(404, -32001, 'Session not found');
    }

    const channel = mcpEventsChannel(auth.workspaceId, session.sessionId);
    const encoder = new TextEncoder();
    const eventBus = this.deps.eventBus;
    const keepAliveMs = this.sseKeepAliveMs;
    let unsubscribe: (() => Promise<void>) | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (unsubscribe) {
        const fn = unsubscribe;
        unsubscribe = null;
        void fn().catch(() => {});
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const enqueue = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            cleanup();
          }
        };

        enqueue(': connected\n\n');

        if (eventBus) {
          unsubscribe = await eventBus.subscribe(channel, (payload) => {
            enqueue(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
          });
        }

        if (keepAliveMs > 0) {
          timer = setInterval(() => {
            enqueue(': keepalive\n\n');
          }, keepAliveMs);
          if (typeof timer.unref === 'function') timer.unref();
        }

        request.signal.addEventListener(
          'abort',
          () => {
            cleanup();
            try {
              controller.close();
            } catch {
              // Stream already closed.
            }
          },
          { once: true },
        );
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Mcp-Session-Id': session.sessionId,
      },
    });
  }

  private async handleDelete(request: Request, auth: AuthContext): Promise<Response> {
    const sessionId = request.headers.get('mcp-session-id')?.trim();
    if (!sessionId) {
      return jsonRpcErrorResponse(400, -32600, 'Missing Mcp-Session-Id header');
    }
    const session = await this.loadOwnedSession(sessionId, auth);
    if (!session) {
      return jsonRpcErrorResponse(404, -32001, 'Session not found');
    }
    await this.deps.sessionStore.delete(session.sessionId);
    return new Response(null, { status: 204 });
  }
}

export interface McpRoutesDeps extends McpHttpTransportDeps {
  auth: AuthMiddlewareDeps;
}

/**
 * Creates a Hono sub-app mounting Streamable HTTP `/mcp` guarded strictly by Bearer-ONLY auth
 * (PAT, OAuth 2.1 access token, or OIDC JWT — NEVER browser session cookies!).
 */
export function createMcpHttpRoutes(deps: McpRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const bearerOnly = createMcpBearerAuthMiddleware(deps.auth);
  const handler = new McpStreamableHttpHandler(deps);

  app.all('/mcp', bearerOnly, async (c) => {
    const auth = getAuthContext(c);
    return handler.handle(c.req.raw, auth);
  });

  return app;
}
