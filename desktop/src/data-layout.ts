/**
 * R5 — Out-of-Bundle Desktop Data Directory Layout Manager.
 *
 * Initializes and validates the versioned directory structure under `<userData>`:
 * - `layout.json` (`formatVersion`, `appId`, `createdAt`, `updatedAt`)
 * - `config/` (signed configuration & monotonic sequence state)
 * - `components/` (externally installed first-party components)
 * - `approvals/` (feature confirmation records)
 * - `logs/` (redacted diagnostic logs & crash markers)
 * - `cache/` (ephemeral downloads & verification scratch space)
 *
 * Backward-compatibility invariant:
 * NEVER reads, mutates, migrates, or deletes legacy `workspace-data/` or
 * `~/.local/share/openmotion` directories.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DESKTOP_APP_ID,
  DESKTOP_DATA_LAYOUT_VERSION,
} from '../../shared/desktop-builtin-rules.ts';

export const DESKTOP_LAYOUT_FILENAME = 'layout.json' as const;

export const DESKTOP_DATA_SUBDIRS = [
  'config',
  'components',
  'approvals',
  'logs',
  'cache',
] as const;

export type DesktopDataSubdir = (typeof DESKTOP_DATA_SUBDIRS)[number];

export type DesktopDataLayoutMetadata = {
  formatVersion: number;
  appId: string;
  createdAt: string;
  updatedAt: string;
};

export type DesktopDataLayoutPaths = {
  rootDir: string;
  layoutFile: string;
  configDir: string;
  componentsDir: string;
  approvalsDir: string;
  logsDir: string;
  cacheDir: string;
};

export type EnsuredDesktopDataLayout = {
  paths: DesktopDataLayoutPaths;
  metadata: DesktopDataLayoutMetadata;
  created: boolean;
  upgraded: boolean;
};

export class DesktopDataLayoutVersionError extends Error {
  readonly foundVersion: number;
  readonly supportedVersion: number;
  readonly layoutFile: string;

  constructor(layoutFile: string, foundVersion: number, supportedVersion: number) {
    super(
      `Unsupported desktop data layout formatVersion ${foundVersion} in ${layoutFile} (supported <= ${supportedVersion})`,
    );
    this.name = 'DesktopDataLayoutVersionError';
    this.layoutFile = layoutFile;
    this.foundVersion = foundVersion;
    this.supportedVersion = supportedVersion;
  }
}

function isValidMetadataRecord(raw: unknown): raw is DesktopDataLayoutMetadata {
  if (!raw || typeof raw !== 'object') return false;
  const candidate = raw as Record<string, unknown>;
  return (
    typeof candidate.formatVersion === 'number' &&
    Number.isInteger(candidate.formatVersion) &&
    candidate.formatVersion >= 1 &&
    typeof candidate.appId === 'string' &&
    candidate.appId.length > 0 &&
    typeof candidate.createdAt === 'string' &&
    candidate.createdAt.length > 0 &&
    typeof candidate.updatedAt === 'string' &&
    candidate.updatedAt.length > 0
  );
}

function writeJsonAtomically(targetPath: string, payload: DesktopDataLayoutMetadata): void {
  const dir = path.dirname(targetPath);
  const tempPath = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`,
  );
  const serialized = JSON.stringify(payload, null, 2) + '\n';
  try {
    writeFileSync(tempPath, serialized, 'utf8');
    renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Ignore temp cleanup failure.
    }
    throw error;
  }
}

/**
 * Resolves the canonical out-of-bundle paths under `<userData>` without touching disk.
 */
export function resolveDesktopDataLayoutPaths(userDataDir: string): DesktopDataLayoutPaths {
  const trimmed = userDataDir.trim();
  if (!trimmed) {
    throw new Error('userDataDir must be a non-empty path');
  }
  const rootDir = path.resolve(trimmed);
  return {
    rootDir,
    layoutFile: path.join(rootDir, DESKTOP_LAYOUT_FILENAME),
    configDir: path.join(rootDir, 'config'),
    componentsDir: path.join(rootDir, 'components'),
    approvalsDir: path.join(rootDir, 'approvals'),
    logsDir: path.join(rootDir, 'logs'),
    cacheDir: path.join(rootDir, 'cache'),
  };
}

/**
 * Reads `layout.json` from `<userData>` if present and valid; returns `null` otherwise.
 */
export function readDesktopDataLayoutMetadata(userDataDir: string): DesktopDataLayoutMetadata | null {
  const paths = resolveDesktopDataLayoutPaths(userDataDir);
  if (!existsSync(paths.layoutFile)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.layoutFile, 'utf8'));
    return isValidMetadataRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Ensures the versioned out-of-bundle directory layout and `layout.json` exist under `<userData>`.
 * Never inspects, modifies, or deletes legacy `workspace-data/` or `~/.local/share/openmotion`.
 */
export function ensureDesktopDataLayout(
  userDataDir: string,
  options?: { now?: () => Date },
): EnsuredDesktopDataLayout {
  const paths = resolveDesktopDataLayoutPaths(userDataDir);
  const nowIso = (options?.now ? options.now() : new Date()).toISOString();

  mkdirSync(paths.rootDir, { recursive: true });
  for (const subdir of DESKTOP_DATA_SUBDIRS) {
    mkdirSync(path.join(paths.rootDir, subdir), { recursive: true });
  }

  const existing = readDesktopDataLayoutMetadata(paths.rootDir);
  if (existing) {
    if (existing.formatVersion > DESKTOP_DATA_LAYOUT_VERSION) {
      throw new DesktopDataLayoutVersionError(
        paths.layoutFile,
        existing.formatVersion,
        DESKTOP_DATA_LAYOUT_VERSION,
      );
    }

    const upgraded =
      existing.formatVersion < DESKTOP_DATA_LAYOUT_VERSION || existing.appId !== DESKTOP_APP_ID;

    const updated: DesktopDataLayoutMetadata = {
      formatVersion: DESKTOP_DATA_LAYOUT_VERSION,
      appId: DESKTOP_APP_ID,
      createdAt: existing.createdAt,
      updatedAt: nowIso,
    };
    writeJsonAtomically(paths.layoutFile, updated);

    return {
      paths,
      metadata: updated,
      created: false,
      upgraded,
    };
  }

  const createdMetadata: DesktopDataLayoutMetadata = {
    formatVersion: DESKTOP_DATA_LAYOUT_VERSION,
    appId: DESKTOP_APP_ID,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  writeJsonAtomically(paths.layoutFile, createdMetadata);

  return {
    paths,
    metadata: createdMetadata,
    created: true,
    upgraded: false,
  };
}

/**
 * Safely resolves a subpath inside one of the 5 managed data subdirectories,
 * rejecting any attempt to escape via `..` or absolute segments.
 */
export function resolveLayoutSubpath(
  layout: DesktopDataLayoutPaths,
  subdir: DesktopDataSubdir,
  ...segments: string[]
): string {
  const baseDir = path.resolve(layout.rootDir, subdir);
  const resolved = path.resolve(baseDir, ...segments);
  const relative = path.relative(baseDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes desktop data subdir "${subdir}": ${segments.join('/')}`);
  }
  return resolved;
}
