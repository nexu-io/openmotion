import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentAuth, AgentDefinition, AgentModel } from '../shared/local-agents.ts';

export type Probe = (bin: string, args: string[]) => Promise<{ ok: boolean; text: string }>;
/** npm's Windows shims are not executables. Resolve the script without running a shell. */
export async function agentInvocation(bin: string, args: string[]): Promise<{ bin: string; args: string[] }> {
  if (!/\.cmd$/i.test(bin)) return { bin, args };
  const source = await readFile(bin, 'utf8');
  const relative = source.match(/"%(?:dp0|~dp0)%?\\([^"\r\n]+\.(?:[cm]?js))"/i)?.[1];
  if (!relative || relative.includes('..') || /[%!]/.test(relative)) throw new Error('Unsupported CLI shim; use the official executable');
  return { bin: process.execPath, args: [path.resolve(path.dirname(bin), ...relative.split('\\')), ...args] };
}
export const probeAgent: Probe = async (bin, args) => {
  try {
    const command = await agentInvocation(bin, args);
    return await new Promise(resolve => execFile(command.bin, command.args, { timeout: 12_000, maxBuffer: 12 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => resolve({ ok: !error, text: stdout || stderr })));
  } catch { return { ok: false, text: '' }; }
};
const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
export const validModelId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+ -]{0,199}$/.test(value);
export function normalizeAgentModels(input: unknown[], source: AgentModel['source'] = 'cli'): AgentModel[] {
  const seen = new Set<string>();
  return input.flatMap((value: any) => {
    if (!value || value.visibility === 'hide') return [];
    const id = typeof value === 'string' ? value : value.slug ?? value.modelId ?? value.id ?? value.value;
    if (!validModelId(id) || seen.has(id) || id === 'default') return [];
    seen.add(id);
    const title = value.display_name ?? value.name ?? value.label;
    const reasoning = Array.isArray(value.supported_reasoning_levels) ? value.supported_reasoning_levels.map((r: any) => r.effort).filter(validModelId) : undefined;
    return [{ id, label: typeof title === 'string' ? title.slice(0, 180) : id, source, ...(reasoning?.length ? { reasoning } : {}) }];
  }).slice(0, 1500);
}
export function parseAgentModels(kind: AgentDefinition['discovery'], raw: string): AgentModel[] {
  const text = stripAnsi(raw);
  if (kind === 'codex') { const value = JSON.parse(text); return normalizeAgentModels(Array.isArray(value) ? value : value.models ?? []); }
  if (kind === 'help') {
    const choices = text.match(/--model[^\n]*?Currently supported:\s*\(([^)]*)\)/i)?.[1];
    return normalizeAgentModels(choices?.split(',').map(value => value.trim()) ?? []);
  }
  if (kind === 'pi') return normalizeAgentModels(text.split('\n').flatMap(line => {
    const cells = line.trim().split(/\s+/); return cells.length >= 3 && cells[0] !== 'provider' && /^[\w-]+$/.test(cells[0]) && validModelId(cells[1]) ? [`${cells[0]}/${cells[1]}`] : [];
  }));
  return normalizeAgentModels(text.split('\n').flatMap(line => {
    // Account/status prose must never become a selectable model.
    const id = line.trim().replace(/^[*•-]\s+/, '').split(/\s+(?:-|\()/)[0];
    return /^[\w][\w./:@+-]+$/.test(id) && (id.includes('/') || /[.-]/.test(id) || id === 'auto') ? [id] : [];
  }));
}
export function parseAgentAuth(id: string, ok: boolean, raw: string): AgentAuth {
  try { const value = JSON.parse(raw); if (typeof value.loggedIn === 'boolean') return value.loggedIn ? 'signed-in' : 'signed-out'; } catch { /* text CLI */ }
  const text = stripAnsi(raw);
  if (/not (?:logged in|authenticated)|authentication required|please (?:log|sign) in|no credentials|expired token/i.test(text)) return 'signed-out';
  if (ok && /logged in|authenticated/i.test(text)) return 'signed-in';
  return 'unknown';
}
export async function qwenModels(): Promise<AgentModel[]> {
  const file = process.env.QWEN_SETTINGS_FILE || path.join(os.homedir(), '.qwen/settings.json');
  if ((await stat(file)).size > 1024 * 1024) return [];
  const value = JSON.parse(await readFile(file, 'utf8'));
  const entries = Object.values(value.modelProviders ?? {}).flatMap((list: any) => Array.isArray(list) ? list.map(item => ({ id: item.id, label: item.name })) : []);
  if (typeof value.model === 'string') entries.push({ id: value.model, label: value.model });
  else if (value.model?.name) entries.push({ id: value.model.name, label: value.model.name });
  return normalizeAgentModels(entries);
}

/** ACP discovery performs initialize + session/new only. No prompt or tool execution is sent. */
export async function discoverAcp(bin: string, args: string[]): Promise<{ models: AgentModel[]; auth: AgentAuth }> {
  const command = await agentInvocation(bin, args);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmotion-agent-probe-'));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command.bin, command.args, { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let finished = false, buffer = '', bytes = 0;
      const finish = (error?: Error, value?: { models: AgentModel[]; auth: AgentAuth }) => {
        if (finished) return; finished = true; clearTimeout(timer); child.kill();
        const force = setTimeout(() => child.kill('SIGKILL'), 500); force.unref();
        const settle = () => { clearTimeout(force); error ? reject(error) : resolve(value!); };
        if (child.exitCode !== null || child.signalCode !== null || !child.pid) settle();
        else child.once('close', settle);
      };
      const timer = setTimeout(() => finish(new Error('Agent model discovery timed out')), 12_000);
      const send = (id: number, method: string, params: unknown) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      child.stderr.resume(); child.stdin.on('error', () => {});
      child.once('error', () => finish(new Error('Could not start Agent model discovery')));
      child.once('exit', () => finish(new Error('Agent closed model discovery')));
      child.stdout.on('data', chunk => {
        bytes += chunk.length; if (bytes > 2 * 1024 * 1024) return finish(new Error('Agent model response is too large'));
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf('\n'); if (end < 0) break;
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const message = JSON.parse(line);
            if (message.method && message.id !== undefined) {
              // Decline any server-initiated operation during discovery.
              child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Discovery does not support client operations' } }) + '\n');
            } else if (message.error) {
              const auth = /auth|login|sign.?in/i.test(message.error.message ?? '') ? 'signed-out' : 'unknown';
              if (auth === 'signed-out') finish(undefined, { models: [], auth });
              else finish(new Error('Agent could not list models'));
            } else if (message.id === 1) send(2, 'session/new', { cwd: directory, mcpServers: [] });
            else if (message.id === 2) {
              const result = message.result ?? {};
              const config = (result.configOptions ?? []).filter((item: any) => item.category === 'model' || item.id === 'model').flatMap((item: any) => (item.options ?? []).flatMap((option: any) => option.options ?? [option]));
              finish(undefined, { models: normalizeAgentModels(result.models?.availableModels ?? config), auth: 'unknown' });
            }
          } catch { /* Ignore non-protocol diagnostics; the bounded timeout remains active. */ }
        }
      });
      send(1, 'initialize', { protocolVersion: 1, clientInfo: { name: 'openmotion-model-discovery', version: '1' }, clientCapabilities: {} });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
