/**
 * Atom 3: `atom.installComponent` — Verified first-party component installer (K7).
 *
 * Security & Isolation Rules (Design Doc §5.6):
 * - Artifact URL must be inside built-in domain scope (`isUrlInAllowedDomainScope`),
 *   including any HTTP redirects during download.
 * - Publisher ID must be in `BUILTIN_PUBLISHERS`.
 * - SHA-256 digest must match manifest strictly (`VERIFICATION_FAILED` on mismatch).
 * - macOS code signature publisher Team ID (`codesign -dv --verbose=4`, injectable for
 *   cross-platform tests) must match the built-in publisher Team ID before installation.
 * - Components are installed strictly OUTSIDE the app bundle (`<dataDir>/components/`).
 * - Provenance metadata (`registry.json`) ensures `uninstall` only removes components
 *   installed by this host, and `atom.exec` only runs verified installed components.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import {
  BUILTIN_PUBLISHERS,
  compareSemver,
  isUrlInAllowedDomainScope,
  validateTypedPlaceholderValue,
  type BuiltinPublisherEntry,
} from '../../shared/desktop-builtin-rules.ts';
import {
  hostErr,
  hostOk,
  type AtomInstallComponentParams,
  type AtomInstallComponentResult,
  type ConfirmationFact,
  type HostInvokeResult,
  type HostPlatform,
  type HostReleaseChannel,
} from '../../shared/desktop-contract.ts';
import { MURMUR_COMPONENT_ID } from '../../shared/engine-command-contract.ts';
import type {
  SignedComponentManifest,
  SignedComponentPlatformArtifact,
  SignedConfigPayload,
} from '../../shared/signed-config.ts';
import { assertFeatureAllowsResource, type FeatureConfirmationGate } from './confirmation.ts';
import type { CommandRunner } from './exec.ts';
import type { SerialMutationQueue } from './serial-queue.ts';

const COMPONENTS_DIR_NAME = 'components';
const REGISTRY_FILE_NAME = 'registry.json';
const STAGING_DIR_NAME = '.staging';
const MAX_REDIRECTS = 5;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const SAFE_COMPONENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const APPLE_TEAM_ID_RE = /^[A-Z0-9]{10}$/;

export function getUnifiedMurmurBinDir(homeDir: string): string {
  return path.resolve(homeDir, '.murmurant', 'bin');
}

export function getUnifiedMurmurBinaryPath(homeDir: string, platform: HostPlatform = normalizePlatform(process.platform)): string {
  const binaryName = platform === 'win32' ? 'murmur.exe' : 'murmur';
  return path.join(getUnifiedMurmurBinDir(homeDir), binaryName);
}

/**
 * Builds the strict Apple Developer ID Application designated requirement string
 * passed to `codesign --verify --strict -R ...`.
 */
export function buildMacOsDeveloperIdRequirement(teamId: string): string | null {
  const trimmed = teamId.trim();
  if (!APPLE_TEAM_ID_RE.test(trimmed)) {
    return null;
  }
  return `=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${trimmed}"`;
}

export type SupportedPlatformArch = 'darwin-arm64' | 'darwin-x64' | 'win32-x64';

export type InstalledComponentRecord = {
  componentId: string;
  version: string;
  installDir: string;
  executablePath: string;
  sha256: string;
  publisherId: string;
  installedByHost: true;
  installedAt: string;
};

type PersistedComponentRegistry = {
  schemaVersion: number;
  components: Record<string, InstalledComponentRecord>;
};

export type ArtifactDownloader = (
  url: string,
  destinationPath: string,
  options: {
    timeoutMs: number;
    validateUrl: (candidateUrl: string) => boolean;
  },
) => Promise<{ bytesWritten: number }>;

export type CodeSignatureVerificationResult =
  | { ok: true; teamId: string }
  | { ok: false; reason: string; actualTeamId?: string };

export type CodeSignatureVerifier = (
  filePath: string,
  expectedTeamId: string,
  platform: HostPlatform,
  publisher?: BuiltinPublisherEntry,
) => Promise<CodeSignatureVerificationResult>;

export type InstallComponentAtomDeps = {
  dataDir: string;
  homeDir?: string;
  platform?: HostPlatform;
  arch?: string;
  channel?: HostReleaseChannel;
  allowLocalDevLoopback?: boolean;
  /** Optional path to the host Electron app bundle to enforce out-of-bundle installation. */
  appBundlePath?: string;
  getSignedConfig: () => SignedConfigPayload;
  confirmationGate: FeatureConfirmationGate;
  mutationQueue: SerialMutationQueue;
  registry?: ComponentInstallRegistry;
  /** Optional publisher list override (defaults to `BUILTIN_PUBLISHERS`). */
  publishers?: readonly BuiltinPublisherEntry[];
  downloader?: ArtifactDownloader;
  codeSignatureVerifier?: CodeSignatureVerifier;
  commandRunner?: CommandRunner;
  downloadTimeoutMs?: number;
  now?: () => Date;
};

function normalizePlatform(raw: NodeJS.Platform | HostPlatform): HostPlatform {
  if (raw === 'darwin' || raw === 'win32' || raw === 'linux') return raw;
  return 'linux';
}

function getPlatformArchKey(platform: HostPlatform, arch: string): SupportedPlatformArch | null {
  const key = `${platform}-${arch}`;
  if (key === 'darwin-arm64' || key === 'darwin-x64' || key === 'win32-x64') {
    return key;
  }
  return null;
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const resolvedParent = path.resolve(parentPath);
  const resolvedCandidate = path.resolve(candidatePath);
  const rel = path.relative(resolvedParent, resolvedCandidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function deriveExecutableFileName(componentId: string, artifactUrl: string, platform: HostPlatform): string {
  try {
    const parsed = new URL(artifactUrl);
    const base = path.posix.basename(parsed.pathname);
    if (base && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(base)) {
      if (platform === 'win32' && !base.toLowerCase().endsWith('.exe')) {
        return `${base}.exe`;
      }
      return base;
    }
  } catch {
    // Fall back to componentId
  }
  return platform === 'win32' ? `${componentId}.exe` : componentId;
}

function computeFileSha256(filePath: string): string {
  const bytes = readFileSync(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

function hexDigestsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a.toLowerCase(), 'utf8');
  const bufB = Buffer.from(b.toLowerCase(), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export const defaultArtifactDownloader: ArtifactDownloader = async (url, destinationPath, options) => {
  const downloadWithRedirects = (currentUrl: string, redirectsLeft: number): Promise<{ bytesWritten: number }> => {
    return new Promise((resolve, reject) => {
      if (!options.validateUrl(currentUrl)) {
        reject(new Error(`Download URL outside allowed domain scope: ${currentUrl}`));
        return;
      }
      const parsed = new URL(currentUrl);
      const requestOpts = {
        timeout: options.timeoutMs,
        headers: {
          'user-agent': 'OpenMotion-Host-ComponentInstaller/1.0',
        },
      };
      const onResponse = (res: http.IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many HTTP redirects while downloading component'));
            return;
          }
          const nextUrl = new URL(res.headers.location, currentUrl).toString();
          void downloadWithRedirects(nextUrl, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`Component download failed with HTTP ${status}`));
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          totalBytes += chunk.length;
        });
        res.on('end', () => {
          try {
            mkdirSync(path.dirname(destinationPath), { recursive: true });
            writeFileSync(destinationPath, Buffer.concat(chunks));
            resolve({ bytesWritten: totalBytes });
          } catch (error) {
            reject(error);
          }
        });
        res.on('error', reject);
      };
      const req =
        parsed.protocol === 'https:'
          ? https.get(parsed, requestOpts, onResponse)
          : http.get(parsed, requestOpts, onResponse);
      req.on('timeout', () => {
        req.destroy(new Error(`Component download timed out after ${options.timeoutMs}ms`));
      });
      req.on('error', reject);
    });
  };

  return downloadWithRedirects(url, MAX_REDIRECTS);
};

export function parseMacOsCodesignTeamId(output: string): string | null {
  const match = /^TeamIdentifier=(.+)$/m.exec(output);
  if (!match) return null;
  const value = match[1]!.trim();
  if (!value || value.toLowerCase() === 'not set') {
    return null;
  }
  return value;
}

const WIN_THUMBPRINT_RE = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;

export type WindowsAuthenticodeProbeOutput = {
  Status?: unknown;
  StatusMessage?: unknown;
  Thumbprint?: unknown;
  Sha256Thumbprint?: unknown;
  Subject?: unknown;
};

/**
 * Pure evaluator for Windows `Get-AuthenticodeSignature` JSON output.
 * Requires `Status === 'Valid'` and a constant-time match between the signer
 * certificate's SHA-256 or SHA-1 thumbprint and the publisher's pinned list.
 */
export function evaluateWindowsAuthenticodeResult(
  raw: WindowsAuthenticodeProbeOutput | null | undefined,
  expectedThumbprints: readonly string[],
): CodeSignatureVerificationResult {
  const validExpected = expectedThumbprints
    .map(item => item.trim().toLowerCase())
    .filter(item => WIN_THUMBPRINT_RE.test(item));
  if (validExpected.length === 0) {
    return {
      ok: false,
      reason: 'Windows Authenticode publisher thumbprint is not configured for this publisher',
    };
  }
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      reason: 'Windows Authenticode signature probe returned empty output',
    };
  }
  const status = typeof raw.Status === 'string' ? raw.Status.trim() : '';
  if (status !== 'Valid') {
    const detail = typeof raw.StatusMessage === 'string' && raw.StatusMessage.trim()
      ? ` (${raw.StatusMessage.trim()})`
      : '';
    return {
      ok: false,
      reason: `Windows Authenticode signature is not valid: status=${status || 'Unknown'}${detail}`,
    };
  }

  const sha1 = typeof raw.Thumbprint === 'string' ? raw.Thumbprint.trim().toLowerCase() : '';
  const sha256 = typeof raw.Sha256Thumbprint === 'string' ? raw.Sha256Thumbprint.trim().toLowerCase() : '';
  const actualCandidates = [sha256, sha1].filter(candidate => WIN_THUMBPRINT_RE.test(candidate));
  if (actualCandidates.length === 0) {
    return {
      ok: false,
      reason: 'Windows Authenticode signature is missing signer certificate thumbprint',
    };
  }

  for (const expected of validExpected) {
    for (const actual of actualCandidates) {
      if (expected.length === actual.length && hexDigestsEqual(actual, expected)) {
        return { ok: true, teamId: actual.toUpperCase() };
      }
    }
  }

  return {
    ok: false,
    reason: 'Windows Authenticode signer certificate thumbprint does not match allowlisted publisher',
    actualTeamId: actualCandidates[0]!.toUpperCase(),
  };
}

export const defaultCodeSignatureVerifier: CodeSignatureVerifier = async (
  filePath,
  expectedTeamId,
  platform,
  publisher,
) => {
  if (platform === 'win32') {
    const pinnedThumbprints = [
      ...(publisher?.windowsThumbprints ?? []),
      ...(WIN_THUMBPRINT_RE.test(expectedTeamId.trim()) ? [expectedTeamId.trim()] : []),
    ];
    if (pinnedThumbprints.length === 0) {
      return {
        ok: false,
        reason: 'Windows Authenticode publisher thumbprint is not configured for this publisher',
      };
    }

    const psScript = [
      '$ErrorActionPreference = "Stop"',
      '$sig = Get-AuthenticodeSignature -LiteralPath $env:OM_VERIFY_FILE',
      '$cert = $sig.SignerCertificate',
      '$sha256 = ""',
      'if ($null -ne $cert) {',
      '  $hasher = [System.Security.Cryptography.SHA256]::Create()',
      '  try { $sha256 = ([System.BitConverter]::ToString($hasher.ComputeHash($cert.RawData)) -replace "-", "") } finally { $hasher.Dispose() }',
      '}',
      '[PSCustomObject]@{',
      '  Status = [string]$sig.Status',
      '  StatusMessage = [string]$sig.StatusMessage',
      '  Thumbprint = if ($null -ne $cert) { [string]$cert.Thumbprint } else { "" }',
      '  Sha256Thumbprint = $sha256',
      '  Subject = if ($null -ne $cert) { [string]$cert.Subject } else { "" }',
      '} | ConvertTo-Json -Compress',
    ].join('; ');

    return new Promise(resolve => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
        {
          encoding: 'utf8',
          timeout: 15_000,
          shell: false,
          maxBuffer: 256 * 1024,
          windowsHide: true,
          env: {
            ...process.env,
            OM_VERIFY_FILE: filePath,
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            const errStr = typeof stderr === 'string' ? stderr.trim() : '';
            resolve({
              ok: false,
              reason: `Windows Authenticode verification failed: ${errStr || error.message}`,
            });
            return;
          }
          try {
            const parsed = JSON.parse(String(stdout || '').trim()) as WindowsAuthenticodeProbeOutput;
            resolve(evaluateWindowsAuthenticodeResult(parsed, pinnedThumbprints));
          } catch (parseErr) {
            resolve({
              ok: false,
              reason: `Windows Authenticode probe returned malformed JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
            });
          }
        },
      );
    });
  }

  if (!expectedTeamId || !expectedTeamId.trim()) {
    return { ok: false, reason: 'Expected publisher Team ID is empty' };
  }
  if (platform !== 'darwin') {
    return {
      ok: false,
      reason: `No built-in code signature verifier configured for platform "${platform}"`,
    };
  }

  const trimmedTeamId = expectedTeamId.trim();
  const requirement = buildMacOsDeveloperIdRequirement(trimmedTeamId);
  if (!requirement) {
    return {
      ok: false,
      reason: `Expected publisher Team ID "${trimmedTeamId}" is not a valid 10-character Apple Team ID`,
    };
  }

  return new Promise(resolve => {
    execFile(
      '/usr/bin/codesign',
      ['--verify', '--strict', '-R', requirement, filePath],
      {
        encoding: 'utf8',
        timeout: 10_000,
        shell: false,
        maxBuffer: 256 * 1024,
      },
      (error, _stdout, stderr) => {
        const errStr = typeof stderr === 'string' ? stderr : '';
        if (error) {
          resolve({
            ok: false,
            reason: `Apple Developer ID codesign verification failed: ${errStr.trim() || error.message}`,
          });
          return;
        }
        resolve({ ok: true, teamId: trimmedTeamId });
      },
    );
  });
};

export class ComponentInstallRegistry {
  private readonly componentsRoot: string;
  private readonly extraAllowedRoots: readonly string[];
  private readonly registryPath: string;

  constructor(dataDir: string, options?: { extraAllowedRoots?: readonly string[] }) {
    this.componentsRoot = path.resolve(dataDir, COMPONENTS_DIR_NAME);
    this.extraAllowedRoots = (options?.extraAllowedRoots ?? []).map(root => path.resolve(root));
    this.registryPath = path.join(this.componentsRoot, REGISTRY_FILE_NAME);
  }

  getComponentsRoot(): string {
    return this.componentsRoot;
  }

  isAllowedInstallPath(candidatePath: string): boolean {
    if (isPathInside(this.componentsRoot, candidatePath)) return true;
    return this.extraAllowedRoots.some(root => isPathInside(root, candidatePath));
  }

  getInstalled(componentId: string): InstalledComponentRecord | null {
    const all = this.readAll();
    const record = all[componentId];
    if (!record) return null;
    if (!record.installedByHost) return null;
    if (!this.isAllowedInstallPath(record.executablePath)) return null;
    if (!existsSync(record.executablePath)) return null;
    return record;
  }

  listInstalled(): InstalledComponentRecord[] {
    return Object.values(this.readAll()).filter(
      record =>
        record.installedByHost &&
        this.isAllowedInstallPath(record.executablePath) &&
        existsSync(record.executablePath),
    );
  }

  recordInstall(record: InstalledComponentRecord): void {
    const all = this.readAll();
    all[record.componentId] = record;
    this.writeAll(all);
  }

  removeRecord(componentId: string): InstalledComponentRecord | null {
    const all = this.readAll();
    const existing = all[componentId] ?? null;
    if (!existing) return null;
    delete all[componentId];
    this.writeAll(all);
    return existing;
  }

  private readAll(): Record<string, InstalledComponentRecord> {
    if (!existsSync(this.registryPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.registryPath, 'utf8')) as Partial<PersistedComponentRegistry>;
      if (!parsed || typeof parsed.components !== 'object' || !parsed.components) {
        return {};
      }
      return { ...parsed.components };
    } catch {
      return {};
    }
  }

  private writeAll(components: Record<string, InstalledComponentRecord>): void {
    mkdirSync(this.componentsRoot, { recursive: true });
    const payload: PersistedComponentRegistry = {
      schemaVersion: 1,
      components,
    };
    const tmpPath = `${this.registryPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, this.registryPath);
  }
}

export class InstallComponentAtom {
  private readonly homeDir?: string;
  private readonly platform: HostPlatform;
  private readonly arch: string;
  private readonly channel: HostReleaseChannel;
  private readonly allowLocalDevLoopback: boolean;
  private readonly appBundlePath?: string;
  private readonly getSignedConfig: () => SignedConfigPayload;
  private readonly confirmationGate: FeatureConfirmationGate;
  private readonly mutationQueue: SerialMutationQueue;
  private readonly registry: ComponentInstallRegistry;
  private readonly publishers: readonly BuiltinPublisherEntry[];
  private readonly downloader: ArtifactDownloader;
  private readonly codeSignatureVerifier: CodeSignatureVerifier;
  private readonly commandRunner?: CommandRunner;
  private readonly downloadTimeoutMs: number;
  private readonly now: () => Date;

  constructor(deps: InstallComponentAtomDeps) {
    this.homeDir = deps.homeDir;
    this.platform = normalizePlatform(deps.platform ?? process.platform);
    this.arch = deps.arch ?? process.arch;
    this.channel = deps.channel ?? 'stable';
    this.allowLocalDevLoopback = deps.allowLocalDevLoopback ?? false;
    this.appBundlePath = deps.appBundlePath;
    this.getSignedConfig = deps.getSignedConfig;
    this.confirmationGate = deps.confirmationGate;
    this.mutationQueue = deps.mutationQueue;
    const extraAllowedRoots = deps.homeDir ? [getUnifiedMurmurBinDir(deps.homeDir)] : undefined;
    this.registry = deps.registry ?? new ComponentInstallRegistry(deps.dataDir, { extraAllowedRoots });
    this.publishers = deps.publishers ?? BUILTIN_PUBLISHERS;
    this.downloader = deps.downloader ?? defaultArtifactDownloader;
    this.codeSignatureVerifier = deps.codeSignatureVerifier ?? defaultCodeSignatureVerifier;
    this.commandRunner = deps.commandRunner;
    this.downloadTimeoutMs = deps.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.now = deps.now ?? (() => new Date());
  }

  getRegistry(): ComponentInstallRegistry {
    return this.registry;
  }

  preview(params: AtomInstallComponentParams): HostInvokeResult<{
    componentId: string;
    version: string;
    installDir: string;
    facts: ConfirmationFact[];
  }> {
    const resolved = this.resolveAndValidateManifest(params.componentId);
    if (!resolved.ok) return resolved;
    const { manifest, artifact, installDir } = resolved.data;
    return hostOk({
      componentId: manifest.componentId,
      version: manifest.minVersion,
      installDir,
      facts: this.buildInstallFacts(manifest, artifact, installDir),
    });
  }

  status(params: { componentId: string }): HostInvokeResult<{
    componentId: string;
    installed: boolean;
    record?: InstalledComponentRecord;
  }> {
    if (!params?.componentId || !SAFE_COMPONENT_ID_RE.test(params.componentId)) {
      return hostErr('INVALID_PARAMS', 'Valid componentId is required');
    }
    const record = this.registry.getInstalled(params.componentId);
    return hostOk({
      componentId: params.componentId,
      installed: Boolean(record),
      record: record ?? undefined,
    });
  }

  async install(params: AtomInstallComponentParams): Promise<HostInvokeResult<AtomInstallComponentResult>> {
    if (!params || typeof params !== 'object') {
      return hostErr('INVALID_PARAMS', 'Install component params are required');
    }
    if (!params.featureId || typeof params.featureId !== 'string') {
      return hostErr('INVALID_PARAMS', 'featureId is required');
    }

    const resolved = this.resolveAndValidateManifest(params.componentId);
    if (!resolved.ok) return resolved;
    const { signedConfig, manifest, artifact, publisher, installDir } = resolved.data;

    const authCheck = assertFeatureAllowsResource(params.featureId, signedConfig, {
      kind: 'component',
      id: manifest.componentId,
    });
    if (!authCheck.ok) return authCheck;

    const facts = this.buildInstallFacts(manifest, artifact, installDir);
    const approval = await this.confirmationGate.ensureApproved({
      featureId: params.featureId,
      signedConfig,
      facts,
    });
    if (!approval.ok) return approval;

    return this.mutationQueue.enqueue(async () => {
      // Design Doc M5: Never overwrite or downgrade an already-installed Murmur binary at
      // `~/.murmurant/bin/murmur` (whether standalone or previously installed by this host;
      // Murmur's own updater owns upgrades). Always verify its live publisher signature AND
      // version on disk before reusing it (or return upgrade-required if older than manifest.minVersion).
      const useUnifiedMurmurPath = manifest.componentId === MURMUR_COMPONENT_ID && Boolean(this.homeDir);
      if (useUnifiedMurmurPath) {
        const unifiedBinaryPath = getUnifiedMurmurBinaryPath(this.homeDir!, this.platform);
        if (existsSync(unifiedBinaryPath)) {
          const standaloneSig = await this.codeSignatureVerifier(
            unifiedBinaryPath,
            publisher.appleTeamId,
            this.platform,
            publisher,
          );
          if (!standaloneSig.ok) {
            return hostErr(
              'VERIFICATION_FAILED',
              `Standalone Murmur binary failed publisher signature verification: ${standaloneSig.reason}`,
              {
                componentId: manifest.componentId,
                installPath: unifiedBinaryPath,
                publisherId: publisher.id,
                expectedTeamId: publisher.appleTeamId,
                actualTeamId: standaloneSig.actualTeamId,
              },
            );
          }

          let detectedVersion: string | undefined;
          const runVersion = async (): Promise<{ exitCode: number; stdout: string }> => {
            if (this.commandRunner) {
              return this.commandRunner({
                binaryPath: unifiedBinaryPath,
                argv: ['version'],
                timeoutMs: 5_000,
              });
            }
            return new Promise(resolve => {
              execFile(
                unifiedBinaryPath,
                ['version'],
                { encoding: 'utf8', shell: false, timeout: 5_000, maxBuffer: 64 * 1024 },
                (error, stdout) => {
                  const exitCode = !error
                    ? 0
                    : typeof (error as { code?: unknown }).code === 'number'
                      ? Number((error as { code: number }).code)
                      : 1;
                  resolve({ exitCode, stdout: typeof stdout === 'string' ? stdout : '' });
                },
              );
            });
          };
          try {
            const verRes = await runVersion();
            if (verRes.exitCode === 0) {
              const semverMatch = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(verRes.stdout);
              if (semverMatch?.[1]) {
                detectedVersion = semverMatch[1];
              }
            }
          } catch {
            // Fall through to minVersion check.
          }

          if (!detectedVersion) {
            return hostErr(
              'VERIFICATION_FAILED',
              `Could not determine version of standalone Murmur binary at ${unifiedBinaryPath}`,
              { componentId: manifest.componentId, installPath: unifiedBinaryPath },
            );
          }
          if (compareSemver(detectedVersion, manifest.minVersion) < 0) {
            return hostErr(
              'VERIFICATION_FAILED',
              `Standalone Murmur v${detectedVersion} is older than required v${manifest.minVersion}`,
              {
                componentId: manifest.componentId,
                installPath: unifiedBinaryPath,
                detectedVersion,
                minVersion: manifest.minVersion,
              },
            );
          }

          return hostOk({
            componentId: manifest.componentId,
            version: detectedVersion,
            installPath: unifiedBinaryPath,
            sha256: computeFileSha256(unifiedBinaryPath),
            publisherId: publisher.id,
            alreadyInstalled: true,
            reusedExisting: true,
          });
        }
      }

      // Check if identical version + sha256 + publisher is already installed on disk.
      const existing = this.registry.getInstalled(manifest.componentId);
      if (
        existing &&
        existing.version === manifest.minVersion &&
        existing.publisherId === artifact.publisherId &&
        hexDigestsEqual(existing.sha256, artifact.sha256)
      ) {
        return hostOk({
          componentId: existing.componentId,
          version: existing.version,
          installPath: existing.executablePath,
          sha256: existing.sha256,
          publisherId: existing.publisherId,
          alreadyInstalled: true,
        });
      }

      const stagingDir = useUnifiedMurmurPath
        ? getUnifiedMurmurBinDir(this.homeDir!)
        : path.join(this.registry.getComponentsRoot(), STAGING_DIR_NAME);
      mkdirSync(stagingDir, { recursive: true });
      const stagingFile = path.join(
        stagingDir,
        `.${manifest.componentId}-${process.pid}-${randomBytes(6).toString('hex')}.bin`,
      );

      const urlScopeOpts = {
        channel: this.channel,
        allowLocalDevLoopback: this.allowLocalDevLoopback,
      };

      try {
        await this.downloader(artifact.url, stagingFile, {
          timeoutMs: this.downloadTimeoutMs,
          validateUrl: candidateUrl => isUrlInAllowedDomainScope(candidateUrl, urlScopeOpts),
        });
      } catch (error) {
        rmSync(stagingFile, { force: true });
        return hostErr(
          'EXEC_FAILED',
          `Component download failed: ${error instanceof Error ? error.message : String(error)}`,
          { componentId: manifest.componentId, url: artifact.url },
        );
      }

      // 1. Strict SHA-256 verification
      const actualSha256 = computeFileSha256(stagingFile);
      if (!hexDigestsEqual(actualSha256, artifact.sha256)) {
        rmSync(stagingFile, { force: true });
        return hostErr('VERIFICATION_FAILED', 'Downloaded component SHA-256 checksum mismatch', {
          componentId: manifest.componentId,
          expectedSha256: artifact.sha256.toLowerCase(),
          actualSha256,
        });
      }

      // 2. Strict code signature publisher verification (Apple Team ID / Windows Authenticode)
      const sigResult = await this.codeSignatureVerifier(stagingFile, publisher.appleTeamId, this.platform, publisher);
      if (!sigResult.ok) {
        rmSync(stagingFile, { force: true });
        return hostErr('VERIFICATION_FAILED', sigResult.reason, {
          componentId: manifest.componentId,
          publisherId: publisher.id,
          expectedTeamId: publisher.appleTeamId,
          actualTeamId: sigResult.actualTeamId,
        });
      }

      // 3. Install strictly outside app bundle (Murmur uses unified `~/.murmurant/bin` per M5)
      const executablePath = useUnifiedMurmurPath
        ? getUnifiedMurmurBinaryPath(this.homeDir!, this.platform)
        : path.join(
            path.join(installDir, manifest.minVersion),
            deriveExecutableFileName(manifest.componentId, artifact.url, this.platform),
          );
      const targetDir = path.dirname(executablePath);

      if (this.appBundlePath && isPathInside(this.appBundlePath, executablePath)) {
        rmSync(stagingFile, { force: true });
        return hostErr('POLICY_DENIED', 'Component install path must remain outside the app bundle', {
          componentId: manifest.componentId,
          executablePath,
        });
      }

      mkdirSync(targetDir, { recursive: true });
      renameSync(stagingFile, executablePath);
      if (this.platform !== 'win32') {
        chmodSync(executablePath, 0o755);
      }

      const record: InstalledComponentRecord = {
        componentId: manifest.componentId,
        version: manifest.minVersion,
        installDir,
        executablePath,
        sha256: actualSha256,
        publisherId: artifact.publisherId,
        installedByHost: true,
        installedAt: this.now().toISOString(),
      };
      this.registry.recordInstall(record);

      return hostOk({
        componentId: record.componentId,
        version: record.version,
        installPath: record.executablePath,
        sha256: record.sha256,
        publisherId: record.publisherId,
        alreadyInstalled: false,
      });
    }, `atom.installComponent:${manifest.componentId}`);
  }

  async uninstall(params: AtomInstallComponentParams): Promise<
    HostInvokeResult<{
      componentId: string;
      removed: boolean;
      removedPath?: string;
    }>
  > {
    if (!params?.featureId || !params?.componentId) {
      return hostErr('INVALID_PARAMS', 'featureId and componentId are required');
    }
    if (!SAFE_COMPONENT_ID_RE.test(params.componentId)) {
      return hostErr('INVALID_PARAMS', `Invalid componentId: "${params.componentId}"`);
    }

    const signedConfig = this.getSignedConfig();
    const authCheck = assertFeatureAllowsResource(params.featureId, signedConfig, {
      kind: 'component',
      id: params.componentId,
    });
    if (!authCheck.ok) return authCheck;

    const existing = this.registry.getInstalled(params.componentId);
    if (!existing) {
      return hostErr('NOT_FOUND', `Component "${params.componentId}" was not installed by this host`, {
        componentId: params.componentId,
      });
    }

    const approval = await this.confirmationGate.ensureApproved({
      featureId: params.featureId,
      signedConfig,
      facts: [
        {
          kind: 'modify_file',
          label: `Remove host-installed component (${params.componentId})`,
          value: existing.installDir,
        },
      ],
    });
    if (!approval.ok) return approval;

    return this.mutationQueue.enqueue(async () => {
      const current = this.registry.getInstalled(params.componentId);
      if (!current || !current.installedByHost) {
        return hostErr('NOT_FOUND', `Component "${params.componentId}" was not installed by this host`, {
          componentId: params.componentId,
        });
      }
      if (!this.registry.isAllowedInstallPath(current.executablePath)) {
        return hostErr('POLICY_DENIED', 'Refusing to remove component outside allowed install roots', {
          componentId: params.componentId,
          installDir: current.installDir,
        });
      }
      const inHostComponentsRoot = isPathInside(this.registry.getComponentsRoot(), current.installDir);
      if (inHostComponentsRoot) {
        rmSync(current.installDir, { recursive: true, force: true });
      } else {
        // Unified user bin directory (e.g. ~/.murmurant/bin): remove ONLY the host-installed binary file.
        rmSync(current.executablePath, { force: true });
      }
      this.registry.removeRecord(params.componentId);
      return hostOk({
        componentId: params.componentId,
        removed: true,
        removedPath: inHostComponentsRoot ? current.installDir : current.executablePath,
      });
    }, `atom.installComponent.uninstall:${params.componentId}`);
  }

  private resolveAndValidateManifest(componentId: string): HostInvokeResult<{
    signedConfig: SignedConfigPayload;
    manifest: SignedComponentManifest;
    artifact: SignedComponentPlatformArtifact;
    publisher: BuiltinPublisherEntry;
    installDir: string;
  }> {
    if (!componentId || typeof componentId !== 'string' || !SAFE_COMPONENT_ID_RE.test(componentId)) {
      return hostErr('INVALID_PARAMS', `Invalid componentId: "${String(componentId)}"`);
    }

    const signedConfig = this.getSignedConfig();
    const manifest = signedConfig.components?.[componentId];
    if (!manifest) {
      return hostErr('POLICY_DENIED', `Unknown componentId in signed config: "${componentId}"`, { componentId });
    }
    if (
      typeof manifest.componentId !== 'string' ||
      !SAFE_COMPONENT_ID_RE.test(manifest.componentId) ||
      manifest.componentId !== componentId
    ) {
      return hostErr(
        'POLICY_DENIED',
        `Signed manifest componentId "${String(manifest.componentId)}" is invalid or does not match "${componentId}"`,
        { componentId, manifestComponentId: manifest.componentId },
      );
    }

    const versionCheck = validateTypedPlaceholderValue('semver', manifest.minVersion);
    if (!versionCheck.ok) {
      return hostErr('POLICY_DENIED', `Component "${componentId}" has invalid minVersion: ${versionCheck.reason}`, {
        componentId,
        minVersion: manifest.minVersion,
      });
    }

    const platformKey = getPlatformArchKey(this.platform, this.arch);
    if (!platformKey) {
      return hostErr('UNSUPPORTED', `Unsupported platform/arch for component installation: ${this.platform}-${this.arch}`, {
        platform: this.platform,
        arch: this.arch,
      });
    }

    const artifact = manifest.platforms?.[platformKey];
    if (!artifact) {
      return hostErr('UNSUPPORTED', `Component "${componentId}" has no artifact for ${platformKey}`, {
        componentId,
        platformKey,
      });
    }

    if (
      !isUrlInAllowedDomainScope(artifact.url, {
        channel: this.channel,
        allowLocalDevLoopback: this.allowLocalDevLoopback,
      })
    ) {
      return hostErr('POLICY_DENIED', `Component download URL is outside allowed domain scope: ${artifact.url}`, {
        componentId,
        url: artifact.url,
      });
    }

    if (!/^[a-fA-F0-9]{64}$/.test(artifact.sha256)) {
      return hostErr('VERIFICATION_FAILED', 'Manifest sha256 must be a valid 64-char hex digest', {
        componentId,
      });
    }

    const publisher = this.publishers.find(entry => entry.id === artifact.publisherId);
    if (!publisher) {
      return hostErr('POLICY_DENIED', `Publisher "${artifact.publisherId}" is not in built-in allowlist`, {
        componentId,
        publisherId: artifact.publisherId,
      });
    }

    const installDir =
      manifest.componentId === MURMUR_COMPONENT_ID && this.homeDir
        ? getUnifiedMurmurBinDir(this.homeDir)
        : path.join(this.registry.getComponentsRoot(), manifest.componentId);
    if (this.appBundlePath && isPathInside(this.appBundlePath, installDir)) {
      return hostErr('POLICY_DENIED', 'Component install directory must be outside the app bundle', {
        componentId,
        installDir,
      });
    }

    return hostOk({
      signedConfig,
      manifest,
      artifact,
      publisher,
      installDir,
    });
  }

  private buildInstallFacts(
    manifest: SignedComponentManifest,
    artifact: SignedComponentPlatformArtifact,
    installDir: string,
  ): ConfirmationFact[] {
    return [
      {
        kind: 'install_component',
        label: `Install ${manifest.displayName} (${manifest.componentId} v${manifest.minVersion})`,
        value: `publisher=${artifact.publisherId}, sha256=${artifact.sha256.slice(0, 12)}…`,
      },
      {
        kind: 'connect_url',
        label: `Download ${manifest.displayName}`,
        value: artifact.url,
      },
      {
        kind: 'modify_file',
        label: 'Install directory (outside app bundle)',
        value: installDir,
      },
    ];
  }
}

export function createInstallComponentAtom(deps: InstallComponentAtomDeps): InstallComponentAtom {
  return new InstallComponentAtom(deps);
}
