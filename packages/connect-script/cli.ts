/**
 * K9 — Web Connect Script CLI Orchestrator (`--serve` & one-shot `--connect`).
 *
 * Operates strictly against the frozen `UniversalHostBridge` contract so Wave 2
 * can inject the concrete `packages/local-atoms` + `packages/signed-config`
 * runtime without modifying protocol, confirmation, or CLI orchestration logic.
 */

import {
  CONNECT_SCRIPT_DEFAULT_PORT,
  CONNECT_SCRIPT_PROTOCOL_VERSION,
} from '../../shared/connect-script-protocol.ts';
import {
  BUILTIN_TEMPLATE_MAP,
  BUILTIN_THIRD_PARTY_PROGRAMS,
  DEFAULT_MCP_SERVER_NAME,
  DEFAULT_STUDIO_URLS,
  isUrlInAllowedDomainScope,
  validateTypedPlaceholderValue,
  type BuiltinThirdPartyProgram,
} from '../../shared/desktop-builtin-rules.ts';
import {
  HOST_CAPABILITIES,
  HOST_CAPABILITY_VERSIONS,
  HOST_CONTRACT_VERSION,
  hostErr,
  type AtomDetectResult,
  type AtomExecParams,
  type AtomExecResult,
  type ConfirmationFact,
  type DetectedAgentCli,
  type HostCapabilityDescriptor,
  type HostConfirmationRequest,
  type HostInvokeResult,
  type HostPlatform,
  type HostReleaseChannel,
  type HostRuntimeInfo,
  type UniversalHostBridge,
} from '../../shared/desktop-contract.ts';
import {
  buildStudioPairingUrl,
  startConnectScriptServer,
  type ConnectScriptServerHandle,
} from './server.ts';
import { createTerminalConfirm, type ConfirmFn } from './terminal-confirm.ts';

export const CONNECT_SCRIPT_VERSION = '1.0.0' as const;
export const CONNECT_FEATURE_ID = 'mcp_connect' as const;
export const CONNECT_FEATURE_VERSION = '1.0.0' as const;

export type ConnectAgentTarget = BuiltinThirdPartyProgram | 'all';

export type ConnectCliArgs = {
  mode: 'connect' | 'serve' | 'help';
  target: ConnectAgentTarget;
  port: number;
  channel: HostReleaseChannel;
  allowDevLoopback: boolean;
  studioUrl: string;
  mcpUrl: string;
  hasStudioUrlOverride?: boolean;
  hasMcpUrlOverride?: boolean;
  serverName: string;
  replaceConflict: boolean;
  yes: boolean;
};

export type ConnectCliParseResult =
  | { ok: true; args: ConnectCliArgs }
  | { ok: false; error: string };

export type ConnectBridgeFactoryOptions = {
  channel: HostReleaseChannel;
  allowLocalDevLoopback: boolean;
  studioUrl?: string;
  expectedMcpUrl?: string;
  confirm: ConfirmFn;
};

export type ConnectBridgeFactory = (
  options: ConnectBridgeFactoryOptions,
) => Promise<UniversalHostBridge> | UniversalHostBridge;

export type ConnectAgentOutcome = {
  agentId: BuiltinThirdPartyProgram;
  status:
    | 'connected'
    | 'already_connected'
    | 'not_installed'
    | 'conflict_skipped'
    | 'failed'
    | 'cancelled';
  message: string;
  nextStep?: string;
};

export type ConnectFlowResult = {
  exitCode: number;
  cancelled: boolean;
  detectedAgents: DetectedAgentCli[];
  outcomes: ConnectAgentOutcome[];
};

export type ConnectCliRuntime = {
  createBridge: ConnectBridgeFactory;
  confirm?: ConfirmFn;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
  /** Optional hook invoked once `--serve` has bound its loopback port. */
  onServerStarted?: (handle: ConnectScriptServerHandle) => void | Promise<void>;
  /**
   * Optional signal registration hook for `--serve`. Defaults to registering
   * `SIGINT` and `SIGTERM` on `process`.
   */
  waitForShutdown?: (handle: ConnectScriptServerHandle) => Promise<void>;
};

const AGENT_ADD_TEMPLATES: Record<BuiltinThirdPartyProgram, string> = {
  codex: 'codex.mcp.add_remote',
  claude: 'claude.mcp.add_remote',
};

function isValidTarget(value: string): value is ConnectAgentTarget {
  return value === 'all' || value === 'codex' || value === 'claude';
}

function isValidChannel(value: string): value is HostReleaseChannel {
  return value === 'stable' || value === 'test' || value === 'dev';
}

function normalizeUrlForCompare(raw: string): string {
  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.origin}${pathname}${parsed.search}`;
  } catch {
    return raw.trim().replace(/\/+$/, '');
  }
}

function buildDefaultMcpUrl(studioUrl: string): string {
  return `${studioUrl.replace(/\/+$/, '')}/mcp`;
}

/**
 * Formats CLI usage instructions for `--help`.
 */
export function formatConnectCliHelp(): string {
  return [
    'OpenMotion Local Agent Connect Script',
    '',
    'Usage:',
    '  node --experimental-strip-types scripts/connect-local-agent.mjs [options]',
    '',
    'Modes:',
    '  --connect [codex|claude|all]   One-shot local CLI registration (default: all)',
    '  --serve                        Start localhost (127.0.0.1) bridge server for Cloud Studio',
    '  --help, -h                     Show this help message',
    '',
    'Options:',
    `  --port <number>                Loopback port for --serve (default: ${CONNECT_SCRIPT_DEFAULT_PORT})`,
    '  --channel <stable|test|dev>    Allowed Studio domain channel (default: stable)',
    '  --allow-dev-loopback           Allow http://127.0.0.1 / localhost origin (dev channel only)',
    '  --studio-url <url>             Override Cloud Studio base URL (within channel scope)',
    '  --mcp-url <url>                Override Cloud MCP URL (default: <studio-url>/mcp)',
    `  --server-name <name>           MCP server name (default: ${DEFAULT_MCP_SERVER_NAME})`,
    '  --replace-conflict             Replace an existing conflicting MCP server entry',
    '  --yes, -y                      Skip interactive [y/N] prompt (facts are still printed)',
  ].join('\n');
}

/**
 * Parses CLI argv into strongly typed options and validates all URLs, ports,
 * channels, and identifiers against the built-in shell security rules.
 */
export function parseConnectCliArgs(argv: readonly string[]): ConnectCliParseResult {
  let mode: 'connect' | 'serve' | 'help' = 'connect';
  let explicitConnect = false;
  let explicitServe = false;
  let target: ConnectAgentTarget = 'all';
  let port: number = CONNECT_SCRIPT_DEFAULT_PORT;
  let channel: HostReleaseChannel = 'stable';
  let allowDevLoopback = false;
  let studioUrlOverride: string | undefined;
  let mcpUrlOverride: string | undefined;
  let serverName: string = DEFAULT_MCP_SERVER_NAME;
  let replaceConflict = false;
  let yes = false;

  const readOptionValue = (index: number, inlineValue?: string): { value: string; nextIndex: number } | null => {
    if (inlineValue !== undefined) {
      return { value: inlineValue, nextIndex: index };
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('-')) {
      return null;
    }
    return { value: next, nextIndex: index + 1 };
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    if (raw === '--help' || raw === '-h') {
      mode = 'help';
      continue;
    }

    if (raw === '--serve') {
      explicitServe = true;
      mode = 'serve';
      continue;
    }

    if (raw === '--connect' || raw.startsWith('--connect=')) {
      explicitConnect = true;
      mode = 'connect';
      const inline = raw.startsWith('--connect=') ? raw.slice('--connect='.length) : undefined;
      if (inline !== undefined) {
        if (!isValidTarget(inline)) {
          return { ok: false, error: `Invalid --connect target "${inline}". Expected codex, claude, or all.` };
        }
        target = inline;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          if (!isValidTarget(next)) {
            return { ok: false, error: `Invalid --connect target "${next}". Expected codex, claude, or all.` };
          }
          target = next;
          i += 1;
        }
      }
      continue;
    }

    if (raw === '--allow-dev-loopback') {
      allowDevLoopback = true;
      continue;
    }

    if (raw === '--replace-conflict') {
      replaceConflict = true;
      continue;
    }

    if (raw === '--yes' || raw === '-y') {
      yes = true;
      continue;
    }

    const eqIdx = raw.indexOf('=');
    const flag = eqIdx === -1 ? raw : raw.slice(0, eqIdx);
    const inlineValue = eqIdx === -1 ? undefined : raw.slice(eqIdx + 1);

    if (flag === '--port') {
      const parsedOpt = readOptionValue(i, inlineValue);
      if (!parsedOpt) {
        return { ok: false, error: 'Option --port requires a numeric port value.' };
      }
      const parsedPort = Number(parsedOpt.value);
      if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
        return { ok: false, error: `Invalid --port "${parsedOpt.value}". Expected integer 0-65535.` };
      }
      port = parsedPort;
      i = parsedOpt.nextIndex;
      continue;
    }

    if (flag === '--channel') {
      const parsedOpt = readOptionValue(i, inlineValue);
      if (!parsedOpt || !isValidChannel(parsedOpt.value)) {
        return { ok: false, error: 'Option --channel must be one of: stable, test, dev.' };
      }
      channel = parsedOpt.value;
      i = parsedOpt.nextIndex;
      continue;
    }

    if (flag === '--studio-url') {
      const parsedOpt = readOptionValue(i, inlineValue);
      if (!parsedOpt) {
        return { ok: false, error: 'Option --studio-url requires a URL value.' };
      }
      studioUrlOverride = parsedOpt.value;
      i = parsedOpt.nextIndex;
      continue;
    }

    if (flag === '--mcp-url') {
      const parsedOpt = readOptionValue(i, inlineValue);
      if (!parsedOpt) {
        return { ok: false, error: 'Option --mcp-url requires a URL value.' };
      }
      mcpUrlOverride = parsedOpt.value;
      i = parsedOpt.nextIndex;
      continue;
    }

    if (flag === '--server-name') {
      const parsedOpt = readOptionValue(i, inlineValue);
      if (!parsedOpt) {
        return { ok: false, error: 'Option --server-name requires a value.' };
      }
      serverName = parsedOpt.value;
      i = parsedOpt.nextIndex;
      continue;
    }

    return { ok: false, error: `Unknown argument: ${raw}` };
  }

  if (mode === 'help') {
    const studioUrl = studioUrlOverride ?? DEFAULT_STUDIO_URLS[channel];
    return {
      ok: true,
      args: {
        mode: 'help',
        target,
        port,
        channel,
        allowDevLoopback: allowDevLoopback && channel === 'dev',
        studioUrl,
        mcpUrl: mcpUrlOverride ?? buildDefaultMcpUrl(studioUrl),
        hasStudioUrlOverride: Boolean(studioUrlOverride),
        hasMcpUrlOverride: Boolean(mcpUrlOverride),
        serverName,
        replaceConflict,
        yes,
      },
    };
  }

  if (explicitServe && explicitConnect) {
    return { ok: false, error: 'Cannot combine --serve and --connect in the same invocation.' };
  }

  const effectiveAllowDevLoopback = allowDevLoopback && channel === 'dev';
  const studioUrl = studioUrlOverride ?? DEFAULT_STUDIO_URLS[channel];
  const mcpUrl = mcpUrlOverride ?? buildDefaultMcpUrl(studioUrl);

  const scopeOpts = { channel, allowLocalDevLoopback: effectiveAllowDevLoopback };
  if (!isUrlInAllowedDomainScope(studioUrl, scopeOpts)) {
    return {
      ok: false,
      error: `Studio URL "${studioUrl}" is outside allowed domain scope for channel "${channel}".`,
    };
  }
  if (!isUrlInAllowedDomainScope(mcpUrl, scopeOpts)) {
    return {
      ok: false,
      error: `MCP URL "${mcpUrl}" is outside allowed domain scope for channel "${channel}".`,
    };
  }

  const validatedName = validateTypedPlaceholderValue('identifier', serverName, scopeOpts);
  if (!validatedName.ok) {
    return { ok: false, error: `Invalid --server-name: ${validatedName.reason}` };
  }

  return {
    ok: true,
    args: {
      mode,
      target,
      port,
      channel,
      allowDevLoopback: effectiveAllowDevLoopback,
      studioUrl,
      mcpUrl,
      hasStudioUrlOverride: Boolean(studioUrlOverride),
      hasMcpUrlOverride: Boolean(mcpUrlOverride),
      serverName: validatedName.value,
      replaceConflict,
      yes,
    },
  };
}

function resolveHostPlatform(): HostPlatform {
  if (process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux') {
    return process.platform;
  }
  return 'linux';
}

/**
 * Safe fallback bridge used when `packages/local-atoms` has not been wired yet.
 * Exposes accurate `info()` and `capabilities()` metadata while returning
 * `UNSUPPORTED` for any capability invocation.
 */
export function createStubConnectBridge(options: {
  channel?: HostReleaseChannel;
  reason?: string;
} = {}): UniversalHostBridge {
  const channel = options.channel ?? 'stable';
  const reason =
    options.reason ??
    'Local atoms engine (@openmotion/local-atoms) is not yet wired into this checkout.';

  const infoPayload: HostRuntimeInfo = {
    hostKind: 'connect-script',
    shellVersion: CONNECT_SCRIPT_VERSION,
    contractVersion: HOST_CONTRACT_VERSION,
    platform: resolveHostPlatform(),
    arch: process.arch,
    releaseChannel: channel,
    isPackaged: false,
    nodeVersion: process.version,
  };

  const capabilityList: HostCapabilityDescriptor[] = [
    HOST_CAPABILITIES.ATOM_DETECT,
    HOST_CAPABILITIES.ATOM_EXEC,
    HOST_CAPABILITIES.ATOM_INSTALL_COMPONENT,
    HOST_CAPABILITIES.ATOM_CREDENTIAL,
    HOST_CAPABILITIES.ATOM_CONFIG,
  ].map(name => ({
    name,
    version: HOST_CAPABILITY_VERSIONS[name],
    status: 'unavailable',
    reason,
  }));

  return {
    info: async () => infoPayload,
    capabilities: async () => capabilityList,
    invoke: async <T = unknown>(capability: string, method: string): Promise<HostInvokeResult<T>> =>
      hostErr('UNSUPPORTED', `${capability}.${method} is unavailable: ${reason}`),
    subscribe: () => () => {},
  };
}

function resolveCapabilityMethod(
  capabilities: readonly HostCapabilityDescriptor[],
  capabilityName: string,
  preferred: string,
  fallbacks: readonly string[],
): string {
  const descriptor = capabilities.find(item => item.name === capabilityName);
  const methods = descriptor?.methods;
  if (!methods || methods.length === 0) {
    return preferred;
  }
  if (methods.includes(preferred)) {
    return preferred;
  }
  for (const candidate of fallbacks) {
    if (methods.includes(candidate)) {
      return candidate;
    }
  }
  return methods[0]!;
}

function renderTemplateCommandPreview(
  templateId: string,
  args: Record<string, string>,
): string {
  const template = BUILTIN_TEMPLATE_MAP.get(templateId);
  if (!template) {
    return `${templateId}`;
  }
  const renderedArgv = template.argv.map(token =>
    token.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
      return args[key] ?? template.params[key]?.defaultValue ?? `{${key}}`;
    }),
  );
  return [template.program, ...renderedArgv].join(' ');
}

function buildNextOAuthStep(
  agentId: BuiltinThirdPartyProgram,
  serverName: string,
  studioUrl: string,
): string {
  if (agentId === 'codex') {
    return `Run \`codex mcp login ${serverName}\` (or start Codex) to complete browser OAuth sign-in with ${studioUrl}.`;
  }
  return `Start \`claude\` and run \`/mcp\`, select "${serverName}", and complete browser OAuth sign-in with ${studioUrl}.`;
}

function isAgentConflict(agent: DetectedAgentCli, targetMcpUrl: string): boolean {
  if (agent.mcpConflict === true) return true;
  if (!agent.mcpConfigured || !agent.mcpUrl) return false;
  return normalizeUrlForCompare(agent.mcpUrl) !== normalizeUrlForCompare(targetMcpUrl);
}

function isAgentAlreadyConnected(agent: DetectedAgentCli, targetMcpUrl: string): boolean {
  if (!agent.installed || !agent.mcpConfigured || agent.mcpConflict === true) return false;
  if (!agent.mcpUrl) return false;
  return normalizeUrlForCompare(agent.mcpUrl) === normalizeUrlForCompare(targetMcpUrl);
}

/**
 * Executes the one-shot `--connect [codex|claude|all]` flow against a
 * `UniversalHostBridge`: detects installed CLIs, checks MCP conflicts, prompts
 * for terminal confirmation with shell-computed facts, executes built-in
 * registration templates via `atom.exec`, and prints the next OAuth step.
 */
export async function runConnectFlow(options: {
  args: ConnectCliArgs;
  bridge: UniversalHostBridge;
  confirm: ConfirmFn;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
}): Promise<ConnectFlowResult> {
  const out = options.output ?? process.stdout;
  const errOut = options.errorOutput ?? process.stderr;
  const { args, bridge, confirm } = options;

  const capabilities = await bridge.capabilities();
  const detectMethod = resolveCapabilityMethod(capabilities, HOST_CAPABILITIES.ATOM_DETECT, 'detect', [
    'scan',
    'run',
  ]);
  const execMethod = resolveCapabilityMethod(capabilities, HOST_CAPABILITIES.ATOM_EXEC, 'run', [
    'exec',
  ]);

  out.write(`Detecting local Agent CLIs (target: ${args.target})...\n`);
  const detectResult = await bridge.invoke<AtomDetectResult>(
    HOST_CAPABILITIES.ATOM_DETECT,
    detectMethod,
    {},
  );

  if (!detectResult.ok) {
    errOut.write(
      `Failed to detect local Agent CLIs [${detectResult.error.code}]: ${detectResult.error.message}\n`,
    );
    return {
      exitCode: 1,
      cancelled: false,
      detectedAgents: [],
      outcomes: [],
    };
  }

  const detectedAgents = detectResult.data.agents;
  const targetAgents: BuiltinThirdPartyProgram[] =
    args.target === 'all' ? [...BUILTIN_THIRD_PARTY_PROGRAMS] : [args.target];

  const byId = new Map<string, DetectedAgentCli>(detectedAgents.map(a => [a.agentId, a]));

  const outcomes: ConnectAgentOutcome[] = [];
  const pendingRegistrations: Array<{
    agentId: BuiltinThirdPartyProgram;
    detected: DetectedAgentCli;
    templateId: string;
    hasConflict: boolean;
  }> = [];

  for (const agentId of targetAgents) {
    const detected = byId.get(agentId);
    if (!detected || !detected.installed) {
      out.write(`  - ${agentId}: not installed\n`);
      outcomes.push({
        agentId,
        status: 'not_installed',
        message: `${agentId} CLI is not installed on this machine.`,
      });
      continue;
    }

    const versionSuffix = detected.version ? ` (${detected.version})` : '';
    const conflict = isAgentConflict(detected, args.mcpUrl);
    const alreadyConnected = isAgentAlreadyConnected(detected, args.mcpUrl);

    if (alreadyConnected) {
      out.write(`  - ${agentId}${versionSuffix}: already configured for ${args.mcpUrl}\n`);
      outcomes.push({
        agentId,
        status: 'already_connected',
        message: `${agentId} is already configured for ${args.mcpUrl}.`,
        nextStep: buildNextOAuthStep(agentId, args.serverName, args.studioUrl),
      });
      continue;
    }

    if (conflict && !args.replaceConflict) {
      const existingUrl = detected.mcpUrl ?? 'another endpoint';
      out.write(
        `  - ${agentId}${versionSuffix}: CONFLICT — MCP server "${args.serverName}" already points to ${existingUrl}\n`,
      );
      outcomes.push({
        agentId,
        status: 'conflict_skipped',
        message: `Existing MCP entry points to ${existingUrl}. Re-run with --replace-conflict to replace it.`,
      });
      continue;
    }

    out.write(
      `  - ${agentId}${versionSuffix}: installed${conflict ? ' (conflict will be replaced)' : ''}\n`,
    );
    pendingRegistrations.push({
      agentId,
      detected,
      templateId: AGENT_ADD_TEMPLATES[agentId],
      hasConflict: conflict,
    });
  }

  const hasUnresolvedConflict = outcomes.some(o => o.status === 'conflict_skipped');
  const hasAlreadyConnected = outcomes.some(o => o.status === 'already_connected');

  if (pendingRegistrations.length === 0) {
    if (hasUnresolvedConflict) {
      errOut.write(
        '\nSkipped conflicting MCP entries. Pass --replace-conflict to overwrite existing entries.\n',
      );
      return { exitCode: 1, cancelled: false, detectedAgents, outcomes };
    }
    if (hasAlreadyConnected) {
      out.write('\nAll detected target CLIs are already connected.\n');
      for (const outcome of outcomes) {
        if (outcome.nextStep) {
          out.write(`Next step (${outcome.agentId}): ${outcome.nextStep}\n`);
        }
      }
      return { exitCode: 0, cancelled: false, detectedAgents, outcomes };
    }

    errOut.write('\nNo matching local Agent CLIs were found.\n');
    return { exitCode: 1, cancelled: false, detectedAgents, outcomes };
  }

  const facts: ConfirmationFact[] = [];
  for (const item of pendingRegistrations) {
    const commandPreview = renderTemplateCommandPreview(item.templateId, {
      serverName: args.serverName,
      mcpUrl: args.mcpUrl,
    });
    facts.push({
      kind: 'exec_program',
      label: `${item.agentId} CLI`,
      value: commandPreview,
    });
    if (item.detected.configPath) {
      facts.push({
        kind: 'modify_file',
        label: `${item.agentId} config`,
        value: item.detected.configPath,
      });
    }
  }
  facts.push({
    kind: 'connect_url',
    label: 'OpenMotion Cloud MCP',
    value: args.mcpUrl,
  });

  const confirmationRequest: HostConfirmationRequest = {
    featureId: CONNECT_FEATURE_ID,
    featureVersion: CONNECT_FEATURE_VERSION,
    featureTitle: 'Connect Local Agent CLI to OpenMotion Cloud MCP',
    facts,
  };

  out.write('\n');
  const approved = await confirm(confirmationRequest);
  if (!approved) {
    out.write('Cancelled. No local changes were made.\n');
    for (const item of pendingRegistrations) {
      outcomes.push({
        agentId: item.agentId,
        status: 'cancelled',
        message: 'Cancelled by user confirmation.',
      });
    }
    return { exitCode: 1, cancelled: true, detectedAgents, outcomes };
  }

  let anyFailure = hasUnresolvedConflict;

  for (const item of pendingRegistrations) {
    const execParams: AtomExecParams = {
      featureId: CONNECT_FEATURE_ID,
      templateId: item.templateId,
      args: {
        serverName: args.serverName,
        mcpUrl: args.mcpUrl,
      },
      conflictPolicy: item.hasConflict ? 'replace' : 'abort',
    };

    const execResult = await bridge.invoke<AtomExecResult>(
      HOST_CAPABILITIES.ATOM_EXEC,
      execMethod,
      execParams,
    );

    if (!execResult.ok) {
      anyFailure = true;
      errOut.write(
        `Failed to configure ${item.agentId} [${execResult.error.code}]: ${execResult.error.message}\n`,
      );
      outcomes.push({
        agentId: item.agentId,
        status: 'failed',
        message: `${execResult.error.code}: ${execResult.error.message}`,
      });
      continue;
    }

    if (execResult.data.exitCode !== 0) {
      anyFailure = true;
      const stderrSummary = execResult.data.stderr.trim() || `exit code ${execResult.data.exitCode}`;
      errOut.write(`Failed to configure ${item.agentId}: ${stderrSummary}\n`);
      outcomes.push({
        agentId: item.agentId,
        status: 'failed',
        message: stderrSummary,
      });
      continue;
    }

    const nextStep = buildNextOAuthStep(item.agentId, args.serverName, args.studioUrl);
    out.write(`Connected ${item.agentId} to ${args.mcpUrl}.\n`);
    outcomes.push({
      agentId: item.agentId,
      status: 'connected',
      message: `Registered MCP server "${args.serverName}" -> ${args.mcpUrl}.`,
      nextStep,
    });
  }

  const nextSteps = outcomes.filter(o => o.nextStep !== undefined);
  if (nextSteps.length > 0) {
    out.write('\nNext OAuth step:\n');
    for (const outcome of nextSteps) {
      out.write(`  - ${outcome.agentId}: ${outcome.nextStep}\n`);
    }
  }

  return {
    exitCode: anyFailure ? 1 : 0,
    cancelled: false,
    detectedAgents,
    outcomes,
  };
}

function defaultWaitForShutdown(handle: ConnectScriptServerHandle): Promise<void> {
  return new Promise(resolve => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      void handle.close().finally(() => resolve());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

/**
 * Starts the `--serve` loopback bridge host, prints the pairing URL and
 * one-time session token, and waits for clean shutdown (`SIGINT` / `SIGTERM`).
 */
export async function runServeFlow(options: {
  args: ConnectCliArgs;
  bridge: UniversalHostBridge;
  output?: NodeJS.WritableStream;
  onServerStarted?: (handle: ConnectScriptServerHandle) => void | Promise<void>;
  waitForShutdown?: (handle: ConnectScriptServerHandle) => Promise<void>;
}): Promise<number> {
  const out = options.output ?? process.stdout;
  const handle = await startConnectScriptServer({
    bridge: options.bridge,
    port: options.args.port,
    channel: options.args.channel,
    allowLocalDevLoopback: options.args.allowDevLoopback,
  });

  const pairingUrl = buildStudioPairingUrl({
    studioUrl: options.args.studioUrl,
    port: handle.port,
    token: handle.token,
  });

  out.write(
    [
      `OpenMotion Local Bridge listening on ${handle.baseUrl} (protocol v${CONNECT_SCRIPT_PROTOCOL_VERSION})`,
      `Channel:       ${handle.channel}${handle.allowLocalDevLoopback ? ' (dev loopback origin allowed)' : ''}`,
      `Session token: ${handle.token}`,
      `Pairing URL:   ${pairingUrl}`,
      '',
      'Open the Pairing URL in your browser (or paste the Session token into Cloud Studio).',
      'Press Ctrl+C to stop.',
      '',
    ].join('\n'),
  );

  if (options.onServerStarted) {
    await options.onServerStarted(handle);
  }

  const waiter = options.waitForShutdown ?? defaultWaitForShutdown;
  await waiter(handle);
  await handle.close();
  out.write('OpenMotion Local Bridge stopped.\n');
  return 0;
}

/**
 * Main CLI entrypoint shared by `scripts/connect-local-agent.mjs` and tests.
 */
export async function runConnectCli(
  argv: readonly string[],
  runtime: ConnectCliRuntime,
): Promise<number> {
  const out = runtime.output ?? process.stdout;
  const errOut = runtime.errorOutput ?? process.stderr;

  const parsed = parseConnectCliArgs(argv);
  if (!parsed.ok) {
    errOut.write(`Error: ${parsed.error}\n\n${formatConnectCliHelp()}\n`);
    return 2;
  }

  const { args } = parsed;
  if (args.mode === 'help') {
    out.write(`${formatConnectCliHelp()}\n`);
    return 0;
  }

  const confirm =
    runtime.confirm ??
    createTerminalConfirm({
      yes: args.yes,
      input: runtime.input,
      output: out,
    });

  const confirmedFingerprints = new Set<string>();
  const wrappedConfirm: ConfirmFn = async request => {
    // Only deduplicate duplicate prompts within one-shot `connect` mode, and ONLY
    // when featureId, featureVersion, and all concrete facts match verbatim.
    // In long-lived `--serve` mode, always delegate to `confirm` so changed feature
    // versions or facts after a `signedConfig.refresh` never bypass user approval.
    if (args.mode === 'serve') {
      return confirm(request);
    }
    const fingerprint = JSON.stringify({
      featureId: request.featureId,
      featureVersion: request.featureVersion,
      facts: request.facts,
    });
    if (confirmedFingerprints.has(fingerprint)) {
      return true;
    }
    const accepted = await confirm(request);
    if (accepted) {
      confirmedFingerprints.add(fingerprint);
    }
    return accepted;
  };

  const bridge = await runtime.createBridge({
    channel: args.channel,
    allowLocalDevLoopback: args.allowDevLoopback,
    ...(args.hasStudioUrlOverride ? { studioUrl: args.studioUrl } : {}),
    ...(args.hasMcpUrlOverride ? { expectedMcpUrl: args.mcpUrl } : {}),
    confirm: wrappedConfirm,
  });

  if (args.mode === 'serve') {
    return runServeFlow({
      args,
      bridge,
      output: out,
      onServerStarted: runtime.onServerStarted,
      waitForShutdown: runtime.waitForShutdown,
    });
  }

  const result = await runConnectFlow({
    args,
    bridge,
    confirm: wrappedConfirm,
    output: out,
    errorOutput: errOut,
  });
  return result.exitCode;
}
