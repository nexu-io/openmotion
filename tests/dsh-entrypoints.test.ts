import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { probe, openPreview } from '../preview.ts';
import { forwardRpc, resetMcpBridgeState } from '../mcp.ts';

async function withServer(
  handler: http.RequestListener,
  fn: (port: number, url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind test server');
  }
  try {
    await fn(address.port, `http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('probe rejects unrelated occupied port with non-OpenMotion service name', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'unrelated-app' }));
  }, async (port) => {
    const result = await probe(port);
    assert.equal(result.kind, 'busy');
  });
});

test('probe gates readiness on /api/health/ready rather than /api/health/live', async () => {
  await withServer((req, res) => {
    if (req.url === '/api/health/ready' || req.url === '/api/health') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, service: 'api', status: 'degraded' }));
      return;
    }
    if (req.url === '/api/health/live') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'api', status: 'live' }));
      return;
    }
    res.writeHead(404);
    res.end();
  }, async (port) => {
    const result = await probe(port);
    assert.equal(result.kind, 'motion');
    assert.equal(result.health.ready, false);
  });
});

test('openPreview throws and stops child when service never becomes ready', async () => {
  let stopped = false;
  await assert.rejects(
    () =>
      openPreview(
        { directory: process.cwd() },
        {
          probe: async () => ({ kind: 'free' }),
          launch: async () => ({
            pid: 99999,
            alive: () => true,
            error: () => 'db unavailable',
            stop: () => {
              stopped = true;
            },
          }),
          wait: async () => {},
          attempts: 2,
        },
      ),
    /failed to become ready.*db unavailable/,
  );
  assert.equal(stopped, true);
});

test('forwardRpc preserves request id on null-id server errors and drops notification errors', async () => {
  resetMcpBridgeState();
  await withServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32001, message: 'Session not found' },
        }),
      );
    });
  }, async (_port, url) => {
    process.env.OPENMOTION_MCP_URL = `${url}/mcp`;
    try {
      const reply = await forwardRpc({ jsonrpc: '2.0', id: 42, method: 'tools/list' });
      assert.equal(reply?.id, 42);
      assert.equal(reply?.error?.code, -32001);

      const notifReply = await forwardRpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
      assert.equal(notifReply, null);
    } finally {
      delete process.env.OPENMOTION_MCP_URL;
      resetMcpBridgeState();
    }
  });
});

test('forwardRpc clears stale session on 404, re-initializes, and retries once', async () => {
  resetMcpBridgeState();
  let sessionCounter = 0;
  let calls: Array<{ method?: string; sessionId?: string }> = [];

  await withServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const msg = JSON.parse(body);
      const sid = req.headers['mcp-session-id'] as string | undefined;
      calls.push({ method: msg.method, sessionId: sid });

      if (msg.method === 'initialize') {
        sessionCounter += 1;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': `sess-${sessionCounter}`,
        });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }));
        return;
      }

      if (sid === 'sess-1') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32001, message: 'Session not found' },
          }),
        );
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }));
    });
  }, async (_port, url) => {
    process.env.OPENMOTION_MCP_URL = `${url}/mcp`;
    try {
      await forwardRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' });
      const res = await forwardRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert.deepEqual(res?.result, { tools: [] });
      assert.equal(calls.length, 4);
      assert.equal(calls[1].sessionId, 'sess-1');
      assert.equal(calls[3].sessionId, 'sess-2');
    } finally {
      delete process.env.OPENMOTION_MCP_URL;
      resetMcpBridgeState();
    }
  });
});

test('forwardRpc parses SSE text/event-stream responses', async () => {
  resetMcpBridgeState();
  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"sse":true}}\n\n');
  }, async (_port, url) => {
    process.env.OPENMOTION_MCP_URL = `${url}/mcp`;
    try {
      const reply = await forwardRpc({ jsonrpc: '2.0', id: 7, method: 'ping' });
      assert.equal(reply?.id, 7);
      assert.deepEqual(reply?.result, { sse: true });
    } finally {
      delete process.env.OPENMOTION_MCP_URL;
      resetMcpBridgeState();
    }
  });
});

test('DSH plugin forwards OPENMOTION_TOKEN in mcpClient env', async () => {
  const source = await readFile(
    new URL('../integrations/dsh/plugin/src/index.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /OPENMOTION_TOKEN/);
});
