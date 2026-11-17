/** Local CLI identities, not model-server providers. See docs/local-agents.md for sources. */
export type AgentModel = { id: string; label: string; source: 'cli' | 'alias' | 'custom'; reasoning?: string[] };
export type AgentAuth = 'signed-in' | 'signed-out' | 'unknown';
export type AgentDefinition = {
  id: string; label: string; bin: string; icon: string; website: string;
  loginArgs?: string[]; loginHint?: string; startArgs?: string[];
  discovery?: 'codex' | 'lines' | 'pi' | 'acp' | 'claude' | 'qwen' | 'help';
  modelArgs?: string[]; acpArgs?: string[]; modelFlag?: string;
};
export type LocalAgent = AgentDefinition & { installed: boolean; version?: string; auth: AgentAuth; checkedAt?: string; models: AgentModel[]; modelFlag?: string; discoveryError?: string };
export type AgentChoice = { agent: string; model: string; reasoning?: string };
export type AgentDirectory = { agents: LocalAgent[]; default: AgentChoice | null };
export type AgentLaunch = { command: string; instruction: string; modelInCommand: boolean; terminalAvailable: boolean };

export const localAgents: AgentDefinition[] = [
  { id: 'codex', label: 'Codex', bin: 'codex', icon: 'codex', website: 'https://github.com/openai/codex', loginArgs: ['login'], discovery: 'codex', modelFlag: '--model' },
  { id: 'claude', label: 'Claude Code', bin: 'claude', icon: 'claude-code', website: 'https://code.claude.com/docs/en/setup', loginArgs: ['auth', 'login'], discovery: 'claude', modelFlag: '--model' },
  { id: 'kimi', label: 'Kimi Code', bin: 'kimi', icon: 'kimi', website: 'https://github.com/MoonshotAI/kimi-code', loginHint: 'Run /login in the Agent', discovery: 'acp', acpArgs: ['acp'] },
  { id: 'opencode', label: 'OpenCode', bin: 'opencode', icon: 'opencode', website: 'https://opencode.ai/docs/', loginArgs: ['auth', 'login'], discovery: 'lines', modelArgs: ['models'], modelFlag: '--model' },
  { id: 'gemini', label: 'Gemini CLI', bin: 'gemini', icon: 'gemini', website: 'https://github.com/google-gemini/gemini-cli', loginHint: 'Sign in on first launch', modelFlag: '--model' },
  { id: 'cursor-agent', label: 'Cursor Agent', bin: 'cursor-agent', icon: 'cursor-agent', website: 'https://cursor.com/docs/cli/overview', loginArgs: ['login'], discovery: 'lines', modelArgs: ['models'], modelFlag: '--model' },
  { id: 'copilot', label: 'GitHub Copilot CLI', bin: 'copilot', icon: 'copilot', website: 'https://github.com/github/copilot-cli', loginHint: 'Run /login in the Agent', modelFlag: '--model' },
  { id: 'deepseek-harness', label: 'DeepSeek Harness', bin: 'dsh', icon: 'deepseek', website: 'https://github.com/deepseek-ai/deepseek-harness', loginHint: 'Configure the Agent using its official guide' },
  { id: 'qwen', label: 'Qwen Code', bin: 'qwen', icon: 'qwencloud', website: 'https://github.com/QwenLM/qwen-code', loginHint: 'Sign in on first launch', discovery: 'qwen', modelFlag: '--model' },
  { id: 'pi', label: 'Pi', bin: 'pi', icon: 'pi', website: 'https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent', loginHint: 'Run /login in the Agent', discovery: 'pi', modelArgs: ['--list-models'], modelFlag: '--model' },
  { id: 'hermes', label: 'Hermes Agent', bin: 'hermes', icon: 'hermes', website: 'https://hermes-agent.nousresearch.com/docs/', loginArgs: ['setup'], modelFlag: '--model' },
  { id: 'antigravity', label: 'Antigravity', bin: 'agy', icon: 'antigravity', website: 'https://antigravity.google/cli', loginHint: 'Sign in on first launch' },
  { id: 'kiro', label: 'Kiro CLI', bin: 'kiro-cli', icon: 'kiro', website: 'https://kiro.dev/docs/cli/', loginArgs: ['login'], startArgs: ['chat'], discovery: 'acp', acpArgs: ['acp'] },
  { id: 'kilo', label: 'Kilo Code', bin: 'kilo', icon: 'kilo', website: 'https://kilo.ai/docs/cli', loginHint: 'Sign in on first launch', discovery: 'acp', acpArgs: ['acp'] },
  { id: 'vibe', label: 'Mistral Vibe', bin: 'vibe', icon: 'mistral', website: 'https://github.com/mistralai/mistral-vibe', loginHint: 'Configure the Agent using its official guide' },
  { id: 'amp', label: 'Amp', bin: 'amp', icon: 'amp', website: 'https://ampcode.com/manual#install', loginHint: 'Sign in on first launch' },
  { id: 'devin', label: 'Devin', bin: 'devin', icon: 'devin', website: 'https://cli.devin.ai/docs', loginHint: 'Sign in on first launch' },
  { id: 'grok-build', label: 'Grok Build', bin: 'grok', icon: 'grok', website: 'https://x.ai/cli', loginArgs: ['login', '--oauth'], discovery: 'lines', modelArgs: ['models'], modelFlag: '--model' },
  { id: 'codebuddy', label: 'CodeBuddy Code', bin: 'codebuddy', icon: 'codebuddy', website: 'https://www.codebuddy.cn', loginHint: 'Sign in on first launch', discovery: 'help', modelFlag: '--model' },
  { id: 'qoder', label: 'Qoder CLI', bin: 'qodercli', icon: 'qoder', website: 'https://qoder.com/download', loginArgs: ['login'], modelFlag: '--model' },
  { id: 'trae-cli', label: 'Trae CLI', bin: 'traecli', icon: 'trae', website: 'https://www.volcengine.com/docs/86677/2227861?lang=zh', loginHint: 'Sign in on first launch', discovery: 'acp', acpArgs: ['acp', 'serve'] },
  { id: 'mimo', label: 'MiMo Code', bin: 'mimo', icon: 'mimo', website: 'https://mimo.ai', loginHint: 'Sign in on first launch' },
  { id: 'aider', label: 'Aider', bin: 'aider', icon: 'aider', website: 'https://aider.chat/docs/install.html', loginHint: 'Configure the Agent using its official guide', modelFlag: '--model' },
  { id: 'atomcode', label: 'AtomCode', bin: 'atomcode', icon: 'atomcode', website: 'https://atomcode.atomgit.com/docs/en/quickstart.html', loginArgs: ['login'], modelFlag: '--model' },
  { id: 'deepseek', label: 'DeepSeek TUI', bin: 'deepseek', icon: 'deepseek', website: 'https://github.com/Hmbown/CodeWhale', loginHint: 'Configure the Agent using its official guide', modelFlag: '--model' },
  { id: 'reasonix', label: 'DeepSeek Reasonix', bin: 'reasonix', icon: 'deepseek', website: 'https://github.com/esengine/DeepSeek-Reasonix', loginHint: 'Configure the Agent using its official guide' },
  { id: 'openclaude', label: 'OpenClaude', bin: 'openclaude', icon: 'claude-code', website: 'https://openclaude.gitlawb.com/', loginHint: 'Sign in on first launch', discovery: 'claude', modelFlag: '--model' },
  { id: 'cline', label: 'Cline', bin: 'cline', icon: 'cline', website: 'https://github.com/cline/cline', loginHint: 'Configure the Agent using its official guide' },
  { id: 'bob', label: 'IBM Bob', bin: 'bob', icon: 'bob', website: 'https://www.ibm.com/products/bob', loginHint: 'Sign in on first launch' },
];
