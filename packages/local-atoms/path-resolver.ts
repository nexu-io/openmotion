/**
 * Login-shell PATH resolution & shell-free binary lookup (K7).
 *
 * Solves macOS GUI / Electron minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`)
 * by querying the user's login shell once (bounded timeout, cached) and merging
 * standard Homebrew / nvm / fnm / volta / npm-global / bun / cargo / Windows paths.
 *
 * Target binaries are ALWAYS resolved to absolute paths and executed with
 * `shell: false`; this module never invokes a shell to execute user commands.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostPlatform } from '../../shared/desktop-contract.ts';

export const DEFAULT_LOGIN_SHELL_TIMEOUT_MS = 2_500;

const PATH_START_MARKER = '__OPENMOTION_PATH_START__';
const PATH_END_MARKER = '__OPENMOTION_PATH_END__';
const SAFE_BINARY_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export type LoginShellRunner = (
  shell: string,
  args: readonly string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; exitCode: number }>;

export type PathResolverFs = {
  existsSync: (targetPath: string) => boolean;
  readdirSync: (dirPath: string) => string[];
  isExecutableFile: (filePath: string, platform: HostPlatform) => boolean;
};

export type PathResolverOptions = {
  platform?: HostPlatform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  loginShellTimeoutMs?: number;
  loginShellRunner?: LoginShellRunner;
  fs?: Partial<PathResolverFs>;
  /** Extra directories to check with highest priority (e.g. installed components). */
  extraDirs?: readonly string[];
};

export type ResolveBinaryOptions = {
  extraDirs?: readonly string[];
  forceRefreshPath?: boolean;
};

function normalizePlatform(raw: NodeJS.Platform | HostPlatform): HostPlatform {
  if (raw === 'darwin' || raw === 'win32' || raw === 'linux') {
    return raw;
  }
  return 'linux';
}

function defaultIsExecutableFile(filePath: string, platform: HostPlatform): boolean {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) return false;
    if (platform === 'win32') {
      return /\.(?:exe|cmd|bat|com)$/i.test(filePath);
    }
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function createDefaultFs(overrides?: Partial<PathResolverFs>): PathResolverFs {
  return {
    existsSync: overrides?.existsSync ?? existsSync,
    readdirSync: overrides?.readdirSync ?? ((dirPath: string) => readdirSync(dirPath)),
    isExecutableFile: overrides?.isExecutableFile ?? defaultIsExecutableFile,
  };
}

export const defaultLoginShellRunner: LoginShellRunner = (shell, args, options) => {
  return new Promise(resolve => {
    execFile(
      shell,
      [...args],
      {
        encoding: 'utf8',
        timeout: options.timeoutMs,
        env: options.env,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        shell: false,
      },
      (error, stdout) => {
        if (error) {
          const code = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? Number((error as unknown as { code: number }).code)
            : 1;
          resolve({ stdout: typeof stdout === 'string' ? stdout : '', exitCode: code });
          return;
        }
        resolve({ stdout: typeof stdout === 'string' ? stdout : '', exitCode: 0 });
      },
    );
  });
};

function compareVersionDesc(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/i, '')
      .split('.')
      .map(part => {
        const match = /^(\d+)/.exec(part);
        return match ? Number(match[1]) : 0;
      });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
}

function listSubdirsDesc(dirPath: string, fsImpl: PathResolverFs): string[] {
  if (!fsImpl.existsSync(dirPath)) return [];
  try {
    return [...fsImpl.readdirSync(dirPath)].sort(compareVersionDesc);
  } catch {
    return [];
  }
}

function extractMarkedPath(rawStdout: string): string {
  const startIdx = rawStdout.indexOf(PATH_START_MARKER);
  if (startIdx !== -1) {
    const contentStart = startIdx + PATH_START_MARKER.length;
    const endIdx = rawStdout.indexOf(PATH_END_MARKER, contentStart);
    if (endIdx !== -1) {
      return rawStdout.slice(contentStart, endIdx).trim();
    }
  }
  const lines = rawStdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1]! : '';
}

function getPathOps(platform: HostPlatform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function getDelimiter(platform: HostPlatform): string {
  return platform === 'win32' ? ';' : ':';
}

function collectStandardDirs(
  platform: HostPlatform,
  homeDir: string,
  env: NodeJS.ProcessEnv,
  fsImpl: PathResolverFs,
): string[] {
  const pathOps = getPathOps(platform);
  const dirs: string[] = [];

  if (platform === 'win32') {
    const appData = env.APPDATA || pathOps.join(homeDir, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA || pathOps.join(homeDir, 'AppData', 'Local');
    const userProfile = env.USERPROFILE || homeDir;
    const programFiles = env.ProgramFiles || 'C:\\Program Files';

    dirs.push(
      pathOps.join(appData, 'npm'),
      pathOps.join(localAppData, 'pnpm'),
      pathOps.join(localAppData, 'Volta', 'bin'),
      pathOps.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
      pathOps.join(localAppData, 'Programs'),
      pathOps.join(userProfile, '.local', 'bin'),
      pathOps.join(userProfile, '.volta', 'bin'),
      pathOps.join(userProfile, '.bun', 'bin'),
      pathOps.join(userProfile, '.cargo', 'bin'),
      pathOps.join(programFiles, 'nodejs'),
    );

    const fnmVersionsDir = pathOps.join(localAppData, 'fnm', 'node-versions');
    for (const version of listSubdirsDesc(fnmVersionsDir, fsImpl).slice(0, 3)) {
      dirs.push(pathOps.join(fnmVersionsDir, version, 'installation'));
    }
    return dirs;
  }

  // POSIX (macOS & Linux)
  if (platform === 'darwin') {
    dirs.push('/opt/homebrew/bin', '/opt/homebrew/sbin');
  }
  dirs.push(
    '/usr/local/bin',
    '/usr/local/sbin',
    pathOps.join(homeDir, '.local', 'bin'),
    pathOps.join(homeDir, '.npm-global', 'bin'),
    pathOps.join(homeDir, '.npm', 'bin'),
    pathOps.join(homeDir, '.volta', 'bin'),
    pathOps.join(homeDir, '.bun', 'bin'),
    pathOps.join(homeDir, '.cargo', 'bin'),
    pathOps.join(homeDir, '.asdf', 'shims'),
    pathOps.join(homeDir, '.mise', 'shims'),
    pathOps.join(homeDir, '.yarn', 'bin'),
    pathOps.join(homeDir, '.pnpm'),
  );

  if (platform === 'darwin') {
    dirs.push(
      pathOps.join(homeDir, 'Library', 'pnpm'),
      pathOps.join(homeDir, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
    );
    const macFnmDir = pathOps.join(homeDir, 'Library', 'Application Support', 'fnm', 'node-versions');
    for (const version of listSubdirsDesc(macFnmDir, fsImpl).slice(0, 3)) {
      dirs.push(pathOps.join(macFnmDir, version, 'installation', 'bin'));
    }
  }

  dirs.push(pathOps.join(homeDir, '.fnm', 'aliases', 'default', 'bin'));
  const fnmDir = pathOps.join(homeDir, '.fnm', 'node-versions');
  for (const version of listSubdirsDesc(fnmDir, fsImpl).slice(0, 3)) {
    dirs.push(pathOps.join(fnmDir, version, 'installation', 'bin'));
  }

  const nvmDir = pathOps.join(homeDir, '.nvm', 'versions', 'node');
  for (const version of listSubdirsDesc(nvmDir, fsImpl).slice(0, 3)) {
    dirs.push(pathOps.join(nvmDir, version, 'bin'));
  }

  return dirs;
}

function dedupeDirs(entries: readonly string[], platform: HostPlatform): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of entries) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = platform === 'win32' ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function pickLoginShell(platform: HostPlatform, env: NodeJS.ProcessEnv, fsImpl: PathResolverFs): string | null {
  if (platform === 'win32') return null;
  const candidate = env.SHELL?.trim();
  if (candidate && candidate.startsWith('/') && !candidate.includes('\0') && fsImpl.existsSync(candidate)) {
    return candidate;
  }
  const fallbacks = platform === 'darwin' ? ['/bin/zsh', '/bin/bash', '/bin/sh'] : ['/bin/bash', '/bin/zsh', '/bin/sh'];
  for (const shell of fallbacks) {
    if (fsImpl.existsSync(shell)) {
      return shell;
    }
  }
  return null;
}

export class PathResolver {
  private readonly platform: HostPlatform;
  private readonly homeDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly loginShellTimeoutMs: number;
  private readonly loginShellRunner: LoginShellRunner;
  private readonly fsImpl: PathResolverFs;
  private readonly extraDirs: readonly string[];
  private cachedPath: string | null = null;
  private cachedDirs: string[] | null = null;
  private inFlightResolve: Promise<string[]> | null = null;

  constructor(options: PathResolverOptions = {}) {
    this.platform = normalizePlatform(options.platform ?? process.platform);
    this.homeDir = options.homeDir ?? os.homedir();
    this.env = options.env ?? process.env;
    this.loginShellTimeoutMs = options.loginShellTimeoutMs ?? DEFAULT_LOGIN_SHELL_TIMEOUT_MS;
    this.loginShellRunner = options.loginShellRunner ?? defaultLoginShellRunner;
    this.fsImpl = createDefaultFs(options.fs);
    this.extraDirs = options.extraDirs ?? [];
  }

  clearCache(): void {
    this.cachedPath = null;
    this.cachedDirs = null;
    this.inFlightResolve = null;
  }

  async resolveSearchDirs(options?: { forceRefresh?: boolean }): Promise<string[]> {
    if (!options?.forceRefresh && this.cachedDirs) {
      return [...this.cachedDirs];
    }
    if (!options?.forceRefresh && this.inFlightResolve) {
      const dirs = await this.inFlightResolve;
      return [...dirs];
    }

    const work = this.computeSearchDirs();
    this.inFlightResolve = work;
    try {
      const dirs = await work;
      this.cachedDirs = dirs;
      this.cachedPath = dirs.join(getDelimiter(this.platform));
      return [...dirs];
    } finally {
      if (this.inFlightResolve === work) {
        this.inFlightResolve = null;
      }
    }
  }

  async getExecutablePath(options?: { forceRefresh?: boolean }): Promise<string> {
    if (!options?.forceRefresh && this.cachedPath !== null) {
      return this.cachedPath;
    }
    const dirs = await this.resolveSearchDirs(options);
    return dirs.join(getDelimiter(this.platform));
  }

  /**
   * Resolves a binary name (e.g. `codex`, `claude`, `murmur`) to an absolute
   * executable path without ever invoking a shell for the target binary.
   */
  async resolveBinary(binaryName: string, options?: ResolveBinaryOptions): Promise<string | null> {
    const trimmed = binaryName.trim();
    if (!SAFE_BINARY_NAME_RE.test(trimmed)) {
      return null;
    }

    const pathOps = getPathOps(this.platform);
    const searchDirs = dedupeDirs(
      [...(options?.extraDirs ?? []), ...(await this.resolveSearchDirs({ forceRefresh: options?.forceRefreshPath }))],
      this.platform,
    );

    const candidates = this.buildFilenameCandidates(trimmed);
    for (const dir of searchDirs) {
      for (const fileName of candidates) {
        const candidatePath = pathOps.join(dir, fileName);
        if (this.fsImpl.isExecutableFile(candidatePath, this.platform)) {
          return candidatePath;
        }
      }
    }
    return null;
  }

  private buildFilenameCandidates(binaryName: string): string[] {
    if (this.platform !== 'win32') {
      return [binaryName];
    }
    const hasExtension = /\.[a-zA-Z0-9]+$/.test(binaryName);
    if (hasExtension) {
      return [binaryName];
    }
    const rawPathExt = this.env.PATHEXT || '.EXE;.CMD;.BAT;.COM';
    const exts = rawPathExt
      .split(';')
      .map(ext => ext.trim().toLowerCase())
      .filter(ext => /^\.(?:exe|cmd|bat|com)$/.test(ext));
    const ordered = exts.length > 0 ? exts : ['.exe', '.cmd', '.bat', '.com'];
    // Prefer native .exe over .cmd/.bat shims whenever both exist in the same directory.
    const prioritized = ordered.includes('.exe')
      ? ['.exe', ...ordered.filter(ext => ext !== '.exe')]
      : ordered;
    return prioritized.map(ext => `${binaryName}${ext}`);
  }

  private async computeSearchDirs(): Promise<string[]> {
    const delimiter = getDelimiter(this.platform);
    const basePath = this.env.PATH ?? this.env.Path ?? '';
    const existingDirs = basePath.split(delimiter).filter(Boolean);
    const loginShellDirs = await this.queryLoginShellDirs(delimiter);
    const standardDirs = collectStandardDirs(this.platform, this.homeDir, this.env, this.fsImpl).filter(dir =>
      this.fsImpl.existsSync(dir),
    );

    return dedupeDirs([...this.extraDirs, ...loginShellDirs, ...existingDirs, ...standardDirs], this.platform);
  }

  private async queryLoginShellDirs(delimiter: string): Promise<string[]> {
    const shell = pickLoginShell(this.platform, this.env, this.fsImpl);
    if (!shell) return [];
    try {
      const command = `printf '${PATH_START_MARKER}%s${PATH_END_MARKER}' "$PATH"`;
      const result = await this.loginShellRunner(shell, ['-lc', command], {
        timeoutMs: this.loginShellTimeoutMs,
        env: this.env,
      });
      if (result.exitCode !== 0 || !result.stdout) {
        return [];
      }
      const extracted = extractMarkedPath(result.stdout);
      return extracted ? extracted.split(delimiter).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
}

const defaultResolver = new PathResolver();

export function createPathResolver(options?: PathResolverOptions): PathResolver {
  return new PathResolver(options);
}

export function clearResolvedPathCache(): void {
  defaultResolver.clearCache();
}

export async function getMergedExecutablePath(options?: PathResolverOptions): Promise<string> {
  if (options) {
    return new PathResolver(options).getExecutablePath();
  }
  return defaultResolver.getExecutablePath();
}

export async function resolveBinary(
  binaryName: string,
  options?: PathResolverOptions & ResolveBinaryOptions,
): Promise<string | null> {
  if (
    options &&
    (options.platform !== undefined ||
      options.homeDir !== undefined ||
      options.env !== undefined ||
      options.loginShellTimeoutMs !== undefined ||
      options.loginShellRunner !== undefined ||
      options.fs !== undefined)
  ) {
    const resolver = new PathResolver(options);
    return resolver.resolveBinary(binaryName, {
      extraDirs: options.extraDirs,
      forceRefreshPath: options.forceRefreshPath,
    });
  }
  return defaultResolver.resolveBinary(binaryName, {
    extraDirs: options?.extraDirs,
    forceRefreshPath: options?.forceRefreshPath,
  });
}
