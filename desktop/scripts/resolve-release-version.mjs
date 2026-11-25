import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const desktopDir = path.resolve(path.dirname(__filename), '..');

const BASE_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const POSITIVE_INT_RE = /^[1-9]\d*$/;
const MAX_WINDOWS_PE_SEGMENT = 65535;

/**
 * Resolves the desktop release SemVer and numeric OS build identifiers.
 *
 * Scheme A (SemVer + CI monotonic build number):
 * - `stable`: keeps `desktop/package.json` `MAJOR.MINOR.PATCH` unchanged (e.g. `0.2.1`)
 * - `test`: bumps patch by +1 and appends `-test.<runNumber>` (plus `.<runAttempt>` on retries),
 *   e.g. `0.2.2-test.42` / `0.2.2-test.42.2`, guaranteeing:
 *     0.2.1 < 0.2.2-test.1 < 0.2.2-test.2 < ... < 0.2.2-test.10 < 0.2.2
 * - `buildVersion` / `buildNumber`: pure numeric `MAJOR.MINOR.PATCH.<runNumber>` and `<runNumber>`
 *   for macOS `CFBundleVersion` and Windows PE `FileVersion` (4th segment <= 65535).
 */
export function resolveDesktopReleaseVersion({
  baseVersion,
  channel,
  runNumber,
  runAttempt = 1,
}) {
  if (channel !== 'test' && channel !== 'stable') {
    throw new Error(`Invalid desktop release channel "${channel}" (expected "test" or "stable")`);
  }

  const normalizedBase = String(baseVersion ?? '').trim();
  const baseMatch = BASE_SEMVER_RE.exec(normalizedBase);
  if (!baseMatch) {
    throw new Error(
      `Invalid desktop base version "${normalizedBase}" (expected strict MAJOR.MINOR.PATCH without prerelease)`,
    );
  }

  const runStr = String(runNumber ?? '').trim();
  if (!POSITIVE_INT_RE.test(runStr)) {
    throw new Error(`Invalid CI runNumber "${runStr}" (expected positive integer)`);
  }
  const runInt = Number.parseInt(runStr, 10);
  if (!Number.isSafeInteger(runInt) || runInt > MAX_WINDOWS_PE_SEGMENT) {
    throw new Error(
      `CI runNumber ${runInt} exceeds Windows PE 16-bit FileVersion limit (${MAX_WINDOWS_PE_SEGMENT})`,
    );
  }

  const attemptStr = String(runAttempt ?? 1).trim();
  if (!POSITIVE_INT_RE.test(attemptStr)) {
    throw new Error(`Invalid CI runAttempt "${attemptStr}" (expected positive integer)`);
  }
  const attemptInt = Number.parseInt(attemptStr, 10);

  const major = Number.parseInt(baseMatch[1], 10);
  const minor = Number.parseInt(baseMatch[2], 10);
  const patch = Number.parseInt(baseMatch[3], 10);

  if (channel === 'stable') {
    return {
      channel,
      baseVersion: normalizedBase,
      version: normalizedBase,
      buildNumber: String(runInt),
      buildVersion: `${major}.${minor}.${patch}.${runInt}`,
    };
  }

  const nextPatch = patch + 1;
  const suffix = attemptInt > 1 ? `${runInt}.${attemptInt}` : `${runInt}`;
  return {
    channel,
    baseVersion: normalizedBase,
    version: `${major}.${minor}.${nextPatch}-test.${suffix}`,
    buildNumber: String(runInt),
    buildVersion: `${major}.${minor}.${nextPatch}.${runInt}`,
  };
}

function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'json') {
      args.json = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = next;
    i++;
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const cli = parseCliArgs(process.argv.slice(2));
  const pkgPath = cli['package-json']
    ? path.resolve(cli['package-json'])
    : path.join(desktopDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const resolved = resolveDesktopReleaseVersion({
    baseVersion: cli['base-version'] ?? pkg.version,
    channel: cli.channel ?? process.env.OPENMOTION_RELEASE_CHANNEL ?? 'test',
    runNumber: cli['run-number'] ?? process.env.GITHUB_RUN_NUMBER ?? '1',
    runAttempt: cli['run-attempt'] ?? process.env.GITHUB_RUN_ATTEMPT ?? '1',
  });

  const githubOutput = cli['github-output'] ?? process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(
      githubOutput,
      [
        `channel=${resolved.channel}`,
        `base_version=${resolved.baseVersion}`,
        `version=${resolved.version}`,
        `build_number=${resolved.buildNumber}`,
        `build_version=${resolved.buildVersion}`,
      ].join('\n') + '\n',
      'utf8',
    );
  }

  if (cli.json) {
    console.log(JSON.stringify(resolved));
  } else {
    console.log(
      `Resolved desktop ${resolved.channel} release version: ${resolved.version} (buildVersion=${resolved.buildVersion}, base=${resolved.baseVersion})`,
    );
  }
}
