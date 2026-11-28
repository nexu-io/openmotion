import { spawn } from 'node:child_process';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './shared/entry.ts';
import { VERSION } from './shared/version.ts';

export { VERSION };

const pluginRoot = fileURLToPath(new URL('./', import.meta.url));

export type Health = {
  service: string;
  protocol: number;
  version: string;
  dataDirectory?: string;
  ffmpeg?: boolean;
  ready: boolean;
  editorReady?: boolean;
  studioUrl?: string;
  hyperframesCli?: string;
  authoringGuide?: string;
  mcp?: { protocol: number; tools: string[] };
};

export type Probe = { kind: 'free' | 'busy'; health?: never } | { kind: 'motion'; health: Health };

export type Started = {
  pid?: number;
  alive: () => boolean;
  error: () => string;
  stop: () => void;
};

export type PreviewRuntime = {
  probe: (port: number) => Promise<Probe>;
  launch: (port: number, directory: string, log?: string, background?: boolean) => Promise<Started>;
  openEditor?: (port: number) => Promise<void>;
  wait: () => Promise<void>;
  attempts: number;
};

export interface PreviewResult {
  previewUrl: string;
  studioUrl?: string;
  ready: boolean;
  service: string;
  version: string;
  dataDirectory?: string;
  reused?: boolean;
  engine?: string;
  previewTarget?: string;
}

const OPENMOTION_SERVICES = new Set(['api', 'motion-preview', 'openmotion']);

function isOpenMotionHealth(data: unknown): data is Record<string, any> {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as Record<string, unknown>).service === 'string' &&
    OPENMOTION_SERVICES.has((data as Record<string, string>).service)
  );
}

function buildHealth(origin: string, data: Record<string, any>, ready: boolean): Health {
  return {
    service: 'motion-preview',
    protocol: 2,
    version: typeof data.version === 'string' && data.version ? data.version : VERSION,
    ready,
    editorReady: ready,
    studioUrl: origin,
    dataDirectory: process.env.MOTION_DATA_DIR,
  };
}

export async function probe(port: number): Promise<Probe> {
  const origin = `http://127.0.0.1:${port}`;
  // 1. Prefer /api/health/ready so readiness is gated on Postgres/Redis health
  for (const healthPath of ['/api/health/ready', '/api/health']) {
    try {
      const res = await fetch(`${origin}${healthPath}`, { signal: AbortSignal.timeout(1200) });
      if (res.ok || res.status === 503) {
        const data = await res.json().catch(() => null);
        if (!isOpenMotionHealth(data)) {
          return { kind: 'busy' };
        }
        const isReady = res.ok && data.ok !== false;
        return {
          kind: 'motion',
          health: buildHealth(origin, data, isReady),
        };
      }
    } catch (error: any) {
      const code = error?.cause?.code || error?.code;
      if (code === 'ECONNREFUSED') return { kind: 'free' };
      if (code === 'EPERM' || code === 'EACCES') {
        throw new Error('Local preview permission denied. Please check local execution permissions.');
      }
    }
  }

  // 2. Fallback to /api/health/live only to detect that the port is ours (not ready)
  try {
    const res = await fetch(`${origin}/api/health/live`, { signal: AbortSignal.timeout(1200) });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (!isOpenMotionHealth(data)) {
        return { kind: 'busy' };
      }
      return {
        kind: 'motion',
        health: buildHealth(origin, data, false),
      };
    }
  } catch (error: any) {
    const code = error?.cause?.code || error?.code;
    if (code === 'ECONNREFUSED') return { kind: 'free' };
    if (code === 'EPERM' || code === 'EACCES') {
      throw new Error('Local preview permission denied. Please check local execution permissions.');
    }
  }

  return { kind: 'busy' };
}

async function launch(port: number, directory: string, _log?: string, background = true): Promise<Started> {
  let message = '';
  let closed = false;

  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', path.join(pluginRoot, 'server.ts')],
    {
      cwd: pluginRoot,
      detached: background,
      stdio: 'ignore',
      env: {
        DATABASE_URL:
          process.env.DATABASE_URL ||
          'postgresql://openmotion:openmotion_local_dev@127.0.0.1:5432/openmotion',
        REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
        AUTH_MODE: process.env.AUTH_MODE || 'dev',
        BIND_HOST: '127.0.0.1',
        ...process.env,
        PORT: String(port),
        MOTION_DATA_DIR: directory,
        MOTION_HEADLESS: background ? '1' : '0',
      },
    },
  );

  child.on('error', (err) => {
    message = err.message;
    closed = true;
  });
  child.on('exit', () => {
    closed = true;
  });

  if (background) {
    child.unref();
  }

  return {
    pid: child.pid,
    alive: () => !closed,
    error: () => message,
    stop: () => {
      if (!closed) child.kill('SIGTERM');
    },
  };
}

const defaultRuntime: PreviewRuntime = {
  probe,
  launch,
  wait: () => new Promise((resolve) => setTimeout(resolve, 150)),
  attempts: 10,
};

function initialPort(): number {
  const value = Number(process.env.PORT || 4173);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error('PORT must be an integer between 1024 and 65535');
  }
  return value;
}

export async function previewUrl(_store?: { directory: string }): Promise<string> {
  const port = initialPort();
  return `http://127.0.0.1:${port}`;
}

export async function openPreview(
  store?: { directory: string; projectId?: string },
  environment: PreviewRuntime = defaultRuntime,
  _options: { editor?: boolean; mcpTool?: string } = { editor: true },
): Promise<PreviewResult> {
  const port = initialPort();
  const directory = store?.directory || process.env.MOTION_DATA_DIR;

  const current = await environment.probe(port);
  let reused = false;
  let ready = false;
  let pid: number | undefined;

  if (current.kind === 'motion' && current.health.ready) {
    reused = true;
    ready = true;
  } else if (current.kind === 'busy') {
    throw new Error(`Port ${port} is occupied by another service.`);
  } else {
    let started: Started | undefined;
    try {
      if (current.kind === 'free') {
        started = await environment.launch(port, directory || process.cwd());
        pid = started.pid;
      }

      for (let i = 0; i < environment.attempts; i++) {
        if (started && !started.alive()) {
          break;
        }
        const probed = await environment.probe(port);
        if (probed.kind === 'motion' && probed.health.ready) {
          reused = current.kind === 'motion';
          ready = true;
          break;
        }
        await environment.wait();
      }
    } catch (err) {
      started?.stop();
      throw err;
    }

    if (!ready) {
      const detail = started?.error();
      started?.stop();
      throw new Error(
        detail
          ? `OpenMotion service failed to become ready on port ${port}: ${detail}`
          : `OpenMotion service failed to become ready on port ${port}.`,
      );
    }
  }

  if (directory) {
    try {
      await mkdir(directory, { recursive: true });
      const previewJson = path.join(directory, 'preview.json');
      const temp = `${previewJson}.${crypto.randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify({ port, pid, version: VERSION }), { mode: 0o600 });
      await rename(temp, previewJson);
    } catch {
      // Non-fatal if data directory is read-only
    }
  }

  const origin = `http://127.0.0.1:${port}`;
  return {
    previewUrl: origin,
    studioUrl: `${origin}/`,
    ready,
    service: 'motion-preview',
    version: VERSION,
    dataDirectory: directory,
    reused,
    engine: 'hyperframes',
    previewTarget: 'host-built-in-browser',
  };
}

export async function ensureService(
  store?: { directory: string; projectId?: string },
  environment: PreviewRuntime = defaultRuntime,
  mcpTool?: string,
): Promise<PreviewResult> {
  return openPreview(store, environment, { editor: false, mcpTool });
}

if (isMain(import.meta.url)) {
  try {
    const result = await openPreview();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
