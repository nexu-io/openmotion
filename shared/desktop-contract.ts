/**
 * Q1 Frozen Contract — Universal Host Bridge & Capability Registry.
 *
 * Additive-only contract shared across:
 * - Desktop Electron preload & main process (K6)
 * - Five atomic local capabilities (K7)
 * - Web Connect Script loopback host (K9)
 * - Studio frontend bridge client (S1 / S2)
 */

export const HOST_CONTRACT_VERSION = '1.0.0' as const;

export type HostKind = 'desktop' | 'connect-script';

export type HostPlatform = 'darwin' | 'win32' | 'linux';

export type HostReleaseChannel = 'stable' | 'test' | 'dev';

export type HostRuntimeInfo = {
  hostKind: HostKind;
  shellVersion: string;
  contractVersion: string;
  platform: HostPlatform;
  arch: string;
  releaseChannel: HostReleaseChannel;
  isPackaged: boolean;
  appId?: string;
  productName?: string;
  protocolScheme?: string;
  electronVersion?: string;
  chromeVersion?: string;
  nodeVersion?: string;
  dataDir?: string;
  logDir?: string;
  dataLayoutVersion?: number;
  activeStudioUrl?: string;
  environmentLabel?: string;
  isCustomEnvironment?: boolean;
};

export type HostCapabilityStatus = 'available' | 'degraded' | 'unavailable';

export type HostCapabilityDescriptor = {
  name: string;
  version: string;
  status: HostCapabilityStatus;
  reason?: string;
  methods?: readonly string[];
  events?: readonly string[];
};

export type HostErrorCode =
  | 'UNSUPPORTED'
  | 'INVALID_PARAMS'
  | 'UNAUTHORIZED'
  | 'ORIGIN_DENIED'
  | 'POLICY_DENIED'
  | 'USER_DENIED'
  | 'CONFLICT'
  | 'BUSY'
  | 'NOT_FOUND'
  | 'VERIFICATION_FAILED'
  | 'TIMEOUT'
  | 'EXEC_FAILED'
  | 'INTERNAL_ERROR';

export type HostError = {
  code: HostErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type HostInvokeSuccess<T = unknown> = {
  ok: true;
  data: T;
};

export type HostInvokeFailure = {
  ok: false;
  error: HostError;
};

export type HostInvokeResult<T = unknown> = HostInvokeSuccess<T> | HostInvokeFailure;

/**
 * The four universal bridge methods exposed to allowed top-level Studio pages.
 * All methods and capabilities are additive-only.
 */
export type UniversalHostBridge = {
  info: () => Promise<HostRuntimeInfo>;
  capabilities: () => Promise<HostCapabilityDescriptor[]>;
  invoke: <T = unknown>(
    capability: string,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<HostInvokeResult<T>>;
  subscribe: (
    capability: string,
    event: string,
    callback: (payload: unknown) => void,
  ) => () => void;
};

/**
 * Frozen capability names and v1 versions.
 */
export const HOST_CAPABILITIES = {
  WINDOW: 'window',
  UPDATER: 'updater',
  DIAGNOSTICS: 'diagnostics',
  ACCOUNT: 'account',
  SIGNED_CONFIG: 'signedConfig',
  TELEMETRY: 'telemetry',
  PREFERENCES: 'preferences',
  ATOM_DETECT: 'atom.detect',
  ATOM_EXEC: 'atom.exec',
  ATOM_INSTALL_COMPONENT: 'atom.installComponent',
  ATOM_CREDENTIAL: 'atom.credential',
  ATOM_CONFIG: 'atom.config',
} as const;

export type HostCapabilityName = (typeof HOST_CAPABILITIES)[keyof typeof HOST_CAPABILITIES];

export const HOST_CAPABILITY_VERSIONS: Record<HostCapabilityName, string> = {
  [HOST_CAPABILITIES.WINDOW]: '1.0.0',
  [HOST_CAPABILITIES.UPDATER]: '1.0.0',
  [HOST_CAPABILITIES.DIAGNOSTICS]: '1.0.0',
  [HOST_CAPABILITIES.ACCOUNT]: '1.0.0',
  [HOST_CAPABILITIES.SIGNED_CONFIG]: '1.0.0',
  [HOST_CAPABILITIES.TELEMETRY]: '1.0.0',
  [HOST_CAPABILITIES.PREFERENCES]: '1.0.0',
  [HOST_CAPABILITIES.ATOM_DETECT]: '1.0.0',
  [HOST_CAPABILITIES.ATOM_EXEC]: '1.0.0',
  [HOST_CAPABILITIES.ATOM_INSTALL_COMPONENT]: '1.0.0',
  [HOST_CAPABILITIES.ATOM_CREDENTIAL]: '1.0.0',
  [HOST_CAPABILITIES.ATOM_CONFIG]: '1.0.0',
};

/**
 * Shell-generated confirmation facts shown before a feature mutates the host.
 * Always computed by the host from built-in rules + verified signed config,
 * never trusted from the page.
 */
export type ConfirmationFactKind =
  | 'exec_program'
  | 'modify_file'
  | 'connect_url'
  | 'install_component'
  | 'store_credential';

export type ConfirmationFact = {
  kind: ConfirmationFactKind;
  label: string;
  value: string;
};

export type HostConfirmationRequest = {
  featureId: string;
  featureVersion: string;
  featureTitle: string;
  facts: ConfirmationFact[];
};

/**
 * Atom 1: atom.detect (read-only)
 */
export type DetectedAgentCli = {
  agentId: string;
  displayName?: string;
  installed: boolean;
  binaryPath?: string;
  version?: string;
  mcpConfigured: boolean;
  mcpUrl?: string;
  mcpConflict?: boolean;
  configPath?: string;
  /** How Studio should connect this agent: via built-in CLI (`atom.exec`) or declarative config (`atom.config.write`). */
  connectMode?: 'cli' | 'config';
  /** Declarative `atom.config` ruleId when `connectMode === 'config'` (or fallback config rule). */
  configRuleId?: string;
};

export type DetectedEngineStatus = {
  installed: boolean;
  running: boolean;
  port: number;
  providerKind: 'none' | 'murmur-personal' | 'magpie-desktop' | 'other-process';
  binaryPath?: string;
  version?: string;
  mode?: 'personal' | 'pool' | 'unknown';
  occupiedBy?: string;
  signedIn?: boolean;
  servedBy?: 'desktop' | 'personal' | 'none';
  schemaUnsupported?: boolean;
};

export type AtomDetectResult = {
  platform: HostPlatform;
  arch: string;
  agents: DetectedAgentCli[];
  engine: DetectedEngineStatus;
  detectedAt: string;
};

/**
 * Atom 2: atom.exec
 */
export type AtomExecParams = {
  featureId: string;
  templateId: string;
  args?: Record<string, string | boolean>;
  conflictPolicy?: 'abort' | 'replace';
};

export type AtomExecResult = {
  templateId: string;
  program: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

/**
 * Atom 3: atom.installComponent
 */
export type AtomInstallComponentParams = {
  featureId: string;
  componentId: string;
};

export type AtomInstallComponentResult = {
  componentId: string;
  version: string;
  installPath: string;
  sha256: string;
  publisherId: string;
  alreadyInstalled: boolean;
  reusedExisting?: boolean;
};

/**
 * Atom 4: atom.credential
 */
export type AtomCredentialStartParams = {
  featureId: string;
  credentialId: string;
};

export type AtomCredentialStartResult = {
  sessionId: string;
  verificationUri: string;
  userCode?: string;
  expiresAt: string;
};

export type AtomCredentialStatusResult = {
  credentialId: string;
  stored: boolean;
  accountId?: string;
  installationId?: string;
  updatedAt?: string;
  status?: 'active' | 'pending_revoke' | 'revoked' | 'none';
  pendingRevoke?: boolean;
};

/**
 * Atom 5: atom.config (field-level merge with pre-edit backup)
 */
export type BuiltinConfigFieldType = 'remote_mcp_entry';

export type AtomConfigReadParams = {
  ruleId: string;
  serverName?: string;
};

export type AtomConfigReadResult = {
  ruleId: string;
  configPath: string;
  exists: boolean;
  entry?: {
    serverName: string;
    url?: string;
    transport?: string;
  };
};

export type AtomConfigWriteParams = {
  featureId: string;
  ruleId: string;
  fieldType: BuiltinConfigFieldType;
  value: {
    serverName: string;
    url: string;
    transport?: 'http' | 'streamable-http' | 'remote';
  };
  conflictPolicy?: 'abort' | 'replace';
};

export type AtomConfigWriteResult = {
  ruleId: string;
  configPath: string;
  backupPath?: string;
  changed: boolean;
};

/**
 * Desktop-only host preferences (device-local, persisted by the Electron shell).
 *
 * `lastDownloadDir` is never accepted as a raw string from the renderer; it can
 * only be changed via the main-process native folder picker (`pickDownloadDir`)
 * or cleared via `reset`.
 */
export const DESKTOP_PREFERENCE_KEYS = [
  'confirmBeforeQuit',
  'openAtLogin',
  'autoCheckUpdates',
  'hardwareAcceleration',
  'locale',
  'lastDownloadDir',
] as const;

export type DesktopPreferenceKey = (typeof DESKTOP_PREFERENCE_KEYS)[number];

export type DesktopWritablePreferenceKey = Exclude<DesktopPreferenceKey, 'lastDownloadDir'>;

export type DesktopPreferenceValues = {
  confirmBeforeQuit: boolean;
  openAtLogin: boolean;
  autoCheckUpdates: boolean;
  hardwareAcceleration: boolean;
  locale: string | null;
  lastDownloadDir: string | null;
};

export type DesktopPreferenceDescriptor = {
  key: DesktopPreferenceKey;
  supported: boolean;
  requiresRestart?: boolean;
  picker?: boolean;
  reason?: string;
};

export type DesktopPreferencesSnapshot = {
  values: DesktopPreferenceValues;
  descriptors: DesktopPreferenceDescriptor[];
  platform: HostPlatform;
  pendingRestartKeys: DesktopPreferenceKey[];
};

export type DesktopPreferenceSetParams =
  | { key: 'confirmBeforeQuit'; value: boolean }
  | { key: 'openAtLogin'; value: boolean }
  | { key: 'autoCheckUpdates'; value: boolean }
  | { key: 'hardwareAcceleration'; value: boolean }
  | { key: 'locale'; value: string | null };

export type DesktopPreferenceSetResult = {
  key: DesktopWritablePreferenceKey;
  value: DesktopPreferenceValues[DesktopWritablePreferenceKey];
  applied: 'immediate' | 'restart-required';
  snapshot: DesktopPreferencesSnapshot;
};

export type DesktopPreferenceResetParams = {
  key?: DesktopPreferenceKey;
};

export type DesktopPickDownloadDirResult = {
  canceled: boolean;
  path: string | null;
  snapshot: DesktopPreferencesSnapshot;
};

export function hostOk<T>(data: T): HostInvokeSuccess<T> {
  return { ok: true, data };
}

export function hostErr(
  code: HostErrorCode,
  message: string,
  details?: Record<string, unknown>,
): HostInvokeFailure {
  return details ? { ok: false, error: { code, message, details } } : { ok: false, error: { code, message } };
}
