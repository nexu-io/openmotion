/**
 * Shared Five Atomic Local Capabilities Engine (K7 + K4).
 *
 * Host-agnostic runtime consumed identically by:
 * - Electron thin desktop shell (`CapabilityRegistry`, K6)
 * - Web Connect Script loopback host (K9)
 */

import os from 'node:os';
import type { BuiltinPublisherEntry } from '../../shared/desktop-builtin-rules.ts';
import {
  HOST_CAPABILITIES,
  HOST_CAPABILITY_VERSIONS,
  hostErr,
  type AtomConfigReadParams,
  type AtomConfigWriteParams,
  type AtomCredentialStartParams,
  type AtomExecParams,
  type AtomInstallComponentParams,
  type HostCapabilityDescriptor,
  type HostInvokeResult,
  type HostPlatform,
  type HostReleaseChannel,
} from '../../shared/desktop-contract.ts';
import type { SignedConfigPayload } from '../../shared/signed-config.ts';
import { validateHostMethodParams } from '../../shared/desktop-schemas.ts';
import {
  ConfigAtom,
  createConfigAtom,
  type AtomConfigRestoreParams,
} from './config.ts';
import {
  FeatureConfirmationGate,
  createFeatureConfirmationGate,
  type ConfirmCallback,
} from './confirmation.ts';
import {
  CredentialAtom,
  createCredentialAtom,
  type AtomCredentialInjectParams,
  type AtomCredentialPollParams,
  type AtomCredentialRetryPendingRevokesParams,
  type AtomCredentialRevokeParams,
  type CredentialHttpClient,
  type SecretStore,
} from './credential.ts';
import {
  DetectAtom,
  createDetectAtom,
  type AtomDetectParams,
  type EngineHttpProbe,
} from './detect.ts';
import {
  ExecAtom,
  createExecAtom,
  type CommandRunner,
} from './exec.ts';
import {
  ComponentInstallRegistry,
  getUnifiedMurmurBinDir,
  InstallComponentAtom,
  createInstallComponentAtom,
  type ArtifactDownloader,
  type CodeSignatureVerifier,
} from './install-component.ts';
import {
  PathResolver,
  createPathResolver,
  type LoginShellRunner,
  type PathResolverFs,
} from './path-resolver.ts';
import { SerialMutationQueue, createSerialMutationQueue } from './serial-queue.ts';

export * from './path-resolver.ts';
export * from './serial-queue.ts';
export * from './confirmation.ts';
export * from './config.ts';
export * from './install-component.ts';
export * from './exec.ts';
export * from './credential.ts';
export * from './detect.ts';

export type LocalAtomCapabilityName =
  | typeof HOST_CAPABILITIES.ATOM_DETECT
  | typeof HOST_CAPABILITIES.ATOM_EXEC
  | typeof HOST_CAPABILITIES.ATOM_INSTALL_COMPONENT
  | typeof HOST_CAPABILITIES.ATOM_CREDENTIAL
  | typeof HOST_CAPABILITIES.ATOM_CONFIG;

export type LocalAtomCapabilityHandler = {
  descriptor: HostCapabilityDescriptor;
  invoke: (method: string, params?: Record<string, unknown>) => Promise<HostInvokeResult>;
};

export type LocalAtomsRuntimeDeps = {
  dataDir: string;
  homeDir?: string;
  platform?: HostPlatform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  channel?: HostReleaseChannel;
  allowLocalDevLoopback?: boolean;
  appBundlePath?: string;
  expectedMcpUrl?: string;
  getExpectedMcpUrl?: () => string | undefined;
  shellVersion?: string;
  getSignedConfig: () => SignedConfigPayload;
  confirmCallback: ConfirmCallback;
  /** Optional injectable dependencies for deterministic tests or custom host adapters. */
  pathResolver?: PathResolver;
  loginShellRunner?: LoginShellRunner;
  pathResolverFs?: Partial<PathResolverFs>;
  mutationQueue?: SerialMutationQueue;
  confirmationGate?: FeatureConfirmationGate;
  componentRegistry?: ComponentInstallRegistry;
  commandRunner?: CommandRunner;
  engineHttpProbe?: EngineHttpProbe;
  downloader?: ArtifactDownloader;
  codeSignatureVerifier?: CodeSignatureVerifier;
  publishers?: readonly BuiltinPublisherEntry[];
  secretStore?: SecretStore;
  credentialHttpClient?: CredentialHttpClient;
  now?: () => Date;
};

export type LocalAtomsRuntime = {
  capabilities: Record<LocalAtomCapabilityName, LocalAtomCapabilityHandler>;
  descriptors: () => HostCapabilityDescriptor[];
  invoke: (capability: string, method: string, params?: Record<string, unknown>) => Promise<HostInvokeResult>;
  pathResolver: PathResolver;
  mutationQueue: SerialMutationQueue;
  confirmationGate: FeatureConfirmationGate;
  componentRegistry: ComponentInstallRegistry;
  atoms: {
    detect: DetectAtom;
    exec: ExecAtom;
    installComponent: InstallComponentAtom;
    credential: CredentialAtom;
    config: ConfigAtom;
  };
};

export function createLocalAtomsRuntime(deps: LocalAtomsRuntimeDeps): LocalAtomsRuntime {
  const effectiveHomeDir = deps.homeDir ?? os.homedir();
  const resolveExpectedMcpUrl = (): string | undefined =>
    deps.getExpectedMcpUrl?.() ?? deps.expectedMcpUrl;

  const pathResolver =
    deps.pathResolver ??
    createPathResolver({
      platform: deps.platform,
      homeDir: effectiveHomeDir,
      env: deps.env,
      loginShellRunner: deps.loginShellRunner,
      fs: deps.pathResolverFs,
    });

  const mutationQueue = deps.mutationQueue ?? createSerialMutationQueue();
  const confirmationGate =
    deps.confirmationGate ??
    createFeatureConfirmationGate({
      dataDir: deps.dataDir,
      confirmCallback: deps.confirmCallback,
      shellVersion: deps.shellVersion,
      now: deps.now,
    });
  const componentRegistry =
    deps.componentRegistry ??
    new ComponentInstallRegistry(deps.dataDir, {
      extraAllowedRoots: [getUnifiedMurmurBinDir(effectiveHomeDir)],
    });

  const isAllowedPublisherId = deps.publishers
    ? (publisherId: string) => deps.publishers!.some(entry => entry.id === publisherId)
    : undefined;

  const configAtom = createConfigAtom({
    dataDir: deps.dataDir,
    homeDir: effectiveHomeDir,
    channel: deps.channel,
    allowLocalDevLoopback: deps.allowLocalDevLoopback,
    expectedMcpUrl: deps.expectedMcpUrl,
    getExpectedMcpUrl: resolveExpectedMcpUrl,
    getSignedConfig: deps.getSignedConfig,
    confirmationGate,
    mutationQueue,
    now: deps.now,
  });

  const installComponentAtom = createInstallComponentAtom({
    dataDir: deps.dataDir,
    homeDir: effectiveHomeDir,
    platform: deps.platform,
    arch: deps.arch,
    channel: deps.channel,
    allowLocalDevLoopback: deps.allowLocalDevLoopback,
    appBundlePath: deps.appBundlePath,
    getSignedConfig: deps.getSignedConfig,
    confirmationGate,
    mutationQueue,
    registry: componentRegistry,
    publishers: deps.publishers,
    downloader: deps.downloader,
    codeSignatureVerifier: deps.codeSignatureVerifier,
    commandRunner: deps.commandRunner,
    now: deps.now,
  });

  const execAtom = createExecAtom({
    homeDir: effectiveHomeDir,
    platform: deps.platform,
    arch: deps.arch,
    channel: deps.channel,
    allowLocalDevLoopback: deps.allowLocalDevLoopback,
    expectedMcpUrl: deps.expectedMcpUrl,
    getExpectedMcpUrl: resolveExpectedMcpUrl,
    getSignedConfig: deps.getSignedConfig,
    pathResolver,
    componentRegistry,
    confirmationGate,
    mutationQueue,
    commandRunner: deps.commandRunner,
    publishers: deps.publishers,
    codeSignatureVerifier: deps.codeSignatureVerifier,
    isAllowedPublisherId,
  });

  const credentialAtom = createCredentialAtom({
    dataDir: deps.dataDir,
    platform: deps.platform,
    channel: deps.channel,
    allowLocalDevLoopback: deps.allowLocalDevLoopback,
    getSignedConfig: deps.getSignedConfig,
    confirmationGate,
    mutationQueue,
    execAtom,
    secretStore: deps.secretStore,
    httpClient: deps.credentialHttpClient,
    now: deps.now,
  });

  const detectAtom = createDetectAtom({
    platform: deps.platform,
    arch: deps.arch,
    homeDir: effectiveHomeDir,
    expectedMcpUrl: deps.expectedMcpUrl,
    getExpectedMcpUrl: resolveExpectedMcpUrl,
    getSignedConfig: deps.getSignedConfig,
    pathResolver,
    componentRegistry,
    commandRunner: deps.commandRunner,
    engineHttpProbe: deps.engineHttpProbe,
    now: deps.now,
  });

  const capabilities: Record<LocalAtomCapabilityName, LocalAtomCapabilityHandler> = {
    [HOST_CAPABILITIES.ATOM_DETECT]: {
      descriptor: {
        name: HOST_CAPABILITIES.ATOM_DETECT,
        version: HOST_CAPABILITY_VERSIONS[HOST_CAPABILITIES.ATOM_DETECT],
        status: 'available',
        methods: ['scan'],
        events: [],
      },
      async invoke(method, params) {
        if (method === 'scan' || method === 'detect') {
          const checked = validateHostMethodParams<AtomDetectParams>(HOST_CAPABILITIES.ATOM_DETECT, method, params);
          if (!checked.ok) return checked;
          return detectAtom.scan(checked.data);
        }
        return hostErr('UNSUPPORTED', `Unknown method "${method}" for ${HOST_CAPABILITIES.ATOM_DETECT}`);
      },
    },

    [HOST_CAPABILITIES.ATOM_EXEC]: {
      descriptor: {
        name: HOST_CAPABILITIES.ATOM_EXEC,
        version: HOST_CAPABILITY_VERSIONS[HOST_CAPABILITIES.ATOM_EXEC],
        status: 'available',
        methods: ['run', 'preview'],
        events: [],
      },
      async invoke(method, params) {
        if (method === 'run' || method === 'preview') {
          const checked = validateHostMethodParams<AtomExecParams>(HOST_CAPABILITIES.ATOM_EXEC, method, params);
          if (!checked.ok) return checked;
          return method === 'run' ? execAtom.run(checked.data) : execAtom.preview(checked.data);
        }
        return hostErr('UNSUPPORTED', `Unknown method "${method}" for ${HOST_CAPABILITIES.ATOM_EXEC}`);
      },
    },

    [HOST_CAPABILITIES.ATOM_INSTALL_COMPONENT]: {
      descriptor: {
        name: HOST_CAPABILITIES.ATOM_INSTALL_COMPONENT,
        version: HOST_CAPABILITY_VERSIONS[HOST_CAPABILITIES.ATOM_INSTALL_COMPONENT],
        status: 'available',
        methods: ['install', 'preview', 'status', 'uninstall'],
        events: [],
      },
      async invoke(method, params) {
        if (method === 'install' || method === 'preview' || method === 'uninstall') {
          const checked = validateHostMethodParams<AtomInstallComponentParams>(
            HOST_CAPABILITIES.ATOM_INSTALL_COMPONENT,
            method,
            params,
          );
          if (!checked.ok) return checked;
          if (method === 'install') return installComponentAtom.install(checked.data);
          if (method === 'preview') return installComponentAtom.preview(checked.data);
          return installComponentAtom.uninstall(checked.data);
        }
        if (method === 'status') {
          const checked = validateHostMethodParams<{ componentId: string }>(
            HOST_CAPABILITIES.ATOM_INSTALL_COMPONENT,
            method,
            params,
          );
          if (!checked.ok) return checked;
          return installComponentAtom.status(checked.data);
        }
        return hostErr('UNSUPPORTED', `Unknown method "${method}" for ${HOST_CAPABILITIES.ATOM_INSTALL_COMPONENT}`);
      },
    },

    [HOST_CAPABILITIES.ATOM_CREDENTIAL]: {
      descriptor: {
        name: HOST_CAPABILITIES.ATOM_CREDENTIAL,
        version: HOST_CAPABILITY_VERSIONS[HOST_CAPABILITIES.ATOM_CREDENTIAL],
        status: 'available',
        methods: ['start', 'poll', 'status', 'inject', 'revoke', 'retryPendingRevokes'],
        events: [],
      },
      async invoke(method, params) {
        if (method === 'start') {
          const checked = validateHostMethodParams<AtomCredentialStartParams>(
            HOST_CAPABILITIES.ATOM_CREDENTIAL,
            method,
            params,
          );
          if (!checked.ok) return checked;
          return credentialAtom.start(checked.data);
        }
        if (method === 'poll') {
          const checked = validateHostMethodParams<AtomCredentialPollParams>(
            HOST_CAPABILITIES.ATOM_CREDENTIAL,
            method,
            params,
          );
          if (!checked.ok) return checked;
          return credentialAtom.poll(checked.data);
        }
        if (method === 'status') {
          const checked = validateHostMethodParams<{ credentialId: string; installationId?: string }>(
            HOST_CAPABILITIES.ATOM_CREDENTIAL,
            method,
            params,
          );
          if (!checked.ok) return checked;
          return credentialAtom.status(checked.data);
        }
        if (method === 'inject') {
          const checked = validateHostMethodParams<AtomCredentialInjectParams>(
            HOST_CAPABILITIES.ATOM_CREDENTIAL,
            method,
            params,
          );
          if (!checked.ok) return checked;
          return credentialAtom.inject(checked.data);
        }
        if (method === 'revoke') {
          const checked = validateHostMethodParams<AtomCredentialRevokeParams>(
            HOST_CAPABILITIES.ATOM_CREDENTIAL,
            method,
            params,
          );
          if (!checked.ok) return checked;
          return credentialAtom.revoke(checked.data);
        }
        if (method === 'retryPendingRevokes') {
          const checked = validateHostMethodParams<AtomCredentialRetryPendingRevokesParams>(
            HOST_CAPABILITIES.ATOM_CREDENTIAL,
            method,
            params,
          );
          if (!checked.ok) return checked;
          return credentialAtom.retryPendingRevokes(checked.data);
        }
        return hostErr('UNSUPPORTED', `Unknown method "${method}" for ${HOST_CAPABILITIES.ATOM_CREDENTIAL}`);
      },
    },

    [HOST_CAPABILITIES.ATOM_CONFIG]: {
      descriptor: {
        name: HOST_CAPABILITIES.ATOM_CONFIG,
        version: HOST_CAPABILITY_VERSIONS[HOST_CAPABILITIES.ATOM_CONFIG],
        status: 'available',
        methods: ['read', 'write', 'previewWrite', 'restoreBackup'],
        events: [],
      },
      async invoke(method, params) {
        if (method === 'read') {
          const checked = validateHostMethodParams<AtomConfigReadParams>(HOST_CAPABILITIES.ATOM_CONFIG, method, params);
          if (!checked.ok) return checked;
          return configAtom.read(checked.data);
        }
        if (method === 'write' || method === 'previewWrite') {
          const checked = validateHostMethodParams<AtomConfigWriteParams>(
            HOST_CAPABILITIES.ATOM_CONFIG,
            method,
            params,
          );
          if (!checked.ok) return checked;
          return method === 'write' ? configAtom.write(checked.data) : configAtom.previewWrite(checked.data);
        }
        if (method === 'restoreBackup') {
          const checked = validateHostMethodParams<AtomConfigRestoreParams>(
            HOST_CAPABILITIES.ATOM_CONFIG,
            method,
            params,
          );
          if (!checked.ok) return checked;
          return configAtom.restoreBackup(checked.data);
        }
        return hostErr('UNSUPPORTED', `Unknown method "${method}" for ${HOST_CAPABILITIES.ATOM_CONFIG}`);
      },
    },
  };

  return {
    capabilities,
    descriptors: () => Object.values(capabilities).map(entry => entry.descriptor),
    async invoke(capability, method, params) {
      const handler = capabilities[capability as LocalAtomCapabilityName];
      if (!handler) {
        return hostErr('UNSUPPORTED', `Unknown local atom capability: "${capability}"`);
      }
      return handler.invoke(method, params);
    },
    pathResolver,
    mutationQueue,
    confirmationGate,
    componentRegistry,
    atoms: {
      detect: detectAtom,
      exec: execAtom,
      installComponent: installComponentAtom,
      credential: credentialAtom,
      config: configAtom,
    },
  };
}
