/**
 * Q1 Frozen Contract — Murmur Engine Command & Status Contract (M9 alignment).
 *
 * Additive-only contract between signed config first-party command templates
 * and the external Murmur engine binary installed outside the app bundle.
 */

export const MURMUR_COMPONENT_ID = 'murmur-engine' as const;
export const MURMUR_ENGINE_HOST = '127.0.0.1' as const;
export const MURMUR_ENGINE_PORT = 3425 as const;
export const MURMUR_PERSONAL_IDENTITY_PREFIX = 'murmurant-personal-' as const;
export const OPENDESIGN_PROVIDER_ID = 'opendesign' as const;

/**
 * Supported `murmur status --json` schema version range.
 * If an independently upgraded engine reports a schemaVersion higher than
 * MURMUR_STATUS_MAX_SCHEMA_VERSION, the client degrades gracefully and waits
 * for a signed config update rather than guessing fields.
 */
export const MURMUR_STATUS_MIN_SCHEMA_VERSION = 1 as const;
export const MURMUR_STATUS_MAX_SCHEMA_VERSION = 1 as const;

/**
 * Security invariant tracked in M9:
 * First-party component command templates come from signed config; this remains
 * safe under signing-key compromise ONLY while Murmur exposes no subcommand
 * that executes arbitrary caller-supplied commands.
 */
export const MURMUR_NO_ARBITRARY_EXEC_INVARIANT =
  'murmur binary must never expose a subcommand that executes arbitrary caller-supplied commands without prior client security alignment' as const;

export const MURMUR_COMMAND_TEMPLATES = {
  VERSION: {
    templateId: 'murmur.version',
    componentId: MURMUR_COMPONENT_ID,
    mutating: false,
    argv: ['version'] as const,
  },
  STATUS: {
    templateId: 'murmur.status',
    componentId: MURMUR_COMPONENT_ID,
    mutating: false,
    argv: ['status', '--json'] as const,
  },
  DAEMON_INSTALL: {
    templateId: 'murmur.daemon.install',
    componentId: MURMUR_COMPONENT_ID,
    mutating: true,
    argv: ['magpie', 'daemon', 'install'] as const,
  },
  DAEMON_UNINSTALL: {
    templateId: 'murmur.daemon.uninstall',
    componentId: MURMUR_COMPONENT_ID,
    mutating: true,
    argv: ['magpie', 'daemon', 'uninstall'] as const,
  },
  DAEMON_RESTART: {
    templateId: 'murmur.daemon.restart',
    componentId: MURMUR_COMPONENT_ID,
    mutating: true,
    argv: ['magpie', 'daemon', 'restart'] as const,
  },
  PROVIDER_UPSERT: {
    templateId: 'murmur.provider.upsert',
    componentId: MURMUR_COMPONENT_ID,
    mutating: true,
    /** Secret runtime key is delivered strictly via stdin, never argv. */
    stdinSecret: true,
    argv: ['magpie', 'provider', 'add', '{providerId}', 'url={providerUrl}', 'list=off', '--api-key-stdin'] as const,
  },
  PROVIDER_SET_KEY: {
    templateId: 'murmur.provider.key',
    componentId: MURMUR_COMPONENT_ID,
    mutating: true,
    /** Secret runtime key is delivered strictly via stdin, never argv. */
    stdinSecret: true,
    argv: ['magpie', 'provider', 'key', '{providerId}', '--api-key-stdin'] as const,
  },
  PROVIDER_REMOVE: {
    templateId: 'murmur.provider.remove',
    componentId: MURMUR_COMPONENT_ID,
    mutating: true,
    argv: ['magpie', 'provider', 'rm', '{providerId}'] as const,
  },
  AGENT_ENABLE: {
    templateId: 'murmur.agent.enable',
    componentId: MURMUR_COMPONENT_ID,
    mutating: true,
    argv: ['magpie', '{agentId}', '{modelId}'] as const,
  },
  AGENT_RESTORE: {
    templateId: 'murmur.agent.restore',
    componentId: MURMUR_COMPONENT_ID,
    mutating: true,
    argv: ['magpie', '{agentId}', 'default'] as const,
  },
} as const;

export type MurmurEngineServedBy = 'desktop' | 'personal' | 'none';
export type MurmurModeValue = 'personal' | 'pool' | 'custom' | 'unset';
export type MurmurAgentRoute = 'own' | 'off' | 'both' | 'engine' | 'takeover';

export type MurmurStatusAgentEntry = {
  id: string;
  name?: string;
  wired: boolean;
  joined?: boolean;
  failover?: boolean;
  isolated?: boolean;
  route?: MurmurAgentRoute;
};

export type MurmurStatusAttentionEntry = {
  kind: string;
  subject?: string[];
  action?: string;
};

/**
 * Real `murmur status --json` schema 1 document (`murmurant/docs/member-status.md`).
 * Note: when `signed_in` is false (the normal OpenDesign user state), `murmur status --json`
 * still writes this valid JSON document to stdout and exits non-zero.
 */
export type MurmurStatusPayload = {
  schema: number;
  generated_at?: string;
  signed_in: boolean;
  engine: {
    served_by: MurmurEngineServedBy;
    running: boolean;
    release?: string;
  };
  mode: {
    current: MurmurModeValue;
    derived?: boolean;
  };
  agents?: MurmurStatusAgentEntry[];
  attention?: MurmurStatusAttentionEntry[];
};

export type ParsedMurmurStatus =
  | {
      ok: true;
      schema: number;
      signedIn: boolean;
      servedBy: MurmurEngineServedBy;
      running: boolean;
      version?: string;
      mode: 'personal' | 'pool' | 'unknown';
      desktopMagpieActive: boolean;
      agents: MurmurStatusAgentEntry[];
    }
  | {
      ok: false;
      schemaUnsupported: boolean;
      schema?: number;
      version?: string;
      reason: string;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses `murmur status --json` stdout according to schema 1 (`murmurant/docs/member-status.md`).
 * Gracefully degrades when `schema` exceeds `MURMUR_STATUS_MAX_SCHEMA_VERSION`.
 */
export function parseMurmurStatusJson(rawStdout: string): ParsedMurmurStatus {
  const trimmed = rawStdout.trim();
  if (!trimmed) {
    return { ok: false, schemaUnsupported: false, reason: 'Empty murmur status output' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, schemaUnsupported: false, reason: 'Malformed JSON from murmur status' };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, schemaUnsupported: false, reason: 'Murmur status output must be a JSON object' };
  }

  const engineObj = isPlainObject(parsed.engine) ? parsed.engine : undefined;
  const releaseVersion =
    typeof engineObj?.release === 'string' && engineObj.release.trim()
      ? engineObj.release.trim()
      : typeof parsed.version === 'string' && parsed.version.trim()
        ? parsed.version.trim()
        : undefined;

  const schema =
    typeof parsed.schema === 'number'
      ? parsed.schema
      : typeof parsed.schemaVersion === 'number'
        ? parsed.schemaVersion
        : NaN;

  if (
    !Number.isInteger(schema) ||
    schema < MURMUR_STATUS_MIN_SCHEMA_VERSION ||
    schema > MURMUR_STATUS_MAX_SCHEMA_VERSION
  ) {
    return {
      ok: false,
      schemaUnsupported: Number.isFinite(schema),
      ...(Number.isFinite(schema) ? { schema } : {}),
      ...(releaseVersion ? { version: releaseVersion } : {}),
      reason: `Unsupported murmur status schema: ${String(schema)}`,
    };
  }

  const signedIn =
    typeof parsed.signed_in === 'boolean'
      ? parsed.signed_in
      : typeof parsed.loggedInToTeamGateway === 'boolean'
        ? parsed.loggedInToTeamGateway
        : false;

  const rawServedBy = typeof engineObj?.served_by === 'string' ? engineObj.served_by : undefined;
  let servedBy: MurmurEngineServedBy;
  if (rawServedBy === 'desktop' || rawServedBy === 'personal' || rawServedBy === 'none') {
    servedBy = rawServedBy;
  } else if (parsed.desktopMagpieActive === true) {
    servedBy = 'desktop';
  } else if (parsed.daemonRunning === true) {
    servedBy = 'personal';
  } else {
    servedBy = 'none';
  }

  const running =
    typeof engineObj?.running === 'boolean'
      ? engineObj.running
      : typeof parsed.daemonRunning === 'boolean'
        ? parsed.daemonRunning
        : servedBy === 'desktop';

  const modeObj = isPlainObject(parsed.mode) ? parsed.mode : undefined;
  const rawMode =
    typeof modeObj?.current === 'string'
      ? modeObj.current
      : typeof parsed.mode === 'string'
        ? parsed.mode
        : undefined;

  const mode: 'personal' | 'pool' | 'unknown' =
    rawMode === 'personal' || rawMode === 'pool' ? rawMode : 'unknown';

  const agents: MurmurStatusAgentEntry[] = Array.isArray(parsed.agents)
    ? parsed.agents
        .filter((entry): entry is Record<string, unknown> => isPlainObject(entry) && typeof entry.id === 'string')
        .map(entry => ({
          id: entry.id as string,
          ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
          wired: Boolean(entry.wired),
          ...(typeof entry.joined === 'boolean' ? { joined: entry.joined } : {}),
          ...(typeof entry.failover === 'boolean' ? { failover: entry.failover } : {}),
          ...(typeof entry.isolated === 'boolean' ? { isolated: entry.isolated } : {}),
          ...(typeof entry.route === 'string' ? { route: entry.route as MurmurAgentRoute } : {}),
        }))
    : [];

  return {
    ok: true,
    schema,
    signedIn,
    servedBy,
    running,
    ...(releaseVersion ? { version: releaseVersion } : {}),
    mode,
    desktopMagpieActive: servedBy === 'desktop',
    agents,
  };
}
