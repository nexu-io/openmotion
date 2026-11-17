import path from 'node:path';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import { localAgents, type AgentChoice, type AgentDirectory, type AgentLaunch, type LocalAgent } from '../shared/local-agents.ts';
import { resolveAgent } from './agents.ts';
import { discoverAcp, normalizeAgentModels, parseAgentAuth, parseAgentModels, probeAgent, qwenModels, validModelId, type Probe } from './agent-discovery.ts';
import { readSettings, writeSettings } from './settings-storage.ts';
import { launchTerminal, terminalCommand } from './agent-terminal.ts';

export async function resolveLocalAgent(bin: string): Promise<string | null> {
  const found = await resolveAgent(bin); if (found) return found;
  const names = bin === 'cursor-agent' ? ['cursor-agent', 'agent'] : [bin];
  const dirs = [...(process.env.PATH || '').split(path.delimiter).filter(dir => path.isAbsolute(dir)), path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.bun/bin'), path.join(os.homedir(), '.cargo/bin'), path.join(os.homedir(), '.npm-global/bin'), ...(process.platform === 'win32' && process.env.APPDATA ? [path.join(process.env.APPDATA, 'npm')] : [])];
  for (const dir of dirs) for (const name of names) for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd'] : ['']) {
    const file = path.join(dir, name + suffix);
    try { await access(file, constants.X_OK); return file; } catch { /* next */ }
  }
  return null;
}
export class LocalAgentDirectory {
  readonly file: string;
  cache = new Map<string, LocalAgent>();
  pending = new Map<string, Promise<LocalAgent>>();
  private queue = Promise.resolve();
  readonly directory: string;
  readonly resolve: typeof resolveLocalAgent;
  readonly probe: Probe;
  readonly terminal: typeof launchTerminal;
  constructor(directory: string, resolve = resolveLocalAgent, probe: Probe = probeAgent, terminal = launchTerminal) {
    this.directory = directory; this.resolve = resolve; this.probe = probe; this.terminal = terminal;
    this.file = path.join(directory, 'agents/preferences.json');
  }
  async preferences(): Promise<{ default: AgentChoice | null; custom: Record<string, string[]> }> { return readSettings(this.file, { default: null, custom: {} }); }
  async list(): Promise<AgentDirectory> {
    const prefs = await this.preferences();
    const agents = await Promise.all(localAgents.map(async agent => {
      const installed = Boolean(await this.resolve(agent.bin)), cached = this.cache.get(agent.id);
      return { ...agent, ...(installed ? cached : undefined), installed, auth: installed ? cached?.auth ?? 'unknown' : 'unknown', models: [...(installed ? cached?.models ?? [] : []), ...normalizeAgentModels(prefs.custom[agent.id] ?? [], 'custom')].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index) } as LocalAgent;
    }));
    return { agents, default: prefs.default };
  }
  inspect(id: string): Promise<LocalAgent> {
    if (this.pending.has(id)) return this.pending.get(id)!;
    const work = this.probeOne(id).finally(() => this.pending.delete(id)); this.pending.set(id, work); return work;
  }
  private async probeOne(id: string): Promise<LocalAgent> {
    const def = localAgents.find(agent => agent.id === id); if (!def) throw new Error('Unknown Agent');
    const bin = await this.resolve(def.bin);
    const result: LocalAgent = { ...def, installed: Boolean(bin), auth: 'unknown', models: [], checkedAt: new Date().toISOString() };
    if (!bin) { this.cache.delete(id); return result; }
    const [version, help] = await Promise.all([this.probe(bin, ['--version']), this.probe(bin, [...(def.startArgs ?? []), '--help'])]);
    result.version = version.ok ? version.text.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?\b/)?.[0] : undefined;
    // Do not pass a model flag to an older CLI that does not advertise it.
    result.modelFlag = help.ok && /--model\b/.test(help.text) ? '--model' : undefined;
    const authArgs = id === 'codex' ? ['login', 'status'] : ['claude', 'openclaude'].includes(id) ? ['auth', 'status'] : id === 'cursor-agent' ? ['status'] : undefined;
    if (authArgs) { const auth = await this.probe(bin, authArgs); result.auth = parseAgentAuth(id, auth.ok, auth.text); }
    try {
      if (def.discovery === 'codex') {
        const models = await this.probe(bin, ['debug', 'models']);
        if (!models.ok) throw new Error('Model discovery unavailable'); result.models = parseAgentModels('codex', models.text);
      } else if (def.discovery === 'claude') result.models = normalizeAgentModels(['sonnet', 'opus', 'haiku'], 'alias');
      else if (def.discovery === 'qwen') result.models = await qwenModels();
      else if (def.discovery === 'acp') { const data = await discoverAcp(bin, def.acpArgs!); result.models = data.models; if (data.auth !== 'unknown') result.auth = data.auth; }
      else if (def.discovery === 'help') result.models = parseAgentModels('help', help.text);
      else if (def.modelArgs) { const data = await this.probe(bin, def.modelArgs); if (!data.ok) throw new Error('Model discovery unavailable'); result.models = parseAgentModels(def.discovery, data.text); }
    } catch { result.discoveryError = 'Could not discover models. Sign in or update the Agent, then refresh.'; }
    this.cache.set(id, result); return result;
  }
  private change(fn: () => Promise<void>) { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  async addModel(id: string, model: unknown) {
    if (!localAgents.some(agent => agent.id === id) || !validModelId(model) || model === 'default') throw new Error('Invalid Agent model ID');
    await this.change(async () => { const prefs = await this.preferences(); prefs.custom[id] = [...new Set([...(prefs.custom[id] ?? []), model])].slice(0, 100); await writeSettings(this.file, prefs); });
  }
  async choose(choice: AgentChoice | null) {
    if (choice) await this.validate(choice);
    await this.change(async () => { const prefs = await this.preferences(); prefs.default = choice; await writeSettings(this.file, prefs); });
  }
  private async validate(choice: AgentChoice) {
    if (!choice || !localAgents.some(agent => agent.id === choice.agent) || !validModelId(choice.model)) throw new Error('Invalid Agent selection');
    if (!this.cache.has(choice.agent)) await this.inspect(choice.agent);
    const agent = (await this.list()).agents.find(agent => agent.id === choice.agent)!;
    if (!agent.installed) throw new Error('Install the Agent first');
    if (agent.auth === 'signed-out') throw new Error('Sign in to the Agent first');
    const model = agent.models.find(model => model.id === choice.model);
    if (choice.model !== 'default' && !model) throw new Error('Refresh models or add the exact model ID');
    if (choice.reasoning && !model?.reasoning?.includes(choice.reasoning)) throw new Error('Unsupported reasoning level');
    return agent;
  }
  async prepare(choice: AgentChoice, cwd: string, previewUrl: string, action: 'login' | 'launch'): Promise<AgentLaunch> {
    const def = localAgents.find(agent => agent.id === choice.agent); if (!def) throw new Error('Unknown Agent');
    const bin = await this.resolve(def.bin); if (!bin) throw new Error('Install the Agent first');
    const agent = action === 'launch' ? await this.validate(choice) : undefined;
    const args = [...(action === 'login' ? def.loginArgs ?? def.startArgs ?? [] : def.startArgs ?? [])];
    const modelInCommand = action === 'launch' && choice.model !== 'default' && Boolean(agent?.modelFlag);
    if (modelInCommand) args.push(agent!.modelFlag!, choice.model);
    if (action === 'launch' && choice.reasoning && choice.agent === 'codex') args.push('-c', `model_reasoning_effort="${choice.reasoning}"`);
    const instruction = `Connect this Agent to OpenMotion using ${previewUrl}/connect/guide?host=${choice.agent === 'codex' || choice.agent === 'claude' ? choice.agent : choice.agent === 'deepseek-harness' ? 'deepseek' : 'mcp'}. Verify access to the current project before editing. ${choice.model !== 'default' ? `Use model ${choice.model}${choice.reasoning ? ` with ${choice.reasoning} reasoning` : ''}. ` : ''}Keep the Agent's normal approval controls enabled.`;
    return { command: terminalCommand(bin, args, cwd), instruction, modelInCommand, terminalAvailable: ['darwin', 'win32', 'linux'].includes(process.platform) };
  }
  async open(choice: AgentChoice, cwd: string, previewUrl: string, action: 'login' | 'launch') {
    const plan = await this.prepare(choice, cwd, previewUrl, action);
    await this.terminal(this.directory, plan.command); return plan;
  }
}
const directories = new Map<string, LocalAgentDirectory>();
export function localAgentsFor(directory: string) { let value = directories.get(directory); if (!value) { value = new LocalAgentDirectory(directory); directories.set(directory, value); } return value; }
