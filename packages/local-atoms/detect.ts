/**
 * Atom 1: `atom.detect` — Read-only agent CLI & local Murmur engine detection (K7).
 *
 * Guarantees:
 * - Strictly read-only: NEVER writes files, NEVER runs mutating commands, NEVER acquires
 *   `SerialMutationQueue`, and NEVER prompts for user confirmation.
 * - Detects `codex`, `claude`, and any agents declared in verified `SignedConfigPayload.agents`.
 * - Probes `127.0.0.1:3425` with a short bounded HTTP GET (~800ms) to distinguish
 *   `murmur-personal` (`murmurant-personal-` identity prefix), `magpie-desktop`,
 *   `other-process`, or `none`.
 * - Optionally probes the `murmur` binary with read-only `status --json`, gracefully
 *   degrading if `schemaVersion` exceeds `MURMUR_STATUS_MAX_SCHEMA_VERSION`.
 */

import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalizeUrlForComparison,
  DEFAULT_MCP_SERVER_NAME,
} from '../../shared/desktop-builtin-rules.ts';
import {
  hostOk,
  type AtomDetectResult,
  type DetectedAgentCli,
  type DetectedEngineStatus,
  type HostInvokeResult,
  type HostPlatform,
} from '../../shared/desktop-contract.ts';
import {
  MURMUR_COMPONENT_ID,
  MURMUR_ENGINE_HOST,
  MURMUR_ENGINE_PORT,
  MURMUR_PERSONAL_IDENTITY_PREFIX,
  parseMurmurStatusJson,
} from '../../shared/engine-command-contract.ts';
import type { SignedConfigPayload } from '../../shared/signed-config.ts';
import { readMcpEntryFromFile, resolveSafeHomePath } from './config.ts';
import { defaultCommandRunner, type CommandRunner } from './exec.ts';
import type { ComponentInstallRegistry } from './install-component.ts';
import type { PathResolver } from './path-resolver.ts';

const DEFAULT_VERSION_TIMEOUT_MS = 3_000;
const DEFAULT_ENGINE_HTTP_TIMEOUT_MS = 800;
const DEFAULT_MURMUR_STATUS_TIMEOUT_MS = 2_000;
const MAX_PROBE_BODY_BYTES = 16 * 1024;

export type EngineHttpProbeResult =
  | {
      reachable: false;
      error?: string;
    }
  | {
      reachable: true;
      statusCode: number;
      headers: Record<string, string | undefined>;
      body: string;
    };

export type EngineHttpProbe = (
  host: string,
  port: number,
  timeoutMs: number,
) => Promise<EngineHttpProbeResult>;

export type AtomDetectParams = {
  expectedMcpUrl?: string;
  serverName?: string;
};

export type DetectAtomDeps = {
  platform?: HostPlatform;
  arch?: string;
  homeDir?: string;
  expectedMcpUrl?: string;
  getExpectedMcpUrl?: () => string | undefined;
  getSignedConfig: () => SignedConfigPayload;
  pathResolver: PathResolver;
  componentRegistry: ComponentInstallRegistry;
  commandRunner?: CommandRunner;
  engineHttpProbe?: EngineHttpProbe;
  versionTimeoutMs?: number;
  engineHttpTimeoutMs?: number;
  murmurStatusTimeoutMs?: number;
  now?: () => Date;
};

type AgentProbeSpec = {
  agentId: string;
  displayName?: string;
  binaryName: string;
  detectHomeDir?: string;
  connectMode: 'cli' | 'config';
  configRuleId?: string;
  configSpec?: {
    homeRelativePath: string;
    fileFormat: 'json' | 'toml';
    sectionPath: string;
  };
};

const DEFAULT_AGENT_SPECS: readonly AgentProbeSpec[] = [
  {
    agentId: 'codex',
    displayName: 'Codex',
    binaryName: 'codex',
    connectMode: 'cli',
    configRuleId: 'codex_mcp',
    configSpec: {
      homeRelativePath: '.codex/config.toml',
      fileFormat: 'toml',
      sectionPath: 'mcp_servers',
    },
  },
  {
    agentId: 'claude',
    displayName: 'Claude Code',
    binaryName: 'claude',
    connectMode: 'cli',
    configRuleId: 'claude_mcp',
    configSpec: {
      homeRelativePath: '.claude.json',
      fileFormat: 'json',
      sectionPath: 'mcpServers',
    },
  },
] as const;

function normalizePlatform(raw: NodeJS.Platform | HostPlatform): HostPlatform {
  if (raw === 'darwin' || raw === 'win32' || raw === 'linux') return raw;
  return 'linux';
}

function normalizeUrlForComparison(url: string): string {
  return canonicalizeUrlForComparison(url);
}

function deriveExpectedMcpUrl(
  params: AtomDetectParams | undefined,
  depsExpected: string | undefined,
  signedConfig: SignedConfigPayload,
): string | undefined {
  if (params?.expectedMcpUrl?.trim()) {
    return params.expectedMcpUrl.trim();
  }
  if (depsExpected?.trim()) {
    return depsExpected.trim();
  }
  if (signedConfig.studioUrl?.trim()) {
    return `${signedConfig.studioUrl.trim().replace(/\/+$/, '')}/mcp`;
  }
  return undefined;
}

function extractFirstLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export const defaultEngineHttpProbe: EngineHttpProbe = (host, port, timeoutMs) => {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: EngineHttpProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = http.get(
      {
        host,
        port,
        path: '/',
        timeout: timeoutMs,
      },
      res => {
        const headers: Record<string, string | undefined> = {};
        for (const [key, val] of Object.entries(res.headers)) {
          headers[key.toLowerCase()] = Array.isArray(val) ? val.join(', ') : val;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          if (bytes < MAX_PROBE_BODY_BYTES) {
            const slice = chunk.subarray(0, MAX_PROBE_BODY_BYTES - bytes);
            chunks.push(slice);
            bytes += slice.length;
          }
        });
        res.on('end', () => {
          finish({
            reachable: true,
            statusCode: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', error => {
          finish({ reachable: false, error: error.message });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      finish({ reachable: false, error: `Timed out after ${timeoutMs}ms` });
    });
    req.on('error', error => {
      finish({ reachable: false, error: error.message });
    });
  });
};

function classifyHttpProbe(probe: EngineHttpProbeResult): {
  running: boolean;
  providerKind: DetectedEngineStatus['providerKind'];
  mode?: DetectedEngineStatus['mode'];
  occupiedBy?: string;
} {
  if (!probe.reachable) {
    return { running: false, providerKind: 'none' };
  }

  const headerValues = [
    probe.headers['x-murmur-identity'],
    probe.headers['x-murmurant-identity'],
    probe.headers['server'],
    probe.headers['x-powered-by'],
    probe.headers['x-provider'],
  ]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' ');

  let parsedBody: Record<string, unknown> | null = null;
  try {
    const raw: unknown = JSON.parse(probe.body);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      parsedBody = raw as Record<string, unknown>;
    }
  } catch {
    parsedBody = null;
  }

  const identityCandidates = [
    headerValues,
    probe.body,
    typeof parsedBody?.identity === 'string' ? parsedBody.identity : '',
    typeof parsedBody?.service === 'string' ? parsedBody.service : '',
    typeof parsedBody?.server === 'string' ? parsedBody.server : '',
    typeof parsedBody?.provider === 'string' ? parsedBody.provider : '',
  ].join(' ');

  if (identityCandidates.includes(MURMUR_PERSONAL_IDENTITY_PREFIX)) {
    return {
      running: true,
      providerKind: 'murmur-personal',
      mode: 'personal',
    };
  }

  const lowerCombined = identityCandidates.toLowerCase();
  if (
    parsedBody?.desktopMagpieActive === true ||
    lowerCombined.includes('magpie-desktop') ||
    lowerCombined.includes('magpie')
  ) {
    return {
      running: true,
      providerKind: 'magpie-desktop',
      occupiedBy: 'magpie-desktop',
    };
  }

  const occupier =
    probe.headers['server']?.trim() ||
    probe.headers['x-powered-by']?.trim() ||
    (typeof parsedBody?.service === 'string' ? parsedBody.service : undefined) ||
    `http-${probe.statusCode}`;

  return {
    running: true,
    providerKind: 'other-process',
    occupiedBy: occupier,
  };
}

export class DetectAtom {
  private readonly platform: HostPlatform;
  private readonly arch: string;
  private readonly homeDir: string;
  private readonly expectedMcpUrl?: string;
  private readonly getExpectedMcpUrl?: () => string | undefined;
  private readonly getSignedConfig: () => SignedConfigPayload;
  private readonly pathResolver: PathResolver;
  private readonly componentRegistry: ComponentInstallRegistry;
  private readonly commandRunner: CommandRunner;
  private readonly engineHttpProbe: EngineHttpProbe;
  private readonly versionTimeoutMs: number;
  private readonly engineHttpTimeoutMs: number;
  private readonly murmurStatusTimeoutMs: number;
  private readonly now: () => Date;

  constructor(deps: DetectAtomDeps) {
    this.platform = normalizePlatform(deps.platform ?? process.platform);
    this.arch = deps.arch ?? process.arch;
    this.homeDir = deps.homeDir ?? os.homedir();
    this.expectedMcpUrl = deps.expectedMcpUrl;
    this.getExpectedMcpUrl = deps.getExpectedMcpUrl;
    this.getSignedConfig = deps.getSignedConfig;
    this.pathResolver = deps.pathResolver;
    this.componentRegistry = deps.componentRegistry;
    this.commandRunner = deps.commandRunner ?? defaultCommandRunner;
    this.engineHttpProbe = deps.engineHttpProbe ?? defaultEngineHttpProbe;
    this.versionTimeoutMs = deps.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
    this.engineHttpTimeoutMs = deps.engineHttpTimeoutMs ?? DEFAULT_ENGINE_HTTP_TIMEOUT_MS;
    this.murmurStatusTimeoutMs = deps.murmurStatusTimeoutMs ?? DEFAULT_MURMUR_STATUS_TIMEOUT_MS;
    this.now = deps.now ?? (() => new Date());
  }

  async scan(params?: AtomDetectParams): Promise<HostInvokeResult<AtomDetectResult>> {
    const signedConfig = this.getSignedConfig();
    const serverName = params?.serverName?.trim() || DEFAULT_MCP_SERVER_NAME;
    const dynamicExpected = this.getExpectedMcpUrl?.() ?? this.expectedMcpUrl;
    const expectedMcpUrl = deriveExpectedMcpUrl(params, dynamicExpected, signedConfig);
    const agentSpecs = this.collectAgentSpecs(signedConfig);

    const [agents, engine] = await Promise.all([
      Promise.all(agentSpecs.map(spec => this.probeAgent(spec, serverName, expectedMcpUrl))),
      this.probeEngine(),
    ]);

    return hostOk({
      platform: this.platform,
      arch: this.arch,
      agents,
      engine,
      detectedAt: this.now().toISOString(),
    });
  }

  private collectAgentSpecs(signedConfig: SignedConfigPayload): AgentProbeSpec[] {
    const byId = new Map<string, AgentProbeSpec>();
    for (const builtin of DEFAULT_AGENT_SPECS) {
      byId.set(builtin.agentId, builtin);
    }

    for (const agent of Object.values(signedConfig.agents ?? {})) {
      const existing = byId.get(agent.agentId);
      const configRule = agent.configRuleId ? signedConfig.configRules?.[agent.configRuleId] : undefined;
      byId.set(agent.agentId, {
        agentId: agent.agentId,
        displayName: agent.displayName ?? existing?.displayName,
        binaryName: agent.binaryName,
        detectHomeDir: agent.detectHomeDir ?? existing?.detectHomeDir,
        connectMode: agent.mcpAddTemplateId ? 'cli' : configRule ? 'config' : existing?.connectMode ?? 'cli',
        configRuleId: configRule?.ruleId ?? agent.configRuleId ?? existing?.configRuleId,
        configSpec: configRule
          ? {
              homeRelativePath: configRule.homeRelativePath,
              fileFormat: configRule.fileFormat,
              sectionPath: configRule.sectionPath,
            }
          : existing?.configSpec,
      });
    }

    return [...byId.values()];
  }

  private async probeAgent(
    spec: AgentProbeSpec,
    serverName: string,
    expectedMcpUrl: string | undefined,
  ): Promise<DetectedAgentCli> {
    const binaryPath = await this.pathResolver.resolveBinary(spec.binaryName);
    let version: string | undefined;

    if (binaryPath) {
      const mergedPath = await this.pathResolver.getExecutablePath();
      const result = await this.commandRunner({
        binaryPath,
        argv: ['--version'],
        timeoutMs: this.versionTimeoutMs,
        env: { ...process.env, PATH: mergedPath },
      });
      if (result.exitCode === 0 && !result.timedOut) {
        version = extractFirstLine(result.stdout) ?? extractFirstLine(result.stderr);
      }
    }

    let configPath: string | undefined;
    let mcpConfigured = false;
    let mcpUrl: string | undefined;
    let mcpConflict: boolean | undefined;

    if (spec.configSpec) {
      const safePath = resolveSafeHomePath(this.homeDir, spec.configSpec.homeRelativePath);
      if (safePath.ok) {
        configPath = safePath.resolvedPath;
        const readResult = readMcpEntryFromFile({
          filePath: configPath,
          fileFormat: spec.configSpec.fileFormat,
          sectionPath: spec.configSpec.sectionPath,
          serverName,
        });
        if (readResult.ok && readResult.exists && readResult.entry) {
          mcpConfigured = true;
          mcpUrl = readResult.entry.url;
          if (expectedMcpUrl) {
            // Existing legacy local-mode stdio entry (no url) is also a conflict against remote MCP.
            mcpConflict = !mcpUrl || normalizeUrlForComparison(mcpUrl) !== normalizeUrlForComparison(expectedMcpUrl);
          } else {
            mcpConflict = false;
          }
        }
      }
    }

    let detectDirExists = false;
    if (!binaryPath && spec.detectHomeDir) {
      const safeDetectDir = resolveSafeHomePath(this.homeDir, spec.detectHomeDir);
      if (safeDetectDir.ok && existsSync(safeDetectDir.resolvedPath)) {
        detectDirExists = true;
      }
    }

    return {
      agentId: spec.agentId,
      ...(spec.displayName ? { displayName: spec.displayName } : {}),
      installed: Boolean(binaryPath) || detectDirExists,
      ...(binaryPath ? { binaryPath } : {}),
      ...(version ? { version } : {}),
      mcpConfigured,
      ...(mcpUrl ? { mcpUrl } : {}),
      ...(mcpConflict !== undefined ? { mcpConflict } : {}),
      ...(configPath ? { configPath } : {}),
      connectMode: spec.connectMode,
      ...(spec.configRuleId ? { configRuleId: spec.configRuleId } : {}),
    };
  }

  private resolveStandaloneMurmurPath(): string | null {
    const binaryName = this.platform === 'win32' ? 'murmur.exe' : 'murmur';
    const candidate = path.join(this.homeDir, '.murmurant', 'bin', binaryName);
    return existsSync(candidate) ? candidate : null;
  }

  private async probeEngine(): Promise<DetectedEngineStatus> {
    const installedRecord = this.componentRegistry.getInstalled(MURMUR_COMPONENT_ID);
    const standaloneBinary = this.resolveStandaloneMurmurPath();
    const [httpProbe, resolvedPathBinary] = await Promise.all([
      this.engineHttpProbe(MURMUR_ENGINE_HOST, MURMUR_ENGINE_PORT, this.engineHttpTimeoutMs),
      installedRecord
        ? Promise.resolve(installedRecord.executablePath)
        : standaloneBinary
          ? Promise.resolve(standaloneBinary)
          : this.pathResolver.resolveBinary('murmur'),
    ]);

    const classified = classifyHttpProbe(httpProbe);
    const binaryPath = resolvedPathBinary ?? undefined;
    const status: DetectedEngineStatus = {
      installed: Boolean(binaryPath),
      running: classified.running,
      port: MURMUR_ENGINE_PORT,
      providerKind: classified.providerKind,
      ...(binaryPath ? { binaryPath } : {}),
      ...(classified.mode ? { mode: classified.mode } : {}),
      ...(classified.occupiedBy ? { occupiedBy: classified.occupiedBy } : {}),
    };

    if (!binaryPath) {
      return status;
    }

    const mergedPath = await this.pathResolver.getExecutablePath();
    const cliResult = await this.commandRunner({
      binaryPath,
      argv: ['status', '--json'],
      timeoutMs: this.murmurStatusTimeoutMs,
      env: { ...process.env, PATH: mergedPath },
    });

    // Per murmurant/docs/member-status.md, `murmur status --json` prints valid schema-1
    // JSON to stdout and exits non-zero when signed out of a team gateway (the normal
    // OpenDesign user state). Always attempt to parse stdout JSON regardless of exitCode.
    if (cliResult.timedOut || !cliResult.stdout.trim()) {
      return status;
    }

    const parsed = parseMurmurStatusJson(cliResult.stdout);
    if (!parsed.ok) {
      if (parsed.version) {
        status.version = parsed.version;
      }
      if (parsed.schemaUnsupported) {
        // Gracefully degrade on unknown future schema versions (Contract M9).
        status.mode = status.mode ?? 'unknown';
        status.schemaUnsupported = true;
      }
      return status;
    }

    if (parsed.version) {
      status.version = parsed.version;
    }
    status.signedIn = parsed.signedIn;
    status.servedBy = parsed.servedBy;
    status.mode = parsed.mode;

    if (parsed.desktopMagpieActive && status.providerKind !== 'murmur-personal') {
      if (parsed.running || status.running) {
        status.providerKind = 'magpie-desktop';
        status.occupiedBy = 'magpie-desktop';
        status.running = true;
      }
    } else if (
      parsed.servedBy === 'personal' &&
      parsed.running &&
      (status.providerKind === 'none' ||
        (status.providerKind === 'other-process' && status.occupiedBy?.startsWith('http-')))
    ) {
      status.providerKind = 'murmur-personal';
      delete status.occupiedBy;
      status.running = true;
    }

    return status;
  }
}

export function createDetectAtom(deps: DetectAtomDeps): DetectAtom {
  return new DetectAtom(deps);
}
