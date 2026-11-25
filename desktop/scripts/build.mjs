import { createHash, createPublicKey } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDesktopIcons } from './build-icons.mjs';

const __filename = fileURLToPath(import.meta.url);
const desktopDir = path.resolve(path.dirname(__filename), '..');
const repoRoot = path.resolve(desktopDir, '..');
const require = createRequire(import.meta.url);

const APPLE_TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const WIN_THUMBPRINT_RE = /^[0-9A-F]{40}$|^[0-9A-F]{64}$/;

/**
 * Resolves and validates optional build-time trust anchors injected into the
 * bundled Electron main process via esbuild `define`.
 *
 * - `OPENMOTION_DESKTOP_ROOT_PUBLIC_KEY_SPKI`: Ed25519 SPKI DER (base64 or PEM)
 * - `OPENMOTION_MURMUR_APPLE_TEAM_ID`: 10-char Apple Developer Team ID
 * - `OPENMOTION_MURMUR_WIN_THUMBPRINTS`: comma-separated SHA-1 (40-hex) / SHA-256 (64-hex) cert thumbprints
 * - `SENTRY_DESKTOP_DSN`: public Sentry DSN for main-process error and crash reporting; reporting stays
 *   off when unset, and `OPENMOTION_DESKTOP_REQUIRE_SENTRY_DSN=1` turns a missing value into a build failure
 */
export function resolveBuildTrustAnchors(env = process.env) {
  let rootPublicKeySpki = '';
  const rawRootKey = env.OPENMOTION_DESKTOP_ROOT_PUBLIC_KEY_SPKI?.trim();
  if (rawRootKey) {
    let keyObj;
    try {
      keyObj = rawRootKey.includes('BEGIN PUBLIC KEY')
        ? createPublicKey(rawRootKey)
        : createPublicKey({
            key: Buffer.from(rawRootKey, 'base64'),
            format: 'der',
            type: 'spki',
          });
    } catch (error) {
      throw new Error(
        `Invalid OPENMOTION_DESKTOP_ROOT_PUBLIC_KEY_SPKI: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (keyObj.asymmetricKeyType !== 'ed25519') {
      throw new Error(
        `OPENMOTION_DESKTOP_ROOT_PUBLIC_KEY_SPKI must be an Ed25519 public key (got ${keyObj.asymmetricKeyType ?? 'unknown'})`,
      );
    }
    rootPublicKeySpki = keyObj.export({ format: 'der', type: 'spki' }).toString('base64');
  }

  let murmurAppleTeamId = '';
  const rawTeamId = env.OPENMOTION_MURMUR_APPLE_TEAM_ID?.trim();
  if (rawTeamId) {
    if (!APPLE_TEAM_ID_RE.test(rawTeamId)) {
      throw new Error(
        `Invalid OPENMOTION_MURMUR_APPLE_TEAM_ID "${rawTeamId}" (must be a 10-character uppercase alphanumeric Apple Team ID)`,
      );
    }
    murmurAppleTeamId = rawTeamId;
  }

  let murmurWinThumbprints = '';
  const rawThumbprints = env.OPENMOTION_MURMUR_WIN_THUMBPRINTS?.trim();
  if (rawThumbprints) {
    const parsed = rawThumbprints
      .split(',')
      .map(item => item.trim().toUpperCase())
      .filter(Boolean);
    for (const thumb of parsed) {
      if (!WIN_THUMBPRINT_RE.test(thumb)) {
        throw new Error(
          `Invalid OPENMOTION_MURMUR_WIN_THUMBPRINTS entry "${thumb}" (expected 40-char SHA-1 or 64-char SHA-256 hex digest)`,
        );
      }
    }
    murmurWinThumbprints = parsed.join(',');
  }

  let sentryDsn = '';
  const rawSentryDsn = (env.SENTRY_DESKTOP_DSN || env.OPENMOTION_DESKTOP_SENTRY_DSN || '').trim();
  if (rawSentryDsn) {
    let parsedDsn = null;
    try {
      parsedDsn = new URL(rawSentryDsn);
    } catch {
      parsedDsn = null;
    }
    const projectId = parsedDsn?.pathname.split('/').filter(Boolean).at(-1) ?? '';
    if (
      !parsedDsn ||
      parsedDsn.protocol !== 'https:' ||
      !parsedDsn.username ||
      parsedDsn.search ||
      parsedDsn.hash ||
      !/^\d+$/.test(projectId)
    ) {
      // Never echo the supplied value into build logs.
      throw new Error('Invalid SENTRY_DESKTOP_DSN (expected https://<public-key>@<host>/<project-id>)');
    }
    sentryDsn = parsedDsn.toString();
  } else if (/^(1|true)$/i.test(env.OPENMOTION_DESKTOP_REQUIRE_SENTRY_DSN?.trim() ?? '')) {
    throw new Error('SENTRY_DESKTOP_DSN is required for this build (OPENMOTION_DESKTOP_REQUIRE_SENTRY_DSN is set)');
  }

  return {
    rootPublicKeySpki,
    murmurAppleTeamId,
    murmurWinThumbprints,
    sentryDsn,
    define: {
      __OPENMOTION_EMBEDDED_ROOT_PUBLIC_KEY_SPKI__: JSON.stringify(rootPublicKeySpki),
      __OPENMOTION_MURMUR_APPLE_TEAM_ID__: JSON.stringify(murmurAppleTeamId),
      __OPENMOTION_MURMUR_WIN_THUMBPRINTS__: JSON.stringify(murmurWinThumbprints),
      __OPENMOTION_DESKTOP_SENTRY_DSN__: JSON.stringify(sentryDsn),
    },
  };
}

async function loadEsbuild() {
  const candidates = [
    path.join(repoRoot, 'node_modules', 'esbuild', 'lib', 'main.js'),
    path.join(desktopDir, 'node_modules', 'esbuild', 'lib', 'main.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return await import(pathToFileURL(candidate).href);
    }
  }
  return await import(require.resolve('esbuild', { paths: [repoRoot, desktopDir] }));
}

/**
 * Derives a deterministic RFC 4122 UUID v4 Debug ID from bundle content so
 * builds and uploaded sourcemaps share identical Debug IDs.
 */
export function deriveDeterministicDebugId(seed) {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Injects TC39/Sentry Debug ID metadata into an emitted bundle and its external `.map` file.
 * Appended at the end of the bundle so existing line/column sourcemap mappings stay intact.
 */
export function injectBundleDebugId(jsPath, mapPath = `${jsPath}.map`) {
  if (!existsSync(jsPath) || !existsSync(mapPath)) return null;
  const jsCode = readFileSync(jsPath, 'utf8');
  const mapObj = JSON.parse(readFileSync(mapPath, 'utf8'));
  const debugId =
    typeof mapObj.debugId === 'string' && mapObj.debugId
      ? mapObj.debugId
      : deriveDeterministicDebugId(`${path.basename(jsPath)}\0${jsCode}`);

  mapObj.debugId = debugId;
  writeFileSync(mapPath, JSON.stringify(mapObj), 'utf8');

  if (!jsCode.includes(`//# debugId=${debugId}`)) {
    const snippet = `;(()=>{try{var e=typeof window!="undefined"?window:typeof global!="undefined"?global:typeof globalThis!="undefined"?globalThis:typeof self!="undefined"?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]=${JSON.stringify(debugId)},e._sentryDebugIdIdentifier=${JSON.stringify(`sentry-dbid-${debugId}`)})}catch(e){}})();`;
    writeFileSync(jsPath, `${jsCode}\n${snippet}\n//# debugId=${debugId}\n`, 'utf8');
  }
  return debugId;
}

export async function buildDesktop(options = {}) {
  const esbuild = await loadEsbuild();
  const anchors = resolveBuildTrustAnchors(options.env ?? process.env);
  const distDir = path.join(desktopDir, 'dist');
  const distBrandDir = path.join(distDir, 'brand');
  const desktopNodeModules = path.join(desktopDir, 'node_modules');
  mkdirSync(distDir, { recursive: true });
  mkdirSync(distBrandDir, { recursive: true });

  const mainOutfile = path.join(distDir, 'main.mjs');
  const preloadOutfile = path.join(distDir, 'preload.cjs');

  await Promise.all([
    esbuild.build({
      entryPoints: [path.join(desktopDir, 'src', 'main.ts')],
      outfile: mainOutfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      sourcemap: 'external',
      nodePaths: [desktopNodeModules],
      external: ['electron', 'electron-updater'],
      define: anchors.define,
      banner: {
        js: "import { createRequire as __desktopCreateRequire } from 'node:module'; const require = __desktopCreateRequire(import.meta.url);",
      },
    }),
    esbuild.build({
      entryPoints: [path.join(desktopDir, 'src', 'preload.ts')],
      outfile: preloadOutfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      sourcemap: 'external',
      nodePaths: [desktopNodeModules],
      external: ['electron'],
    }),
  ]);

  injectBundleDebugId(mainOutfile);
  injectBundleDebugId(preloadOutfile);

  for (const htmlFile of ['splash.html', 'retry.html', 'env-switcher.html']) {
    const src = path.join(desktopDir, 'src', htmlFile);
    if (existsSync(src)) {
      copyFileSync(src, path.join(distDir, htmlFile));
    }
  }

  const distScriptsDir = path.join(distDir, 'scripts');
  mkdirSync(distScriptsDir, { recursive: true });
  for (const scriptFile of ['diagnostics.mjs', 'zip.mjs', 'diagnostic-redaction.mjs']) {
    const src = path.join(repoRoot, 'scripts', scriptFile);
    if (existsSync(src)) {
      copyFileSync(src, path.join(distScriptsDir, scriptFile));
    }
  }

  const brandSourceDir = path.join(repoRoot, 'packages', 'design-system', 'brand');
  for (const asset of ['loading-mark.svg', 'loading-wordmark.svg', 'openmotion-logo.svg', 'apple-touch-icon.png']) {
    const src = path.join(brandSourceDir, asset);
    if (existsSync(src)) {
      copyFileSync(src, path.join(distBrandDir, asset));
    }
  }

  const icons = buildDesktopIcons({
    sourceDir: brandSourceDir,
    outDir: path.join(desktopDir, 'build'),
  });
  if (existsSync(icons.iconPng)) {
    copyFileSync(icons.iconPng, path.join(distBrandDir, 'app-icon.png'));
  }

  return { distDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  await buildDesktop();
  console.log('Built desktop main and preload bundles into desktop/dist');
}
