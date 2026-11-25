import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSha256Hex } from '../../shared/project-validation.ts';
import {
  extractFilmstripMeta,
  MAX_FILMSTRIP_JPEG_BYTES,
  validateFilmstripMeta,
  type CompositionFilmstripMeta,
} from '../studio/engine/composition-filmstrip-sprite.ts';

const DEFAULT_REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SAFE_RELATIVE_JPG_RE = /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*\.jpg$/i;

export interface BuiltinFilmstripManifestEntry {
  readonly templateId: string;
  readonly path: string;
  readonly file: string;
  readonly depsSha256: string;
  readonly frameCount: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly aspect: number;
}

export interface BuiltinFilmstripManifest {
  readonly version: 1;
  readonly entries: Readonly<Record<string, BuiltinFilmstripManifestEntry>>;
}

export interface LoadedBuiltinFilmstrip {
  readonly bytes: Buffer;
  readonly meta: CompositionFilmstripMeta;
  readonly templateId: string;
  readonly path: string;
  readonly depsSha256: string;
}

interface RootCacheEntry {
  readonly manifest: Map<string, BuiltinFilmstripManifestEntry>;
  readonly loaded: Map<string, Promise<LoadedBuiltinFilmstrip | null>>;
}

const cacheByRoot = new Map<string, Promise<RootCacheEntry>>();

function isSafeRelativeJpg(relPath: string): boolean {
  if (!relPath || !SAFE_RELATIVE_JPG_RE.test(relPath)) return false;
  return !relPath.split('/').some((seg) => seg === '.' || seg === '..' || !seg);
}

async function loadRootIndex(repoRoot: string): Promise<RootCacheEntry> {
  const filmstripsDir = path.join(repoRoot, 'template-library', 'filmstrips');
  const manifestPath = path.join(filmstripsDir, 'manifest.json');
  const map = new Map<string, BuiltinFilmstripManifestEntry>();
  try {
    const raw = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BuiltinFilmstripManifest>;
    if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
      for (const [sha256, entry] of Object.entries(parsed.entries)) {
        if (!isSha256Hex(sha256) || !entry || typeof entry !== 'object') continue;
        if (typeof entry.file !== 'string' || !isSafeRelativeJpg(entry.file)) continue;
        if (typeof entry.depsSha256 !== 'string' || !isSha256Hex(entry.depsSha256)) continue;
        const validMeta = validateFilmstripMeta({
          frameCount: entry.frameCount,
          frameWidth: entry.frameWidth,
          frameHeight: entry.frameHeight,
          aspect: entry.aspect,
        });
        if (!validMeta) continue;
        map.set(sha256, {
          templateId: typeof entry.templateId === 'string' ? entry.templateId : '',
          path: typeof entry.path === 'string' ? entry.path : '',
          file: entry.file,
          depsSha256: entry.depsSha256,
          frameCount: validMeta.frameCount,
          frameWidth: validMeta.frameWidth,
          frameHeight: validMeta.frameHeight,
          aspect: validMeta.aspect,
        });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      // Degrade cleanly if manifest is unreadable; callers fall back to S3 / SnapDOM.
    }
  }
  return { manifest: map, loaded: new Map() };
}

function getRootIndex(repoRoot: string): Promise<RootCacheEntry> {
  const resolved = path.resolve(repoRoot);
  let entry = cacheByRoot.get(resolved);
  if (!entry) {
    entry = loadRootIndex(resolved);
    cacheByRoot.set(resolved, entry);
  }
  return entry;
}

/**
 * Look up a pre-baked built-in template composition filmstrip by scene HTML `sha256`.
 * Reads lazily from `template-library/filmstrips/` (bundled in the immutable `api` image)
 * and caches validated bytes in memory so cold template opens answer in <1ms with 0 S3 calls.
 */
export async function getBuiltinCompositionFilmstrip(
  sha256: string,
  repoRoot = DEFAULT_REPO_ROOT,
): Promise<LoadedBuiltinFilmstrip | null> {
  if (!isSha256Hex(sha256)) return null;
  const resolvedRoot = path.resolve(repoRoot);
  const index = await getRootIndex(resolvedRoot);
  const manifestEntry = index.manifest.get(sha256);
  if (!manifestEntry) return null;

  let pending = index.loaded.get(sha256);
  if (!pending) {
    const filmstripsDir = path.join(resolvedRoot, 'template-library', 'filmstrips');
    const targetPath = path.resolve(filmstripsDir, manifestEntry.file);
    if (!targetPath.startsWith(filmstripsDir + path.sep)) {
      return null;
    }
    pending = (async (): Promise<LoadedBuiltinFilmstrip | null> => {
      try {
        const bytes = await readFile(targetPath);
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILMSTRIP_JPEG_BYTES) {
          return null;
        }
        const meta = extractFilmstripMeta(bytes);
        if (
          !meta ||
          meta.frameCount !== manifestEntry.frameCount ||
          meta.frameWidth !== manifestEntry.frameWidth ||
          meta.frameHeight !== manifestEntry.frameHeight
        ) {
          return null;
        }
        return {
          bytes,
          meta,
          templateId: manifestEntry.templateId,
          path: manifestEntry.path,
          depsSha256: manifestEntry.depsSha256,
        };
      } catch {
        return null;
      }
    })();
    index.loaded.set(sha256, pending);
  }
  return pending;
}

/** Clear cached built-in filmstrip manifests between unit tests. */
export function clearBuiltinFilmstripCacheForTest(): void {
  cacheByRoot.clear();
}
