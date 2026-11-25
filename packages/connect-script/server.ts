/**
 * K9 — Web Connect Script Loopback Bridge Server.
 *
 * Exposes the exact four universal host bridge methods (`info`, `capabilities`,
 * `invoke`, `subscribe`) over a strictly localhost (`127.0.0.1`) HTTP server
 * with strict Origin allowlist enforcement, timing-safe per-session token
 * authentication, bounded JSON bodies, and SSE event forwarding.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL, URLSearchParams } from 'node:url';
import {
  CONNECT_SCRIPT_DEFAULT_PORT,
  CONNECT_SCRIPT_ENDPOINTS,
  CONNECT_SCRIPT_HOST,
  CONNECT_SCRIPT_PROTOCOL_VERSION,
  CONNECT_SCRIPT_TOKEN_HEADER,
  type ConnectScriptEventMessage,
  type ConnectScriptHealthResponse,
  type ConnectScriptInvokeRequest,
} from '../../shared/connect-script-protocol.ts';
import { isUrlInAllowedDomainScope } from '../../shared/desktop-builtin-rules.ts';
import { ConnectScriptInvokeRequestSchema } from '../../shared/desktop-schemas.ts';
import {
  hostErr,
  type HostReleaseChannel,
  type UniversalHostBridge,
} from '../../shared/desktop-contract.ts';

export const CONNECT_SCRIPT_MAX_BODY_BYTES = 64 * 1024;
export const CONNECT_SCRIPT_DEFAULT_HEARTBEAT_MS = 15_000;

export type ConnectEventSubscription = {
  capability: string;
  event: string;
};

export type ConnectScriptServerOptions = {
  bridge: UniversalHostBridge;
  /** Port to bind on 127.0.0.1. Defaults to CONNECT_SCRIPT_DEFAULT_PORT (43118). Pass 0 for ephemeral port. */
  port?: number;
  /** Release channel governing allowed browser Origins. Defaults to 'stable'. */
  channel?: HostReleaseChannel;
  /** Allow http://127.0.0.1 / http://localhost Origins only when `channel === 'dev'`. */
  allowLocalDevLoopback?: boolean;
  /** Optional explicit Origin allowlist subset (still bounded by built-in domain scope). */
  allowedOrigins?: readonly string[];
  /** Optional pre-generated session token (defaults to 24 random bytes encoded as base64url). */
  token?: string;
  /** Maximum JSON request body bytes for POST /v1/invoke. Defaults to 64 KB. */
  maxBodyBytes?: number;
  /** Heartbeat comment interval in milliseconds for GET /v1/events SSE stream. Defaults to 15000. */
  heartbeatIntervalMs?: number;
  /** Default event subscriptions when GET /v1/events omits query filters. Defaults to wildcard `*:*`. */
  defaultEventSubscriptions?: readonly ConnectEventSubscription[];
};

export type ConnectScriptServerHandle = {
  server: Server;
  host: typeof CONNECT_SCRIPT_HOST;
  port: number;
  baseUrl: string;
  token: string;
  channel: HostReleaseChannel;
  allowLocalDevLoopback: boolean;
  activeEventClients: () => number;
  close: () => Promise<void>;
};

export function generateSessionToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Validates that an HTTP `Origin` header is a canonical origin within the
 * shell's built-in allowed domain scope (and optional narrowed allowlist).
 */
export function isOriginAllowed(
  origin: string | undefined,
  options?: {
    channel?: HostReleaseChannel;
    allowLocalDevLoopback?: boolean;
    allowedOrigins?: readonly string[];
  },
): origin is string {
  if (!origin || typeof origin !== 'string') return false;
  if (origin.trim() !== origin) return false;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  // Must be a pure canonical origin (no trailing slash, path, query, fragment, or userinfo).
  if (parsed.origin !== origin) return false;

  const inScope = isUrlInAllowedDomainScope(origin, {
    channel: options?.channel ?? 'stable',
    allowLocalDevLoopback: options?.allowLocalDevLoopback,
  });
  if (!inScope) return false;

  if (options?.allowedOrigins && options.allowedOrigins.length > 0) {
    return options.allowedOrigins.includes(origin);
  }

  return true;
}

/**
 * Builds a Studio pairing URL using a URL hash fragment so the per-session
 * loopback token is never transmitted to the cloud server in HTTP requests.
 */
export function buildStudioPairingUrl(options: {
  studioUrl: string;
  port: number;
  token: string;
}): string {
  const parsed = new URL(options.studioUrl);
  // Route bare origin or reserved `/mcp` backend path (with or without trailing slash) to `/mcp-setup`.
  const normalizedPathname = parsed.pathname.replace(/\/+$/, '') || '/';
  if (normalizedPathname === '/' || normalizedPathname === '/mcp') {
    parsed.pathname = '/mcp-setup';
  }
  const hashParams = new URLSearchParams({
    connect_port: String(options.port),
    connect_token: options.token,
  });
  parsed.hash = hashParams.toString();
  return parsed.toString();
}

function timingSafeTokenMatches(expected: string, candidate: string | null | undefined): boolean {
  if (!candidate || typeof candidate !== 'string') return false;
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}

function extractSingleHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 1) return value[0];
  return undefined;
}

function extractRequestToken(
  req: IncomingMessage,
  requestUrl: URL,
  allowQueryToken: boolean,
): string | undefined {
  const headerToken = extractSingleHeader(req.headers[CONNECT_SCRIPT_TOKEN_HEADER]);
  if (headerToken && headerToken.trim().length > 0) {
    return headerToken.trim();
  }

  const authHeader = extractSingleHeader(req.headers.authorization);
  if (authHeader) {
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
    if (match?.[1]) {
      return match[1];
    }
  }

  if (allowQueryToken) {
    const queryToken = requestUrl.searchParams.get('token');
    if (queryToken && queryToken.trim().length > 0) {
      return queryToken.trim();
    }
  }

  return undefined;
}

function setSecurityHeaders(
  res: ServerResponse,
  allowedOrigin?: string,
  options?: { allowPrivateNetwork?: boolean },
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      `Content-Type, Authorization, ${CONNECT_SCRIPT_TOKEN_HEADER}`,
    );
    if (options?.allowPrivateNetwork) {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  options?: { closeConnection?: boolean; onFinished?: () => void },
): void {
  if (res.writableEnded) return;
  const serialized = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(serialized, 'utf8'));
  if (options?.closeConnection) {
    res.setHeader('Connection', 'close');
  }
  res.end(serialized, options?.onFinished);
}

type ReadBodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_large' | 'aborted' };

function readBoundedBody(req: IncomingMessage, maxBodyBytes: number): Promise<ReadBodyResult> {
  return new Promise(resolve => {
    const declaredLengthRaw = extractSingleHeader(req.headers['content-length']);
    if (declaredLengthRaw !== undefined) {
      const declaredLength = Number.parseInt(declaredLengthRaw, 10);
      if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
        req.resume();
        resolve({ ok: false, reason: 'too_large' });
        return;
      }
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (result: ReadBodyResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      totalBytes += buf.byteLength;
      if (totalBytes > maxBodyBytes) {
        chunks.length = 0;
        finish({ ok: false, reason: 'too_large' });
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (settled) return;
      finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });

    req.on('error', () => {
      finish({ ok: false, reason: 'aborted' });
    });

    req.on('aborted', () => {
      finish({ ok: false, reason: 'aborted' });
    });
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseInvokeRequestBody(
  rawText: string,
): { ok: true; request: ConnectScriptInvokeRequest } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, message: 'Request body must be valid JSON' };
  }

  if (!isPlainRecord(parsed)) {
    return { ok: false, message: 'Request body must be a JSON object' };
  }

  const validated = ConnectScriptInvokeRequestSchema.safeParse(parsed);
  if (!validated.success) {
    const first = validated.error.issues[0];
    const field = first?.path.length ? `"${first.path.join('.')}" ` : '';
    return {
      ok: false,
      message: first ? `Field ${field}${first.message}` : 'Invalid invoke request payload',
    };
  }

  return {
    ok: true,
    request: {
      capability: validated.data.capability,
      method: validated.data.method,
      ...(validated.data.params !== undefined ? { params: validated.data.params } : {}),
    },
  };
}

function resolveEventSubscriptions(
  requestUrl: URL,
  defaults: readonly ConnectEventSubscription[],
): ConnectEventSubscription[] {
  const topics = requestUrl.searchParams.getAll('topic');
  const parsedTopics: ConnectEventSubscription[] = [];

  for (const topic of topics) {
    const separatorIdx = topic.indexOf(':');
    if (separatorIdx > 0 && separatorIdx < topic.length - 1) {
      const capability = topic.slice(0, separatorIdx).trim();
      const event = topic.slice(separatorIdx + 1).trim();
      if (capability && event) {
        parsedTopics.push({ capability, event });
      }
    }
  }
  if (parsedTopics.length > 0) {
    return parsedTopics;
  }

  const capabilityParam = requestUrl.searchParams.get('capability')?.trim();
  const eventParam = requestUrl.searchParams.get('event')?.trim();
  if (capabilityParam || eventParam) {
    return [{ capability: capabilityParam || '*', event: eventParam || '*' }];
  }

  return defaults.length > 0 ? [...defaults] : [{ capability: '*', event: '*' }];
}

function formatEventMessage(
  subscription: ConnectEventSubscription,
  rawPayload: unknown,
): ConnectScriptEventMessage {
  if (
    (subscription.capability === '*' || subscription.event === '*') &&
    isPlainRecord(rawPayload) &&
    typeof rawPayload.capability === 'string' &&
    typeof rawPayload.event === 'string' &&
    'payload' in rawPayload
  ) {
    return {
      capability: rawPayload.capability,
      event: rawPayload.event,
      payload: rawPayload.payload,
    };
  }

  return {
    capability: subscription.capability,
    event: subscription.event,
    payload: rawPayload,
  };
}

function getAllowedMethodForPath(pathname: string): 'GET' | 'POST' | null {
  switch (pathname) {
    case CONNECT_SCRIPT_ENDPOINTS.HEALTH:
    case CONNECT_SCRIPT_ENDPOINTS.INFO:
    case CONNECT_SCRIPT_ENDPOINTS.CAPABILITIES:
    case CONNECT_SCRIPT_ENDPOINTS.EVENTS:
      return 'GET';
    case CONNECT_SCRIPT_ENDPOINTS.INVOKE:
      return 'POST';
    default:
      return null;
  }
}

/**
 * Creates a configured (not yet listening) Node HTTP server implementing the
 * Web Connect Script loopback protocol. Use `startConnectScriptServer` to bind
 * strictly to `127.0.0.1`.
 */
export function createConnectScriptServer(options: ConnectScriptServerOptions): {
  server: Server;
  token: string;
  channel: HostReleaseChannel;
  allowLocalDevLoopback: boolean;
  activeEventClients: () => number;
  closeAllEventClients: () => void;
} {
  const channel: HostReleaseChannel = options.channel ?? 'stable';
  const allowLocalDevLoopback = Boolean(options.allowLocalDevLoopback && channel === 'dev');
  const token = options.token && options.token.length > 0 ? options.token : generateSessionToken();
  const maxBodyBytes = options.maxBodyBytes ?? CONNECT_SCRIPT_MAX_BODY_BYTES;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? CONNECT_SCRIPT_DEFAULT_HEARTBEAT_MS;
  const defaultEventSubscriptions = options.defaultEventSubscriptions ?? [
    { capability: '*', event: '*' },
  ];

  const activeEventCleanups = new Set<() => void>();

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const rawOrigin = extractSingleHeader(req.headers.origin);
    if (
      !isOriginAllowed(rawOrigin, {
        channel,
        allowLocalDevLoopback,
        allowedOrigins: options.allowedOrigins,
      })
    ) {
      setSecurityHeaders(res);
      sendJson(res, 403, hostErr('ORIGIN_DENIED', 'Origin is missing or not allowed'));
      return;
    }

    const requestedPrivateNetwork =
      extractSingleHeader(req.headers['access-control-request-private-network'])?.trim().toLowerCase() ===
      'true';
    setSecurityHeaders(res, rawOrigin, { allowPrivateNetwork: requestedPrivateNetwork });

    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url ?? '/', `http://${CONNECT_SCRIPT_HOST}`);
    } catch {
      sendJson(res, 400, hostErr('INVALID_PARAMS', 'Malformed request URL'));
      return;
    }

    const { pathname } = requestUrl;
    const expectedMethod = getAllowedMethodForPath(pathname);
    if (expectedMethod === null) {
      sendJson(res, 404, hostErr('NOT_FOUND', `Unknown endpoint: ${pathname}`));
      return;
    }
    if (method !== expectedMethod) {
      res.setHeader('Allow', `${expectedMethod}, OPTIONS`);
      sendJson(res, 405, hostErr('UNSUPPORTED', `Method ${method} is not allowed for ${pathname}`));
      return;
    }

    if (pathname === CONNECT_SCRIPT_ENDPOINTS.HEALTH) {
      const health: ConnectScriptHealthResponse = {
        ok: true,
        protocolVersion: CONNECT_SCRIPT_PROTOCOL_VERSION,
        hostKind: 'connect-script',
        requiresToken: true,
      };
      sendJson(res, 200, health);
      return;
    }

    const isEventsEndpoint = pathname === CONNECT_SCRIPT_ENDPOINTS.EVENTS;
    const candidateToken = extractRequestToken(req, requestUrl, isEventsEndpoint);
    if (!timingSafeTokenMatches(token, candidateToken)) {
      sendJson(res, 401, hostErr('UNAUTHORIZED', 'Missing or invalid connect token'));
      return;
    }

    if (pathname === CONNECT_SCRIPT_ENDPOINTS.INFO) {
      const info = await options.bridge.info();
      sendJson(res, 200, info);
      return;
    }

    if (pathname === CONNECT_SCRIPT_ENDPOINTS.CAPABILITIES) {
      const capabilities = await options.bridge.capabilities();
      sendJson(res, 200, capabilities);
      return;
    }

    if (pathname === CONNECT_SCRIPT_ENDPOINTS.INVOKE) {
      const bodyResult = await readBoundedBody(req, maxBodyBytes);
      if (!bodyResult.ok) {
        if (bodyResult.reason === 'too_large') {
          sendJson(
            res,
            413,
            hostErr('INVALID_PARAMS', `Request body exceeds ${maxBodyBytes} byte limit`),
            {
              closeConnection: true,
              onFinished: () => {
                req.destroy();
              },
            },
          );
          return;
        }
        if (!res.writableEnded) {
          sendJson(res, 400, hostErr('INVALID_PARAMS', 'Request body could not be read'));
        }
        return;
      }

      const parsed = parseInvokeRequestBody(bodyResult.text);
      if (!parsed.ok) {
        sendJson(res, 400, hostErr('INVALID_PARAMS', parsed.message));
        return;
      }

      const result = await options.bridge.invoke(
        parsed.request.capability,
        parsed.request.method,
        parsed.request.params,
      );
      sendJson(res, 200, result);
      return;
    }

    if (isEventsEndpoint) {
      const subscriptions = resolveEventSubscriptions(requestUrl, defaultEventSubscriptions);

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      res.write(': connected\n\n');

      const unsubscribers: Array<() => void> = [];
      let cleaned = false;

      const heartbeatTimer = setInterval(() => {
        if (!cleaned && !res.writableEnded) {
          res.write(': heartbeat\n\n');
        }
      }, heartbeatIntervalMs);

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeatTimer);
        activeEventCleanups.delete(cleanup);
        for (const unsub of unsubscribers) {
          try {
            unsub();
          } catch {
            // Ignore unsubscribe failures during connection teardown.
          }
        }
        if (!res.writableEnded) {
          res.end();
        }
      };

      activeEventCleanups.add(cleanup);
      req.on('close', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);

      for (const sub of subscriptions) {
        const unsub = options.bridge.subscribe(sub.capability, sub.event, rawPayload => {
          if (cleaned || res.writableEnded) return;
          const message = formatEventMessage(sub, rawPayload);
          res.write(`data: ${JSON.stringify(message)}\n\n`);
        });
        unsubscribers.push(unsub);
      }
      return;
    }
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(err => {
      const message = err instanceof Error ? err.message : 'Unexpected bridge server error';
      if (!res.headersSent) {
        sendJson(res, 500, hostErr('INTERNAL_ERROR', message));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  const closeAllEventClients = () => {
    for (const cleanup of Array.from(activeEventCleanups)) {
      cleanup();
    }
  };

  return {
    server,
    token,
    channel,
    allowLocalDevLoopback,
    activeEventClients: () => activeEventCleanups.size,
    closeAllEventClients,
  };
}

/**
 * Starts the Web Connect Script loopback bridge server strictly bound to `127.0.0.1`.
 */
export async function startConnectScriptServer(
  options: ConnectScriptServerOptions,
): Promise<ConnectScriptServerHandle> {
  const requestedPort = options.port ?? CONNECT_SCRIPT_DEFAULT_PORT;
  const {
    server,
    token,
    channel,
    allowLocalDevLoopback,
    activeEventClients,
    closeAllEventClients,
  } = createConnectScriptServer(options);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, CONNECT_SCRIPT_HOST);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Connect script server failed to bind to an IPv4 loopback port');
  }

  const boundPort = address.port;
  const baseUrl = `http://${CONNECT_SCRIPT_HOST}:${boundPort}`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    closeAllEventClients();
    await new Promise<void>((resolve, reject) => {
      server.close(err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
      server.closeIdleConnections?.();
    });
  };

  return {
    server,
    host: CONNECT_SCRIPT_HOST,
    port: boundPort,
    baseUrl,
    token,
    channel,
    allowLocalDevLoopback,
    activeEventClients,
    close,
  };
}
