import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractCatalogFileMetadata, mimeTypeForPath, normalizeCatalogAssetPath, sha256Hex,
  type MediaMetadataHints, type PreparedCatalogFile, type PreparedCatalogTemplate,
} from './catalog-template-source.ts';

const DEFAULT_REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const WELCOME_TEMPLATE_ID = 'openmotion-welcome';
export const WELCOME_PROJECT_TITLE = 'OpenMotion 示例短片';
export const WELCOME_PROJECT_TITLE_KEY = 'OpenMotion Sample Video' as const;
export const GSAP_CDN_URL = 'https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js';

export const NATIVE_PROJECT_CONFIG = {
  $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json',
  paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' },
} as const;

export const WELCOME_SHARED_ASSETS: readonly (readonly [string, string])[] = [
  ['packages/design-system/brand/loading-mark.svg', 'assets/brand-mark.svg'],
  ['packages/design-system/fonts/AlbertSans-VariableFont_wght.ttf', 'assets/fonts/AlbertSans.ttf'],
  ['packages/design-system/fonts/Albert-Sans-OFL.txt', 'assets/fonts/Albert-Sans-OFL.txt'],
  ['packages/design-system/opendesign-logo-SOURCE.md', 'assets/brand-NOTICE.md'],
  ['library/skills/openmotion-design-remix/vendor/fonts/libre-baskerville-f5bc4341f15d.ttf', 'assets/fonts/serif.ttf'],
  ['library/skills/openmotion-design-remix/vendor/fonts/libre-baskerville-OFL.txt', 'assets/fonts/Libre-Baskerville-OFL.txt'],
  ['library/skills/openmotion-design-remix/vendor/three-0.147.0/build/three.min.js', 'assets/three.min.js'],
  ['library/skills/openmotion-design-remix/vendor/three-0.147.0/LICENSE', 'assets/three-LICENSE.txt'],
] as const;

export interface BuiltinTemplateDefinition {
  readonly id: string;
  readonly sortOrder: number;
  readonly title: string;
  readonly label: string;
  readonly description: string;
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  readonly posterTime: number;
  readonly author: string;
  readonly sourceUrl: string;
}

/**
 * Built-in templates ordered with `openmotion-welcome` first so even `--limit 1`
 * sync runs always ingest the welcome template required by workspace bootstrap.
 */
export const BUILTIN_TEMPLATES: readonly BuiltinTemplateDefinition[] = [
  {
    id: WELCOME_TEMPLATE_ID,
    sortOrder: 0,
    title: 'OpenMotion Welcome',
    label: 'Official welcome',
    description:
      'An editable brand welcome with kinetic typography, a motion gallery and a three-dimensional closing mark.',
    duration: 37.3,
    width: 1920,
    height: 1080,
    posterTime: 3.8,
    author: 'OpenMotion',
    sourceUrl: 'https://github.com/nexu-io/openmotion/tree/main/template-library/openmotion-welcome',
  },
  {
    id: 'product-promo',
    sortOrder: 1,
    title: 'Product Promo',
    label: '产品宣传',
    description: '从图标开场到多人协作，查看多场景动画与字幕编排。',
    duration: 20,
    width: 1920,
    height: 1080,
    posterTime: 7,
    author: 'Hyperframes',
    sourceUrl:
      'https://github.com/heygen-com/hyperframes/tree/3baf81f9a92615507f76fe8de33e489034ee77ec/registry/examples/product-promo',
  },
  {
    id: 'nyt-graph',
    sortOrder: 2,
    title: 'NYT Graph',
    label: '数据叙事',
    description: '报刊风格的动态图表，查看数据、标注与图形的节奏。',
    duration: 15,
    width: 1920,
    height: 1080,
    posterTime: 9,
    author: 'Hyperframes',
    sourceUrl:
      'https://github.com/heygen-com/hyperframes/tree/3baf81f9a92615507f76fe8de33e489034ee77ec/registry/examples/nyt-graph',
  },
  {
    id: 'decision-tree',
    sortOrder: 3,
    title: 'Decision Tree',
    label: '流程动画',
    description: '逐步展开的决策树，查看节点、连线与分支动画。',
    duration: 10,
    width: 1920,
    height: 1080,
    posterTime: 7,
    author: 'Hyperframes',
    sourceUrl:
      'https://github.com/heygen-com/hyperframes/tree/3baf81f9a92615507f76fe8de33e489034ee77ec/registry/examples/decision-tree',
  },
] as const;

/** List-card data is available before any project or poster bytes are read. */
export function builtinTemplateMetadata(definition: BuiltinTemplateDefinition): PreparedCatalogTemplate {
  return {
    id: definition.id,
    kind: 'builtin',
    catalogVersion: `builtin:${sha256Hex(JSON.stringify(definition))}`,
    sortOrder: definition.sortOrder,
    featuredOrder: null,
    hasHtmlProject: true,
    metadata: {
      title: definition.title,
      label: definition.label,
      subtitle: `${definition.label} · ${definition.author}`,
      description: definition.description,
      author: definition.author,
      collection: 'builtin',
      tags: [definition.label],
      duration: definition.duration,
      width: definition.width,
      height: definition.height,
      ratio: '16:9',
      posterTime: definition.posterTime,
      sourceUrl: definition.sourceUrl,
      posterPath: 'poster.jpg',
      localMedia: { poster: 'poster.jpg' },
    },
    instructionsMd: null,
    motionMd: null,
    files: [],
  };
}

interface RegistryItemManifest {
  files: Array<{ path: string; target: string; type?: string }>;
}

export async function assembleBuiltinTemplate(
  definition: BuiltinTemplateDefinition,
  repoRoot = DEFAULT_REPO_ROOT,
  runtimeRoot = repoRoot,
): Promise<PreparedCatalogTemplate> {
  const templateDir = path.join(repoRoot, 'template-library', definition.id);
  const manifest = JSON.parse(
    await readFile(path.join(templateDir, 'registry-item.json'), 'utf8'),
  ) as RegistryItemManifest;

  const fileMap = new Map<string, PreparedCatalogFile>();
  const addFile = (rawPath: string, bytes: Buffer, isProjectFile: boolean, hints?: MediaMetadataHints) => {
    const normalized = normalizeCatalogAssetPath(rawPath);
    const mimeType = mimeTypeForPath(normalized);
    fileMap.set(normalized, {
      path: normalized,
      sha256: sha256Hex(bytes),
      sizeBytes: bytes.byteLength,
      mimeType,
      metadata: extractCatalogFileMetadata(normalized, bytes, mimeType, hints),
      isProjectFile,
      isAvailable: true,
      bytes,
    });
  };

  for (const item of manifest.files) {
    const target = normalizeCatalogAssetPath(item.target);
    const sourcePath = path.join(templateDir, item.path);
    if (target.endsWith('.html')) {
      const relativeGsap = path.posix.relative(path.posix.dirname(target), 'assets/gsap.min.js');
      const rawHtml = await readFile(sourcePath, 'utf8');
      const rewritten = rawHtml.replaceAll(GSAP_CDN_URL, relativeGsap);
      addFile(target, Buffer.from(rewritten, 'utf8'), true);
    } else {
      const bytes = await readFile(sourcePath);
      const audioHints =
        definition.id === WELCOME_TEMPLATE_ID && target === 'assets/soundtrack.m4a'
          ? { durationSec: definition.duration }
          : undefined;
      addFile(target, bytes, true, audioHints);
    }
  }

  if (definition.id === WELCOME_TEMPLATE_ID) {
    for (const [sourceRel, targetRel] of WELCOME_SHARED_ASSETS) {
      const bytes = await readFile(path.join(repoRoot, sourceRel));
      addFile(targetRel, bytes, true);
    }
  }

  const gsapBytes = await readFile(path.join(runtimeRoot, 'node_modules/gsap/dist/gsap.min.js'));
  addFile('assets/gsap.min.js', gsapBytes, true);

  const licenseBytes = await readFile(path.join(repoRoot, 'template-library/LICENSE'));
  addFile('LICENSE', licenseBytes, true);

  if (definition.id !== WELCOME_TEMPLATE_ID) {
    const noticeBytes = await readFile(path.join(repoRoot, 'template-library/NOTICE.md'));
    addFile('NOTICE.md', noticeBytes, true);
  }

  addFile('hyperframes.json', Buffer.from(JSON.stringify(NATIVE_PROJECT_CONFIG, null, 2), 'utf8'), true);

  // Poster stored in catalog CAS as a non-project asset so cloning never pollutes project_files.
  const posterBytes = await readFile(path.join(templateDir, 'poster.jpg'));
  addFile('poster.jpg', posterBytes, false);

  let instructionsMd: string | null = null;
  try {
    instructionsMd = await readFile(path.join(templateDir, 'TEMPLATE.md'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const files = [...fileMap.values()].sort((a, b) => a.path.localeCompare(b.path));
  const versionHash = createHash('sha256')
    .update(JSON.stringify(files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.sizeBytes }))))
    .digest('hex');

  return {
    ...builtinTemplateMetadata(definition),
    catalogVersion: `builtin:${versionHash}`,
    hasHtmlProject: files.some((f) => f.isProjectFile && f.path === 'index.html'),
    instructionsMd,
    files,
  };
}

// An older clone can predate a declaration present in the image. Only read the known
// template's entry file to find it, without assembling its media or contacting the catalog.
const entryFiles = new Map<string, Promise<string | null>>();

export function readBuiltinTemplateEntry(id?: string | null): Promise<string | null> {
  if (!id || !BUILTIN_TEMPLATES.some(template => template.id === id)) return Promise.resolve(null);
  const existing = entryFiles.get(id);
  if (existing) return existing;
  const entry = readFile(path.join(DEFAULT_REPO_ROOT, 'template-library', id, 'index.html'), 'utf8')
    .catch(() => { entryFiles.delete(id); return null; });
  entryFiles.set(id, entry);
  return entry;
}

// These four sources belong to the immutable image. Retry a failed read on the next request.
const sources = new Map<string, Promise<PreparedCatalogTemplate>>();

export async function getBuiltinTemplateSource(id: string): Promise<PreparedCatalogTemplate | null> {
  const definition = BUILTIN_TEMPLATES.find(template => template.id === id);
  if (!definition) return null;
  let source = sources.get(id);
  if (!source) {
    source = assembleBuiltinTemplate(definition).catch(error => {
      sources.delete(id);
      throw error;
    });
    sources.set(id, source);
  }
  return source;
}
