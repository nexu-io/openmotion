#!/usr/bin/env node
/**
 * OpenMotion Web Connect Script CLI Entrypoint (K9 Step 1 — Wired to K7 + K8).
 *
 * Usage:
 *   node --experimental-strip-types scripts/connect-local-agent.mjs --connect [codex|claude|all]
 *   node --experimental-strip-types scripts/connect-local-agent.mjs --serve [--port 43118]
 *
 * Runs the exact same shared five atomic capabilities (`packages/local-atoms`)
 * and two-tier signed config verification (`packages/signed-config`) as the
 * Electron desktop thin shell.
 */

import os from 'node:os';
import path, { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_STUDIO_URLS,
  DESKTOP_DATA_LAYOUT_VERSION,
} from '../shared/desktop-builtin-rules.ts';
import {
  HOST_CONTRACT_VERSION,
  hostErr,
} from '../shared/desktop-contract.ts';
import { runConnectCli } from '../packages/connect-script/index.ts';
import { createLocalAtomsRuntime } from '../packages/local-atoms/index.ts';
import { SignedConfigManager } from '../packages/signed-config/index.ts';

const CONNECT_SCRIPT_VERSION = '0.2.1';

function resolveConnectDataDir() {
  const override = process.env.OPENMOTION_CONNECT_DATA_DIR?.trim();
  if (override) return override;
  return path.join(os.homedir(), '.openmotion', 'connect-script');
}

function normalizeHostPlatform(platform) {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') {
    return platform;
  }
  return 'linux';
}

/**
 * Builds the concrete `UniversalHostBridge` backed by `SignedConfigManager` (K8)
 * and `createLocalAtomsRuntime` (K7).
 */
export async function resolveConnectBridge(options) {
  const channel = options?.channel ?? 'stable';
  const allowLocalDevLoopback = Boolean(options?.allowLocalDevLoopback);
  const dataDir = options?.dataDir ?? resolveConnectDataDir();

  const signedConfig = new SignedConfigManager({
    dataDir,
    channel,
    allowLocalDevLoopback,
    ...(options?.rootPublicKey ? { rootPublicKey: options.rootPublicKey } : {}),
    ...(options?.fetchFn ? { fetchFn: options.fetchFn } : {}),
  });

  if (options?.refreshSignedConfig) {
    await signedConfig.fetchAndApply().catch(() => {});
  }

  const resolveExpectedMcpUrl = () => {
    if (options?.expectedMcpUrl) return options.expectedMcpUrl;
    const studioUrl =
      options?.studioUrl ??
      signedConfig.getActiveConfig().studioUrl ??
      DEFAULT_STUDIO_URLS[channel];
    return `${studioUrl.replace(/\/+$/, '')}/mcp`;
  };

  const atomsRuntime = createLocalAtomsRuntime({
    dataDir,
    homeDir: options?.homeDir,
    platform: normalizeHostPlatform(process.platform),
    arch: process.arch,
    channel,
    allowLocalDevLoopback,
    getExpectedMcpUrl: resolveExpectedMcpUrl,
    shellVersion: CONNECT_SCRIPT_VERSION,
    getSignedConfig: () => signedConfig.getActiveConfig(),
    confirmCallback: async request => {
      if (typeof options?.confirm === 'function') {
        return await options.confirm(request);
      }
      return false;
    },
    ...(options?.commandRunner ? { commandRunner: options.commandRunner } : {}),
    ...(options?.engineHttpProbe ? { engineHttpProbe: options.engineHttpProbe } : {}),
    ...(options?.pathResolver ? { pathResolver: options.pathResolver } : {}),
  });

  return {
    async info() {
      return {
        hostKind: 'connect-script',
        shellVersion: CONNECT_SCRIPT_VERSION,
        contractVersion: HOST_CONTRACT_VERSION,
        platform: normalizeHostPlatform(process.platform),
        arch: process.arch,
        releaseChannel: channel,
        isPackaged: false,
        nodeVersion: process.versions.node,
        dataDir,
        dataLayoutVersion: DESKTOP_DATA_LAYOUT_VERSION,
      };
    },
    async capabilities() {
      return [
        {
          name: 'signedConfig',
          version: '1.0.0',
          status: 'available',
          methods: ['getStatus', 'refresh'],
        },
        ...atomsRuntime.descriptors(),
      ];
    },
    async invoke(capability, method, params) {
      if (capability === 'signedConfig') {
        if (method === 'getStatus') {
          return { ok: true, data: signedConfig.getStatus() };
        }
        if (method === 'refresh') {
          const result = await signedConfig.fetchAndApply();
          return { ok: true, data: result };
        }
        return hostErr('UNSUPPORTED', `Unknown method "${method}" for signedConfig`);
      }
      return await atomsRuntime.invoke(capability, method, params);
    },
    subscribe() {
      return () => {};
    },
  };
}

async function main() {
  const exitCode = await runConnectCli(process.argv.slice(2), {
    createBridge: resolveConnectBridge,
  });
  process.exitCode = exitCode;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
