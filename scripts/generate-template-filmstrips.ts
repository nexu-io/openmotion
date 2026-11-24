import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../shared/entry.ts';
import { isTextProjectPath } from '../shared/project-validation.ts';
import {
  assembleBuiltinTemplate,
  BUILTIN_TEMPLATES,
  type BuiltinTemplateDefinition,
} from '../src/services/builtin-template-source.ts';
import type {
  BuiltinFilmstripManifest,
  BuiltinFilmstripManifestEntry,
} from '../src/services/builtin-filmstrip-store.ts';
import {
  computeCompositionFilmstripDepsDigest,
  extractFilmstripMeta,
  extractIndexHeadMarkup,
} from '../src/studio/engine/composition-filmstrip-sprite.ts';
import {
  listVirtualCompositions,
  type VirtualFileRecord,
} from '../src/studio/virtual-project-store.ts';
import {
  captureCompositionFilmstripSprite,
  launchFilmstripBrowser,
  startVirtualTemplatePreviewServer,
} from '../src/workers/filmstrip-renderer.ts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const FILMSTRIPS_DIR = path.join(REPO_ROOT, 'template-library', 'filmstrips');
const MANIFEST_PATH = path.join(FILMSTRIPS_DIR, 'manifest.json');

function safeSlugForPath(compPath: string): string {
  const stripped = compPath.replace(/^compositions\//i, '').replace(/\.html?$/i, '');
  const slug = stripped.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return slug || 'scene';
}

function prepareAssembledTemplate(assembled: Awaited<ReturnType<typeof assembleBuiltinTemplate>>) {
  const projectFiles = assembled.files.filter((f) => f.isProjectFile && f.bytes !== null);
  const textContents = new Map<string, string>();
  const bytesByPath = new Map<string, { bytes: Buffer; mimeType: string }>();
  const shaByPath = new Map<string, string>();
  const records: VirtualFileRecord[] = projectFiles.map((file) => {
    const isText = isTextProjectPath(file.path);
    if (isText) textContents.set(file.path, file.bytes!.toString('utf8'));
    bytesByPath.set(file.path, { bytes: file.bytes!, mimeType: file.mimeType });
    shaByPath.set(file.path, file.sha256);
    return {
      path: file.path,
      blobScope: 'catalog',
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      mimeType: file.mimeType,
      isText,
      updatedAt: new Date(0),
      metadata: file.metadata,
    };
  });
  const allComps = listVirtualCompositions(records);
  const subComps = allComps.filter((p) => p !== 'index.html');
  const compositions = subComps.length > 0 ? subComps : allComps;
  const indexHead = extractIndexHeadMarkup(textContents.get('index.html'));
  const depsByPath = new Map<string, string>();
  for (const compPath of compositions) {
    const { depsSha256 } = computeCompositionFilmstripDepsDigest({
      compPath,
      files: records,
      indexHead,
      readText: (filePath) => textContents.get(filePath) ?? null,
    });
    depsByPath.set(compPath, depsSha256);
  }
  return { records, textContents, bytesByPath, shaByPath, compositions, depsByPath };
}

async function verifyManifest(selectedTemplates: readonly BuiltinTemplateDefinition[]): Promise<void> {
  const raw = await readFile(MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(raw) as BuiltinFilmstripManifest;
  if (manifest.version !== 1 || !manifest.entries) {
    throw new Error('Invalid template-library/filmstrips/manifest.json');
  }
  const errors: string[] = [];
  for (const def of selectedTemplates) {
    const assembled = await assembleBuiltinTemplate(def, REPO_ROOT, REPO_ROOT);
    const { shaByPath, depsByPath } = prepareAssembledTemplate(assembled);
    for (const [compPath, expectedDepsSha256] of depsByPath) {
      const sha256 = shaByPath.get(compPath);
      if (!sha256) continue;
      const entry = manifest.entries[sha256];
      if (!entry) {
        errors.push(`Missing filmstrip entry for ${def.id}/${compPath} (${sha256})`);
        continue;
      }
      if (entry.depsSha256 !== expectedDepsSha256) {
        errors.push(
          `Stale depsSha256 for ${def.id}/${compPath}: expected ${expectedDepsSha256}, got ${entry.depsSha256}. Re-run 'npm run templates:filmstrips -- --template=${def.id}' to regenerate sprites.`,
        );
        continue;
      }
      const jpgPath = path.join(FILMSTRIPS_DIR, entry.file);
      const bytes = await readFile(jpgPath).catch(() => null);
      if (!bytes) {
        errors.push(`Missing filmstrip JPEG ${entry.file} for ${def.id}/${compPath}`);
        continue;
      }
      const meta = extractFilmstripMeta(bytes);
      if (
        !meta ||
        meta.frameCount !== entry.frameCount ||
        meta.frameWidth !== entry.frameWidth ||
        meta.frameHeight !== entry.frameHeight
      ) {
        errors.push(`Corrupt or mismatched OMFS1 header in ${entry.file}`);
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`Built-in filmstrip verification failed:\n${errors.join('\n')}`);
  }
  console.log(`PASS: verified ${Object.keys(manifest.entries).length} pre-baked built-in composition filmstrips.`);
}

async function run(argv: readonly string[]): Promise<void> {
  const checkOnly = argv.includes('--check');
  if (argv.includes('--sync-manifest-deps')) {
    throw new Error(
      'Advancing depsSha256 without regenerating sprites is unsupported because it can pin stale thumbnails. Run `npm run templates:filmstrips` (optionally with `--template=<id>`) instead.',
    );
  }
  const templateFilter = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--template' && argv[i + 1]) {
      for (const id of argv[++i]!.split(',')) if (id.trim()) templateFilter.add(id.trim());
    } else if (arg.startsWith('--template=')) {
      for (const id of arg.slice('--template='.length).split(',')) if (id.trim()) templateFilter.add(id.trim());
    }
  }

  const selectedTemplates =
    templateFilter.size > 0
      ? BUILTIN_TEMPLATES.filter((t) => templateFilter.has(t.id))
      : BUILTIN_TEMPLATES;

  if (selectedTemplates.length === 0) {
    throw new Error('No matching built-in templates selected.');
  }

  if (checkOnly) {
    await verifyManifest(selectedTemplates);
    return;
  }

  let existingEntries: Record<string, BuiltinFilmstripManifestEntry> = {};
  if (templateFilter.size > 0 && existsSync(MANIFEST_PATH)) {
    const prev = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as Partial<BuiltinFilmstripManifest>;
    if (prev.entries && typeof prev.entries === 'object') {
      existingEntries = { ...prev.entries };
    }
  }

  const browserSession = await launchFilmstripBrowser();
  const entries: Record<string, BuiltinFilmstripManifestEntry> = { ...existingEntries };
  let totalBytes = 0;
  let generatedCount = 0;

  try {
    const page = await browserSession.browser.newPage();
    for (const def of selectedTemplates) {
      const assembled = await assembleBuiltinTemplate(def, REPO_ROOT, REPO_ROOT);
      const { records, textContents, bytesByPath, shaByPath, compositions, depsByPath } =
        prepareAssembledTemplate(assembled);
      const preview = await startVirtualTemplatePreviewServer({
        projectId: `prebake-${assembled.id}`,
        projectName: assembled.id,
        revision: assembled.catalogVersion,
        files: records,
        textContents,
        resolveAsset: (relPath) => bytesByPath.get(relPath) ?? null,
        repoRoot: REPO_ROOT,
      });
      const outDir = path.join(FILMSTRIPS_DIR, def.id);
      await mkdir(outDir, { recursive: true });
      try {
        for (const compPath of compositions) {
          const sha256 = shaByPath.get(compPath);
          const depsSha256 = depsByPath.get(compPath);
          if (!sha256 || !depsSha256) continue;
          const result = await captureCompositionFilmstripSprite(page, preview.origin, compPath);
          const relFile = `${def.id}/${safeSlugForPath(compPath)}.jpg`;
          const outPath = path.join(FILMSTRIPS_DIR, relFile);
          await writeFile(outPath, result.jpeg);
          entries[sha256] = {
            templateId: def.id,
            path: compPath,
            file: relFile,
            depsSha256,
            frameCount: result.frameCount,
            frameWidth: result.frameWidth,
            frameHeight: result.frameHeight,
            aspect: result.aspect,
          };
          totalBytes += result.jpeg.byteLength;
          generatedCount += 1;
          console.log(
            `Generated ${relFile} (${result.frameCount}x ${result.frameWidth}x${result.frameHeight}, ${(result.jpeg.byteLength / 1024).toFixed(1)} KiB, sha256=${sha256.slice(0, 12)})`,
          );
        }
      } finally {
        await preview.close();
      }
    }
  } finally {
    await browserSession.close();
  }

  const sortedEntries: Record<string, BuiltinFilmstripManifestEntry> = {};
  for (const key of Object.keys(entries).sort()) {
    sortedEntries[key] = entries[key]!;
  }
  const manifest: BuiltinFilmstripManifest = {
    version: 1,
    entries: sortedEntries,
  };
  await mkdir(FILMSTRIPS_DIR, { recursive: true });
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(
    `Wrote ${MANIFEST_PATH} with ${generatedCount} filmstrips (${(totalBytes / 1024).toFixed(1)} KiB total).`,
  );
}

if (isMain(import.meta.url)) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
