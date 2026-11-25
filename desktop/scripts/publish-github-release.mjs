#!/usr/bin/env node
/**
 * Publishes verified stable desktop installers to an independent GitHub Release
 * tagged `desktop-v<version>` (strictly decoupled from npm `v<version>` releases).
 *
 * Security & release invariants:
 * - Strictly restricted to `channel === 'stable'` and strict `MAJOR.MINOR.PATCH` SemVer.
 * - Never executes shell strings; invokes `gh` via `execFileSync` argument arrays.
 * - Idempotent: creates the release on first publish, or updates assets (`--clobber`) and notes on re-run.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatStructuredReleaseChangelog } from './notify-feishu-release.mjs';

const STRICT_STABLE_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function resolveDesktopReleaseTag(version, channel = 'stable') {
  if (channel !== 'stable') {
    throw new Error(
      `GitHub Release publishing is restricted to the "stable" channel (got "${String(channel ?? '')}")`,
    );
  }
  const normalizedVersion = String(version ?? '').trim();
  if (!STRICT_STABLE_SEMVER_RE.test(normalizedVersion)) {
    throw new Error(
      `Invalid stable desktop version "${normalizedVersion}" (expected strict MAJOR.MINOR.PATCH)`,
    );
  }
  return `desktop-v${normalizedVersion}`;
}

export function expectedStableInstallerNames(version) {
  const normalizedVersion = String(version ?? '').trim();
  if (!STRICT_STABLE_SEMVER_RE.test(normalizedVersion)) {
    throw new Error(
      `Invalid stable desktop version "${normalizedVersion}" (expected strict MAJOR.MINOR.PATCH)`,
    );
  }
  return [
    `OpenDesign-${normalizedVersion}-mac-arm64.dmg`,
    `OpenDesign-${normalizedVersion}-mac-x64.dmg`,
    `OpenDesign-Setup-${normalizedVersion}-win-x64.exe`,
    `OpenDesign-Portable-${normalizedVersion}-win-x64.exe`,
  ];
}

export function computeFileSha256(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

export function buildSha256SumsContent(entries) {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map(({ sha256, name }) => `${sha256}  ${name}`).join('\n') + '\n';
}

function formatByteSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

export function buildGithubReleaseNotes({
  version,
  buildVersion = '',
  publicOrigin = 'https://releases.open-design.ai',
  repository = 'nexu-io/openmotion',
  commits = [],
  manualNotes = '',
  commitSubject = '',
  compareUrl = '',
  checksums = [],
}) {
  const tag = resolveDesktopReleaseTag(version, 'stable');
  const origin = String(publicOrigin || 'https://releases.open-design.ai').replace(/\/+$/, '');
  const cdnBase = `${origin}/open-motion/desktop/stable`;
  const ghDownloadBase = `https://github.com/${repository}/releases/download/${tag}`;

  const [arm64Dmg, x64Dmg, winSetup, winPortable] = expectedStableInstallerNames(version);
  const sizeByName = new Map(checksums.map((entry) => [entry.name, formatByteSize(entry.size)]));

  const rows = [
    {
      platform: 'macOS (Apple Silicon · arm64)',
      file: arm64Dmg,
      note: 'Signed & notarized `.dmg`',
    },
    {
      platform: 'macOS (Intel · x64)',
      file: x64Dmg,
      note: 'Signed & notarized `.dmg`',
    },
    {
      platform: 'Windows (x64 Installer)',
      file: winSetup,
      note: 'Recommended installer with auto-updates',
    },
    {
      platform: 'Windows (x64 Portable)',
      file: winPortable,
      note: 'No-install portable executable',
    },
  ];

  const tableLines = [
    '| Platform | Installer | CDN Mirror | Size | Notes |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((row) => {
      const size = sizeByName.get(row.file) || '—';
      return `| **${row.platform}** | [\`${row.file}\`](${ghDownloadBase}/${row.file}) | [Direct CDN](${cdnBase}/${row.file}) | ${size} | ${row.note} |`;
    }),
  ];

  const changelog = formatStructuredReleaseChangelog({
    commits,
    manualNotes,
    commitSubject,
  });

  const sections = [
    `## OpenMotion Desktop v${version}`,
    '',
    'Cloud-first native desktop client (`OpenDesign`) for OpenMotion Studio on macOS and Windows, with built-in local Agent MCP connection and automatic updates.',
    '',
    buildVersion ? `- **Version:** \`v${version}\` (\`Build ${buildVersion}\`)` : `- **Version:** \`v${version}\``,
    `- **Release tag:** \`${tag}\` (decoupled from npm \`v*\` releases)`,
    `- **Auto-update feed:** \`${cdnBase}\``,
    '',
    '### Downloads',
    '',
    ...tableLines,
    '',
    `SHA-256 verification checksums are attached in [\`SHA256SUMS.txt\`](${ghDownloadBase}/SHA256SUMS.txt).`,
  ];

  if (changelog) {
    sections.push('', '### What Changed', '', changelog);
  }

  if (compareUrl) {
    sections.push('', `**Full Diff:** ${compareUrl}`);
  }

  return sections.join('\n') + '\n';
}

export function publishDesktopGithubRelease({
  channel,
  version,
  buildVersion = '',
  assetsDir,
  targetSha = '',
  publicOrigin = 'https://releases.open-design.ai',
  repository = 'nexu-io/openmotion',
  commits = [],
  manualNotes = '',
  commitSubject = '',
  compareUrl = '',
  stepSummaryPath = '',
  execFile = execFileSync,
}) {
  const tag = resolveDesktopReleaseTag(version, channel);
  const resolvedAssetsDir = path.resolve(String(assetsDir || ''));
  const installerNames = expectedStableInstallerNames(version);

  const checksumEntries = [];
  const uploadPaths = [];
  for (const name of installerNames) {
    const filePath = path.join(resolvedAssetsDir, name);
    if (!existsSync(filePath)) {
      throw new Error(`Missing expected stable desktop installer: ${filePath}`);
    }
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error(`Invalid or empty desktop installer: ${filePath}`);
    }
    checksumEntries.push({
      name,
      sha256: computeFileSha256(filePath),
      size: stat.size,
    });
    uploadPaths.push(filePath);
  }

  const sumsPath = path.join(resolvedAssetsDir, 'SHA256SUMS.txt');
  writeFileSync(sumsPath, buildSha256SumsContent(checksumEntries), 'utf8');
  uploadPaths.push(sumsPath);

  const title = `OpenMotion Desktop v${version}`;
  const notes = buildGithubReleaseNotes({
    version,
    buildVersion,
    publicOrigin,
    repository,
    commits,
    manualNotes,
    commitSubject,
    compareUrl,
    checksums: checksumEntries,
  });

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'openmotion-gh-release-'));
  const notesFile = path.join(tmpDir, 'release-notes.md');
  writeFileSync(notesFile, notes, 'utf8');

  try {
    const repoArgs = repository ? ['--repo', repository] : [];
    let releaseExists = false;
    try {
      execFile('gh', ['release', 'view', tag, ...repoArgs], { stdio: 'ignore' });
      releaseExists = true;
    } catch {
      releaseExists = false;
    }

    if (releaseExists) {
      execFile('gh', ['release', 'upload', tag, ...uploadPaths, '--clobber', ...repoArgs], {
        stdio: 'inherit',
      });
      execFile(
        'gh',
        ['release', 'edit', tag, '--title', title, '--notes-file', notesFile, ...repoArgs],
        { stdio: 'inherit' },
      );
    } else {
      const createArgs = [
        'release',
        'create',
        tag,
        ...uploadPaths,
        '--title',
        title,
        '--notes-file',
        notesFile,
        ...repoArgs,
      ];
      if (targetSha) {
        createArgs.push('--target', targetSha);
      }
      execFile('gh', createArgs, { stdio: 'inherit' });
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const releaseUrl = `https://github.com/${repository}/releases/tag/${tag}`;
  if (stepSummaryPath) {
    appendFileSync(
      stepSummaryPath,
      [
        `### Published GitHub Release · ${tag}`,
        `- Release page: [${title}](${releaseUrl})`,
        ...installerNames.map((name) => `- \`${name}\``),
        '- `SHA256SUMS.txt`',
        '',
      ].join('\n'),
      'utf8',
    );
  }
  return { tag, title, releaseUrl, assets: [...installerNames, 'SHA256SUMS.txt'] };
}

function parseJsonArrayEnv(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

const isCli =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCli) {
  const result = publishDesktopGithubRelease({
    channel: process.env.CHANNEL || '',
    version: process.env.EXPECTED_VERSION || '',
    buildVersion: process.env.RELEASE_BUILD_VERSION || '',
    assetsDir: process.env.RELEASE_ASSETS_DIR || '/tmp/gh-release-assets',
    targetSha: process.env.GITHUB_SHA || '',
    publicOrigin: process.env.RELEASE_PUBLIC_ORIGIN || 'https://releases.open-design.ai',
    repository: process.env.GITHUB_REPOSITORY || 'nexu-io/openmotion',
    commits: parseJsonArrayEnv(process.env.RELEASE_COMMITS_JSON || ''),
    manualNotes: process.env.RELEASE_NOTES || '',
    commitSubject: process.env.COMMIT_SUBJECT || '',
    compareUrl: process.env.COMPARE_URL || '',
    stepSummaryPath: process.env.GITHUB_STEP_SUMMARY || '',
  });
  console.log(`Published GitHub Release: ${result.releaseUrl}`);
}
