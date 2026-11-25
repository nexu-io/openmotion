const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DEFAULT_CONCURRENCY = 6;
const MAX_CONCURRENCY = 12;
const DEFAULT_MAX_ATTEMPTS = 3;

const MACHO_SINGLE_MAGICS = new Set([
  0xfeedface, // MH_MAGIC
  0xfeedfacf, // MH_MAGIC_64
  0xcefaedfe, // MH_CIGAM
  0xcffaedfe, // MH_CIGAM_64
  0xcafebabf, // FAT_MAGIC_64
  0xbfbafeca, // FAT_CIGAM_64
]);

const BUNDLE_EXTENSIONS = new Set([
  '.app',
  '.framework',
  '.xpc',
  '.appex',
  '.plugin',
  '.bundle',
]);

function isMachOFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8);
    const bytesRead = fs.readSync(fd, buf, 0, 8, 0);
    if (bytesRead < 4) return false;
    const magic = buf.readUInt32BE(0);
    if (MACHO_SINGLE_MAGICS.has(magic)) return true;
    // Distinguish universal Mach-O fat binaries (0xCAFEBABE / 0xBEBAFECA) from Java .class files.
    if (bytesRead >= 8 && magic === 0xcafebabe) {
      const nfatArch = buf.readUInt32BE(4);
      return nfatArch >= 1 && nfatArch <= 20;
    }
    if (bytesRead >= 8 && magic === 0xbebafeca) {
      const nfatArch = buf.readUInt32LE(4);
      return nfatArch >= 1 && nfatArch <= 20;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

function shouldIgnorePath(filePath, ignore) {
  if (!ignore) return false;
  const matchers = Array.isArray(ignore) ? ignore : [ignore];
  return matchers.some((matcher) => {
    if (typeof matcher === 'function') return Boolean(matcher(filePath));
    if (matcher instanceof RegExp) return matcher.test(filePath);
    if (typeof matcher === 'string') return filePath.includes(matcher);
    return false;
  });
}

function discoverSignTargets(appPath, { extraBinaries = [], ignore = null } = {}) {
  const contentsDir = path.join(appPath, 'Contents');
  const targets = [];

  function walk(dirPath) {
    let entries;
    try {
      entries = fs.readdirSync(dirPath);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry);
      let stat;
      try {
        stat = fs.lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;

      if (stat.isFile()) {
        if (path.extname(fullPath) === '.cstemp') {
          try {
            fs.rmSync(fullPath, { force: true });
          } catch {
            // Ignore stale temp cleanup failure.
          }
          continue;
        }
        if (isMachOFile(fullPath)) {
          targets.push(fullPath);
        }
      } else if (stat.isDirectory()) {
        walk(fullPath);
        if (BUNDLE_EXTENSIONS.has(path.extname(fullPath))) {
          targets.push(fullPath);
        }
      }
    }
  }

  walk(contentsDir);
  for (const extra of extraBinaries || []) {
    if (extra) targets.push(path.resolve(extra));
  }

  const deduped = [...new Set(targets)];
  return deduped.filter((filePath) => !shouldIgnorePath(filePath, ignore));
}

/**
 * Partitions paths into bottom-up topological waves so no parent bundle is
 * ever signed before all of its descendant Mach-O binaries / nested bundles finish.
 */
function groupSigningLayers(paths) {
  let remaining = [...new Set(paths)];
  const waves = [];

  while (remaining.length > 0) {
    const ready = remaining.filter(
      (candidate) =>
        !remaining.some(
          (other) => other !== candidate && other.startsWith(`${candidate}${path.sep}`),
        ),
    );
    if (ready.length === 0) {
      // Defensive fallback (should be unreachable for acyclic filesystem paths).
      waves.push(remaining);
      break;
    }
    ready.sort();
    waves.push(ready);
    const readySet = new Set(ready);
    remaining = remaining.filter((item) => !readySet.has(item));
  }

  return waves;
}

async function runWithConcurrency(items, concurrency, worker) {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;
  let fatalError = null;

  async function runWorker() {
    while (fatalError === null) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        fatalError = err;
        throw err;
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

function resolveConcurrency(env = process.env) {
  const raw = Number.parseInt(String(env.OM_CODESIGN_CONCURRENCY || ''), 10);
  if (Number.isFinite(raw) && raw >= 1) {
    return Math.min(raw, MAX_CONCURRENCY);
  }
  return DEFAULT_CONCURRENCY;
}

function buildCodesignArgs(filePath, opts, perFileOptions = {}) {
  const identity =
    typeof opts.identity === 'string'
      ? opts.identity
      : opts.identity?.hash || opts.identity?.name;
  if (!identity) {
    throw new Error('[sign-mac] Missing signing identity.');
  }

  const args = ['--sign', identity, '--force'];
  if (opts.keychain) {
    args.push('--keychain', opts.keychain);
  }
  if (perFileOptions.requirements) {
    if (perFileOptions.requirements.startsWith('=')) {
      args.push(`-r${perFileOptions.requirements}`);
    } else {
      args.push('--requirements', perFileOptions.requirements);
    }
  }
  if (perFileOptions.timestamp) {
    args.push(`--timestamp=${perFileOptions.timestamp}`);
  } else {
    args.push('--timestamp');
  }

  const runtimeOptions = [];
  if (perFileOptions.signatureFlags) {
    const flags = Array.isArray(perFileOptions.signatureFlags)
      ? perFileOptions.signatureFlags
      : String(perFileOptions.signatureFlags)
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean);
    runtimeOptions.push(...flags);
  }
  if (perFileOptions.hardenedRuntime !== false) {
    runtimeOptions.push('runtime');
  }
  if (runtimeOptions.length > 0) {
    args.push('--options', [...new Set(runtimeOptions)].join(','));
  }

  if (Array.isArray(perFileOptions.additionalArguments) && perFileOptions.additionalArguments.length > 0) {
    args.push(...perFileOptions.additionalArguments);
  }
  if (perFileOptions.entitlements) {
    args.push('--entitlements', perFileOptions.entitlements);
  }

  args.push(filePath);
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function signSingleTarget(filePath, opts, { maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  const perFileOptions = opts.optionsForFile ? (await opts.optionsForFile(filePath)) || {} : {};
  const args = buildCodesignArgs(filePath, opts, perFileOptions);

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await execFileAsync('codesign', args, { maxBuffer: 10 * 1024 * 1024 });
      return;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delayMs = 1500 * attempt;
        const stderr = (err && err.stderr ? String(err.stderr).trim() : '').split('\n')[0] || '';
        console.warn(
          `[sign-mac] Retry ${attempt}/${maxAttempts - 1} for ${path.basename(filePath)} after ${delayMs}ms${stderr ? `: ${stderr}` : ''}`,
        );
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

async function signMacApp(opts) {
  if (!opts || !opts.app) {
    throw new Error('[sign-mac] Missing opts.app path.');
  }
  const t0 = Date.now();
  const concurrency = resolveConcurrency(process.env);
  const children = discoverSignTargets(opts.app, {
    extraBinaries: opts.binaries || [],
    ignore: opts.ignore || null,
  });
  const waves = groupSigningLayers(children);
  waves.push([opts.app]);

  const totalTargets = waves.reduce((sum, wave) => sum + wave.length, 0);
  const waveSummary = waves.map((w, i) => `W${i + 1}:${w.length}`).join(', ');
  console.log(
    `[sign-mac] Signing ${totalTargets} Mach-O/bundle targets across ${waves.length} waves (${waveSummary}, concurrency=${concurrency})...`,
  );

  for (let i = 0; i < waves.length; i++) {
    const waveStart = Date.now();
    await runWithConcurrency(waves[i], concurrency, (target) => signSingleTarget(target, opts));
    console.log(
      `[sign-mac] Wave ${i + 1}/${waves.length} (${waves[i].length} targets) done in ${((Date.now() - waveStart) / 1000).toFixed(1)}s`,
    );
  }

  const verifyStart = Date.now();
  const verifyArgs = ['--verify', '--deep'];
  if (opts.strictVerify !== false) {
    verifyArgs.push('--strict');
  }
  verifyArgs.push('--verbose=2', opts.app);
  await execFileAsync('codesign', verifyArgs, { maxBuffer: 10 * 1024 * 1024 });

  console.log(
    `[sign-mac] Verified ${path.basename(opts.app)} in ${((Date.now() - verifyStart) / 1000).toFixed(1)}s (total=${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );
}

module.exports = signMacApp;
module.exports.isMachOFile = isMachOFile;
module.exports.discoverSignTargets = discoverSignTargets;
module.exports.groupSigningLayers = groupSigningLayers;
module.exports.runWithConcurrency = runWithConcurrency;
module.exports.buildCodesignArgs = buildCodesignArgs;
module.exports.resolveConcurrency = resolveConcurrency;
