import { formatFileVersion } from './etag.ts';
import type { BlobMetadata, BlobScope } from '../contracts/storage.ts';

/**
 * Pure read-only virtual file entry representing one file in a cloud project's working tree.
 * The legacy sha256 field contains a content digest for CAS scopes or a logical ID for patch scope.
 */
export interface VirtualFileRecord {
  readonly path: string;
  readonly blobScope: BlobScope;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly isText: boolean;
  readonly updatedAt: Date;
  readonly metadata?: BlobMetadata | null;
}

/**
 * In-memory snapshot of a project's virtual file tree used by the 4 pure Hyperframes engines:
 * `bundlePreviewInMemory`, `lintProjectInMemory`, `infoInMemory`, and `timelineInMemory`.
 */
export interface VirtualProjectReader {
  readonly projectId: string;
  readonly projectName: string;
  readonly templateId?: string | null;
  readonly revision: string;
  /** List every file in the project (including `.hyperframes/studio-*.json`). */
  listFiles(): readonly VirtualFileRecord[];
  /** Lookup file metadata by project-relative POSIX path. */
  getFile(filePath: string): VirtualFileRecord | null;
  /** Synchronously read a preloaded text file (returns null if missing or non-text). */
  readText(filePath: string): string | null;
  /** Check whether a project-relative POSIX path exists in the virtual file tree. */
  exists(filePath: string): boolean;
  /** Read cached ffprobe / Sharp metadata from `workspace_blobs` or `catalog_template_files`. */
  getBlobMetadata(filePath: string): BlobMetadata | null;
}

/**
 * Concrete in-memory snapshot implementation constructed from PG rows + HotTextCache/S3 text contents.
 */
export class InMemoryVirtualProject implements VirtualProjectReader {
  readonly projectId: string;
  readonly projectName: string;
  readonly templateId?: string | null;
  readonly revision: string;
  private readonly filesByPath: ReadonlyMap<string, VirtualFileRecord>;
  private readonly textByPath: ReadonlyMap<string, string>;
  private readonly orderedFiles: readonly VirtualFileRecord[];

  constructor(options: {
    projectId: string;
    projectName: string;
    templateId?: string | null;
    revision: string;
    files: readonly VirtualFileRecord[];
    textContents: ReadonlyMap<string, string> | Record<string, string>;
  }) {
    this.projectId = options.projectId;
    this.projectName = options.projectName;
    this.templateId = options.templateId;
    this.revision = options.revision;
    const sorted = [...options.files].sort((a, b) => a.path.localeCompare(b.path));
    this.orderedFiles = sorted;
    const fileMap = new Map<string, VirtualFileRecord>();
    for (const file of sorted) {
      fileMap.set(file.path, file);
    }
    this.filesByPath = fileMap;
    this.textByPath =
      options.textContents instanceof Map
        ? new Map(options.textContents)
        : new Map(Object.entries(options.textContents));
  }

  listFiles(): readonly VirtualFileRecord[] {
    return this.orderedFiles;
  }

  getFile(filePath: string): VirtualFileRecord | null {
    return this.filesByPath.get(normalizeVirtualPath(filePath)) ?? null;
  }

  getFileVersion(filePath: string): string | null {
    const file = this.getFile(filePath);
    return file ? formatFileVersion(file.blobScope, file.sha256) : null;
  }

  readText(filePath: string): string | null {
    return this.textByPath.get(normalizeVirtualPath(filePath)) ?? null;
  }

  exists(filePath: string): boolean {
    return this.filesByPath.has(normalizeVirtualPath(filePath));
  }

  getBlobMetadata(filePath: string): BlobMetadata | null {
    return this.filesByPath.get(normalizeVirtualPath(filePath))?.metadata ?? null;
  }
}

/**
 * Resolve a relative POSIX path from `fromDir` (a project-relative directory such as `""` or `"compositions"`)
 * while strictly refusing escapes above the project root.
 */
export function resolveVirtualPath(fromDir: string, relativeRef: string): string | null {
  const cleaned = relativeRef.replace(/\\/g, '/').trim();
  if (!cleaned || cleaned.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(cleaned)) {
    return null;
  }
  const baseParts = fromDir ? fromDir.split('/').filter(Boolean) : [];
  const rawParts = cleaned.startsWith('/') ? cleaned.slice(1).split('/') : [...baseParts, ...cleaned.split('/')];
  const resolved: string[] = [];
  for (const part of rawParts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (resolved.length === 0) return null;
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  if (resolved.length === 0) return null;
  return resolved.join('/');
}

/** Older projects sometimes stored project-relative references inside nested compositions. */
export function resolveCompositionReference(project: VirtualProjectReader, owner: string, ref: string): string | null {
  const local = resolveVirtualPath(virtualDirname(owner), ref);
  if (!local || project.exists(local)) return local;
  const legacy = resolveVirtualPath('', ref);
  return legacy && project.exists(legacy) ? legacy : local;
}

export function normalizeVirtualPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
}

export function virtualDirname(filePath: string): string {
  const normalized = normalizeVirtualPath(filePath);
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? '' : normalized.slice(0, idx);
}

/**
 * List composition HTML files present in a virtual project (index.html first, then compositions/**.html).
 */
export function listVirtualCompositions(files: readonly Pick<VirtualFileRecord, 'path'>[]): string[] {
  const compositions: string[] = [];
  let hasIndex = false;
  for (const file of files) {
    if (file.path === 'index.html') {
      hasIndex = true;
    } else if (
      file.path.endsWith('.html') &&
      !file.path.startsWith('.') &&
      !file.path.startsWith('compositions/components/')
    ) {
      compositions.push(file.path);
    }
  }
  compositions.sort((a, b) => a.localeCompare(b));
  return hasIndex ? ['index.html', ...compositions] : compositions;
}
