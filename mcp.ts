import { createInterface } from 'node:readline';
import { isMain } from './shared/entry.ts';
import { VERSION } from './shared/version.ts';
import { phase1Tools } from './shared/phase1-tools.ts';
import { ensureService } from './preview.ts';

export { VERSION };
export { phase1Tools as tools };

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

let activeSessionId: string | null = null;
let lastInitializeRequest: JsonRpcMessage | null = null;
let resolvedLocalOrigin: string | null = null;
let serviceBootstrapPromise: Promise<string> | null = null;

export function resetMcpBridgeState(): void {
  activeSessionId = null;
  lastInitializeRequest = null;
  resolvedLocalOrigin = null;
  serviceBootstrapPromise = null;
}

export function getMcpEndpoint(): string {
  if (process.env.OPENMOTION_MCP_URL) {
    return process.env.OPENMOTION_MCP_URL;
  }
  const origin =
    process.env.APP_PUBLIC_ORIGIN ||
    process.env.OPENMOTION_PUBLIC_ORIGIN ||
    resolvedLocalOrigin ||
    `http://127.0.0.1:${process.env.PORT || 4173}`;
  return `${origin.replace(/\/+$/, '')}/mcp`;
}

async function ensureMcpEndpoint(): Promise<string> {
  if (
    process.env.OPENMOTION_MCP_URL ||
    process.env.APP_PUBLIC_ORIGIN ||
    process.env.OPENMOTION_PUBLIC_ORIGIN
  ) {
    return getMcpEndpoint();
  }

  if (!resolvedLocalOrigin) {
    if (!serviceBootstrapPromise) {
      const directory = process.env.MOTION_DATA_DIR || process.cwd();
      serviceBootstrapPromise = ensureService({ directory })
        .then((res) => {
          resolvedLocalOrigin = res.previewUrl;
          return res.previewUrl;
        })
        .catch((err) => {
          serviceBootstrapPromise = null;
          throw err;
        });
    }
    await serviceBootstrapPromise;
  }

  return getMcpEndpoint();
}

export function getAuthToken(): string {
  return (
    process.env.OPENMOTION_TOKEN ||
    process.env.OPENMOTION_PAT ||
    process.env.DEV_PAT ||
    'om_pat_devlocal_000000000000000000000000'
  );
}

function parseSseJsonRpc(body: string): JsonRpcMessage | null {
  const events = body.split(/\r?\n\r?\n/);
  for (let i = events.length - 1; i >= 0; i--) {
    const dataLines = events[i]
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n').trim();
    if (!payload || payload === '[DONE]') continue;
    return JSON.parse(payload) as JsonRpcMessage;
  }
  return null;
}

function normalizeErrorResponse(
  message: JsonRpcMessage,
  errorResponse: JsonRpcMessage,
): JsonRpcMessage | null {
  if (message.id === undefined) {
    return null;
  }
  if (errorResponse.id === undefined || errorResponse.id === null) {
    return { ...errorResponse, id: message.id };
  }
  return errorResponse;
}

export async function forwardRpc(
  message: JsonRpcMessage,
  retried = false,
): Promise<JsonRpcMessage | null> {
  if (message.method === 'initialize') {
    lastInitializeRequest = message;
  }

  const url = await ensureMcpEndpoint();
  const token = getAuthToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${token}`,
  };

  if (activeSessionId) {
    headers['Mcp-Session-Id'] = activeSessionId;
  }

  const timeoutMs = Number(process.env.OPENMOTION_MCP_TIMEOUT_MS || 180_000);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const returnedSessionId = response.headers.get('mcp-session-id');
  if (returnedSessionId) {
    activeSessionId = returnedSessionId;
  }

  if (response.status === 200) {
    const text = await response.text();
    if (!text.trim()) return null;
    const contentType = response.headers.get('content-type') || '';
    if (
      contentType.includes('text/event-stream') ||
      text.trimStart().startsWith('event:') ||
      text.trimStart().startsWith('data:')
    ) {
      return parseSseJsonRpc(text);
    }
    return JSON.parse(text) as JsonRpcMessage;
  }

  if (response.status === 202 || response.status === 204) {
    return null;
  }

  const errorText = await response.text().catch(() => response.statusText);
  let parsedError: JsonRpcMessage | null = null;
  try {
    parsedError = JSON.parse(errorText) as JsonRpcMessage;
  } catch {
    parsedError = null;
  }

  const isSessionNotFound =
    response.status === 404 || parsedError?.error?.code === -32001;

  if (isSessionNotFound && activeSessionId) {
    activeSessionId = null;
    if (!retried && lastInitializeRequest && message.method !== 'initialize') {
      await forwardRpc(lastInitializeRequest, true);
      return forwardRpc(message, true);
    }
  }

  if (parsedError && parsedError.jsonrpc === '2.0') {
    return normalizeErrorResponse(message, parsedError);
  }

  if (message.id === undefined) {
    return null;
  }

  return {
    jsonrpc: '2.0',
    id: message.id,
    error: {
      code: -32603,
      message: `MCP HTTP proxy error (${response.status}): ${errorText}`,
    },
  };
}

export async function rpc(message: unknown): Promise<unknown> {
  return forwardRpc(message as JsonRpcMessage);
}

if (isMain(import.meta.url)) {
  const lines = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  const pending = new Set<Promise<void>>();

  const handleMessage = async (message: JsonRpcMessage) => {
    try {
      const reply = await forwardRpc(message);
      if (reply !== null && reply !== undefined) {
        process.stdout.write(JSON.stringify(reply) + '\n');
      }
    } catch (err: any) {
      if (message.id !== undefined && message.id !== null) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32603,
              message: `OpenMotion MCP stdio bridge failed: ${err?.message || String(err)}`,
            },
          }) + '\n',
        );
      }
    }
  };

  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }) + '\n',
      );
      continue;
    }

    const task = handleMessage(message).finally(() => {
      pending.delete(task);
    });
    pending.add(task);
  }

  await Promise.allSettled(pending);
}
