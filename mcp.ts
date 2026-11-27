import { createInterface } from 'node:readline';
import { isMain } from './shared/entry.ts';
import { VERSION } from './shared/version.ts';
import { phase1Tools } from './shared/phase1-tools.ts';

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

export function getMcpEndpoint(): string {
  if (process.env.OPENMOTION_MCP_URL) {
    return process.env.OPENMOTION_MCP_URL;
  }
  const origin =
    process.env.APP_PUBLIC_ORIGIN ||
    process.env.OPENMOTION_PUBLIC_ORIGIN ||
    `http://127.0.0.1:${process.env.PORT || 4173}`;
  return `${origin.replace(/\/+$/, '')}/mcp`;
}

export function getAuthToken(): string {
  return (
    process.env.OPENMOTION_TOKEN ||
    process.env.OPENMOTION_PAT ||
    process.env.DEV_PAT ||
    'om_pat_devlocal_000000000000000000000000'
  );
}

export async function forwardRpc(message: JsonRpcMessage): Promise<JsonRpcMessage | null> {
  const url = getMcpEndpoint();
  const token = getAuthToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${token}`,
  };

  if (activeSessionId) {
    headers['Mcp-Session-Id'] = activeSessionId;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });

  const returnedSessionId = response.headers.get('mcp-session-id');
  if (returnedSessionId) {
    activeSessionId = returnedSessionId;
  }

  if (response.status === 200) {
    const text = await response.text();
    if (!text.trim()) return null;
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

  if (parsedError && parsedError.jsonrpc === '2.0') {
    return parsedError;
  }

  return {
    jsonrpc: '2.0',
    id: message.id ?? null,
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
  }
}
