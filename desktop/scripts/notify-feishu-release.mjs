import { appendFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

const ALLOWED_FEISHU_HOSTS = new Set(['open.feishu.cn', 'open.larksuite.com']);
const MAX_CHANGELOG_ITEMS = 5;
const DEFAULT_MIRROR_ORIGIN = 'https://mirror.inner.nexu.space';
const DEFAULT_MIRROR_SOURCE = 'od-next';
const DEFAULT_MIRROR_CONSOLE_URL = 'https://ops.inner.nexu.space/mirror/search';
const MIRROR_SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function normalizeOptionalHttpsUrl(raw, label) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'none' || trimmed.toLowerCase() === 'false') {
    return '';
  }
  if (/[\r\n\0]/.test(trimmed)) {
    throw new Error(`${label} must not contain control characters`);
  }
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    throw new Error(`${label} must be an https URL: ${trimmed}`);
  }
  return trimmed.replace(/\/+$/, '');
}

function normalizeMirrorSource(raw) {
  const trimmed = String(raw ?? DEFAULT_MIRROR_SOURCE).trim() || DEFAULT_MIRROR_SOURCE;
  if (!MIRROR_SOURCE_RE.test(trimmed)) {
    throw new Error(`Invalid mirror source slug: ${trimmed}`);
  }
  return trimmed;
}

export function validateFeishuWebhookUrl(rawUrl) {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) {
    throw new Error('Feishu webhook URL is empty');
  }
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'https:' || !ALLOWED_FEISHU_HOSTS.has(parsed.hostname)) {
    throw new Error(`Unsupported Feishu webhook host: ${parsed.origin}`);
  }
  if (!parsed.pathname.startsWith('/open-apis/bot/v2/hook/')) {
    throw new Error(`Unexpected Feishu webhook path: ${parsed.pathname}`);
  }
  return parsed.toString();
}

export function signFeishuWebhook(secret, timestampSeconds) {
  const stringToSign = `${timestampSeconds}\n${secret}`;
  return createHmac('sha256', stringToSign).digest('base64');
}

function escapeLarkMarkdown(raw) {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&#60;')
    .replace(/>/g, '&#62;')
    .replace(/\*/g, '&#42;')
    .replace(/_/g, '&#95;')
    .replace(/~/g, '&#126;')
    .replace(/`/g, '&#96;');
}

const CONVENTIONAL_COMMIT_RE = /^([a-zA-Z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;
const MERGE_COMMIT_RE = /^Merge\s+(?:branch|pull request|remote-tracking branch)\b/i;

function classifyCommit(subject) {
  const trimmed = String(subject ?? '').trim();
  if (!trimmed || MERGE_COMMIT_RE.test(trimmed)) return null;

  const match = CONVENTIONAL_COMMIT_RE.exec(trimmed);
  if (!match) {
    return { bucket: 'other', text: trimmed };
  }

  const rawType = match[1].toLowerCase();
  const description = match[4].trim();
  if (!description) return null;

  if (rawType === 'feat') return { bucket: 'feat', text: description };
  if (rawType === 'fix') return { bucket: 'fix', text: description };
  if (rawType === 'perf' || rawType === 'refactor' || rawType === 'style') {
    return { bucket: 'improve', text: description };
  }
  if (rawType === 'test') {
    return { bucket: 'noise', text: description };
  }
  return { bucket: 'other', text: description };
}

/**
 * Scheme 1: Builds a concise, grouped release changelog from commit history
 * (between last published SHA and HEAD) or an explicit manual `releaseNotes` override.
 */
export function formatStructuredReleaseChangelog({
  commits = [],
  manualNotes = '',
  commitSubject = '',
  maxItems = MAX_CHANGELOG_ITEMS,
} = {}) {
  const trimmedNotes = String(manualNotes ?? '').trim();
  if (trimmedNotes) {
    const lines = trimmedNotes
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .slice(0, maxItems)
      .map(line => {
        const cleaned = line.replace(/^[-*•]\s+/, '');
        return `• ${escapeLarkMarkdown(cleaned)}`;
      });
    return {
      markdown: lines.join('\n'),
      plainMarkdown: lines.join('\n'),
      totalCount: lines.length,
      truncatedCount: 0,
      source: 'manual',
    };
  }

  const rawEntries = Array.isArray(commits) && commits.length > 0
    ? commits
    : commitSubject
      ? [{ subject: commitSubject }]
      : [];

  const buckets = {
    feat: [],
    fix: [],
    improve: [],
    other: [],
    noise: [],
  };

  const seenTexts = new Set();
  for (const entry of rawEntries) {
    const subject = typeof entry === 'string' ? entry : entry?.subject;
    const classified = classifyCommit(subject);
    if (!classified) continue;
    const dedupKey = classified.text.toLowerCase();
    if (seenTexts.has(dedupKey)) continue;
    seenTexts.add(dedupKey);
    buckets[classified.bucket].push(classified.text);
  }

  const primaryCount = buckets.feat.length + buckets.fix.length + buckets.improve.length;
  const orderedGroups = [
    { key: 'feat', label: '新增', items: buckets.feat },
    { key: 'fix', label: '修复', items: buckets.fix },
    { key: 'improve', label: '优化', items: buckets.improve },
    ...(primaryCount < maxItems ? [{ key: 'other', label: '其他', items: buckets.other }] : []),
    ...(primaryCount === 0 && buckets.other.length === 0
      ? [{ key: 'noise', label: '维护', items: buckets.noise }]
      : []),
  ].filter(group => group.items.length > 0);

  const totalCount =
    buckets.feat.length +
    buckets.fix.length +
    buckets.improve.length +
    buckets.other.length +
    (primaryCount === 0 && buckets.other.length === 0 ? buckets.noise.length : 0);

  if (orderedGroups.length === 0) {
    return {
      markdown: "<font color='grey'>例行构建更新</font>",
      plainMarkdown: '- 例行构建更新',
      totalCount: 0,
      truncatedCount: 0,
      source: 'empty',
    };
  }

  const cardLines = [];
  const plainLines = [];
  let emitted = 0;

  for (const group of orderedGroups) {
    if (emitted >= maxItems) break;
    const remaining = maxItems - emitted;
    const slice = group.items.slice(0, remaining);
    if (slice.length === 0) continue;

    cardLines.push(`**${group.label}**`);
    plainLines.push(`**${group.label}**`);
    for (const item of slice) {
      cardLines.push(`• ${escapeLarkMarkdown(item)}`);
      plainLines.push(`- ${item}`);
      emitted += 1;
    }
  }

  const truncatedCount = Math.max(0, totalCount - emitted);
  if (truncatedCount > 0) {
    cardLines.push(`<font color='grey'>其余 ${truncatedCount} 项变更见下方完整对比</font>`);
    plainLines.push(`_…and ${truncatedCount} more change(s)_`);
  }

  return {
    markdown: cardLines.join('\n'),
    plainMarkdown: plainLines.join('\n'),
    totalCount,
    truncatedCount,
    source: 'commits',
  };
}

function makeDownloadButton({ label, url, primary = false }) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type: primary ? 'primary_filled' : 'default',
    size: 'medium',
    width: 'fill',
    icon: { tag: 'standard_icon', token: 'download_outlined' },
    behaviors: [
      {
        type: 'open_url',
        default_url: url,
        pc_url: url,
        ios_url: url,
        android_url: url,
      },
    ],
  };
}

export function buildDesktopReleaseCardPayload({
  channel,
  version,
  buildVersion,
  previousVersion = '',
  publicOrigin = 'https://releases.open-design.ai',
  mirrorOrigin = DEFAULT_MIRROR_ORIGIN,
  mirrorSource = DEFAULT_MIRROR_SOURCE,
  mirrorConsoleUrl = DEFAULT_MIRROR_CONSOLE_URL,
  branch = '',
  commitSha = '',
  commitSubject = '',
  commits = [],
  manualNotes = '',
  compareUrl = '',
  actor = '',
  runUrl = '',
  includeMacX64 = true,
  includeWinPortable = channel === 'stable',
  secret = '',
  timestampSeconds = Math.floor(Date.now() / 1000),
}) {
  const normalizedChannel = channel === 'stable' ? 'stable' : 'test';
  const origin = String(publicOrigin || 'https://releases.open-design.ai').replace(/\/+$/, '');
  const baseUrl = `${origin}/open-motion/desktop/${normalizedChannel}`;
  const normalizedMirrorOrigin = normalizeOptionalHttpsUrl(mirrorOrigin, 'mirrorOrigin');
  const normalizedMirrorConsoleUrl = normalizeOptionalHttpsUrl(mirrorConsoleUrl, 'mirrorConsoleUrl');
  const normalizedMirrorSource =
    normalizedMirrorOrigin || normalizedMirrorConsoleUrl ? normalizeMirrorSource(mirrorSource) : '';
  const shortSha = commitSha ? String(commitSha).slice(0, 8) : '';
  const isStable = normalizedChannel === 'stable';

  const arm64Dmg = `${baseUrl}/OpenDesign-${version}-mac-arm64.dmg`;
  const x64Dmg = `${baseUrl}/OpenDesign-${version}-mac-x64.dmg`;
  const winSetup = `${baseUrl}/OpenDesign-Setup-${version}-win-x64.exe`;
  const winPortable = `${baseUrl}/OpenDesign-Portable-${version}-win-x64.exe`;

  const mirrorLinks = [];
  if (normalizedMirrorOrigin) {
    const mirrorBase = `${normalizedMirrorOrigin}/f/${normalizedMirrorSource}/${normalizedChannel}/${version}`;
    mirrorLinks.push(`[macOS Apple Silicon](${mirrorBase}/OpenDesign-${version}-mac-arm64.dmg)`);
    if (includeMacX64) {
      mirrorLinks.push(`[macOS Intel](${mirrorBase}/OpenDesign-${version}-mac-x64.dmg)`);
    }
    mirrorLinks.push(`[Windows 安装版](${mirrorBase}/OpenDesign-Setup-${version}-win-x64.exe)`);
  }
  if (normalizedMirrorConsoleUrl) {
    const query = encodeURIComponent(`${normalizedMirrorSource} ${normalizedChannel}`);
    mirrorLinks.push(`[历史存档 / 控制台检索](${normalizedMirrorConsoleUrl}?q=${query})`);
  }

  const themeColor = isStable ? 'green' : 'blue';
  const badgeText = isStable ? 'STABLE' : 'TEST';
  const title = isStable ? 'OpenDesign 客户端正式版发布' : 'OpenDesign 客户端新版本发布';
  const subtitleParts = [`v${version}`];
  if (buildVersion) subtitleParts.push(`Build ${buildVersion}`);
  if (branch) subtitleParts.push(branch);

  const changelog = formatStructuredReleaseChangelog({
    commits,
    manualNotes,
    commitSubject,
  });

  const infoColumns = [
    {
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_spacing: '2px',
      elements: [
        { tag: 'markdown', content: "<font color='grey'>版本</font>", text_size: 'notation', margin: '0px' },
        { tag: 'markdown', content: `**v${escapeLarkMarkdown(version)}**`, text_size: 'normal', margin: '0px' },
      ],
    },
    {
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_spacing: '2px',
      elements: [
        { tag: 'markdown', content: "<font color='grey'>分支</font>", text_size: 'notation', margin: '0px' },
        {
          tag: 'markdown',
          content: `**${escapeLarkMarkdown(branch || normalizedChannel)}**`,
          text_size: 'normal',
          margin: '0px',
        },
      ],
    },
    {
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_spacing: '2px',
      elements: [
        { tag: 'markdown', content: "<font color='grey'>提交</font>", text_size: 'notation', margin: '0px' },
        {
          tag: 'markdown',
          content: `**${escapeLarkMarkdown(shortSha || 'manual')}**${actor ? ` <font color='grey'>${escapeLarkMarkdown(actor)}</font>` : ''}`,
          text_size: 'normal',
          margin: '0px',
        },
      ],
    },
  ];

  const changelogHeading = previousVersion
    ? `**本次更新** <font color='grey'>对比 v${escapeLarkMarkdown(previousVersion)}</font>`
    : '**本次更新**';

  const footerParts = [
    `<font color='grey'>${
      isStable
        ? '已安装正式版客户端将通过自动更新推送此版本'
        : '已安装 Test 频道客户端会自动检测更新，无需重复安装'
    }</font>`,
  ];
  if (compareUrl) {
    footerParts.push(`[完整变更](${compareUrl})`);
  }
  if (runUrl) {
    footerParts.push(`[CI 构建详情](${runUrl})`);
  }

  const elements = [
    {
      tag: 'column_set',
      flex_mode: 'none',
      background_style: 'grey-50',
      margin: '0px 0px 12px 0px',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          padding: '10px 12px',
          vertical_spacing: '8px',
          elements: [
            {
              tag: 'column_set',
              flex_mode: 'none',
              horizontal_spacing: '12px',
              columns: infoColumns,
              margin: '0px',
            },
            {
              tag: 'markdown',
              content: `${changelogHeading}\n${changelog.markdown}`,
              text_size: 'notation',
              margin: '0px',
            },
          ],
        },
      ],
    },
    {
      tag: 'markdown',
      content: "**选择平台下载** <font color='grey'>macOS 已签名公证</font>",
      text_size: 'normal',
      margin: '0px 0px 8px 0px',
    },
    {
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: '8px',
      margin: '0px 0px 8px 0px',
      columns: includeMacX64
        ? [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [
                makeDownloadButton({
                  label: 'macOS · Apple Silicon',
                  url: arm64Dmg,
                  primary: true,
                }),
              ],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [
                makeDownloadButton({
                  label: 'macOS · Intel (x64)',
                  url: x64Dmg,
                }),
              ],
            },
          ]
        : [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [
                makeDownloadButton({
                  label: '下载 macOS (Apple Silicon)',
                  url: arm64Dmg,
                  primary: true,
                }),
              ],
            },
          ],
    },
    {
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: '8px',
      margin: '0px 0px 12px 0px',
      columns: includeWinPortable
        ? [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [
                makeDownloadButton({
                  label: 'Windows · 安装版',
                  url: winSetup,
                }),
              ],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [
                makeDownloadButton({
                  label: 'Windows · 便携版',
                  url: winPortable,
                }),
              ],
            },
          ]
        : [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [
                makeDownloadButton({
                  label: '下载 Windows (x64 安装版)',
                  url: winSetup,
                }),
              ],
            },
          ],
    },
    ...(mirrorLinks.length > 0
      ? [
          {
            tag: 'markdown',
            content: `**内网极速下载（Mirror）**　${mirrorLinks.join(' · ')}\n<font color='grey'>新包发布后约 10 分钟内自动同步至内网；若暂未就绪可进控制台点击「立即刷新」或下载历史存档</font>`,
            text_size: 'notation',
            margin: '0px 0px 10px 0px',
          },
        ]
      : []),
    {
      tag: 'markdown',
      content: footerParts.join('　·　'),
      text_size: 'notation',
      margin: '0px',
    },
  ];

  const payload = {
    msg_type: 'interactive',
    card: {
      schema: '2.0',
      config: {
        update_multi: true,
        width_mode: 'default',
        summary: {
          content: `[${badgeText}] OpenDesign v${version} 已发布`,
        },
      },
      header: {
        title: { tag: 'plain_text', content: title },
        subtitle: { tag: 'plain_text', content: subtitleParts.join(' · ') },
        template: themeColor,
        icon: { tag: 'standard_icon', token: 'ai-common_colorful' },
        text_tag_list: [
          {
            tag: 'text_tag',
            text: { tag: 'plain_text', content: badgeText },
            color: themeColor,
          },
        ],
      },
      body: {
        direction: 'vertical',
        padding: '12px 12px 16px 12px',
        vertical_spacing: '0px',
        elements,
      },
    },
  };

  if (secret) {
    const ts = String(timestampSeconds);
    payload.timestamp = ts;
    payload.sign = signFeishuWebhook(secret, ts);
  }

  return payload;
}

export async function sendFeishuReleaseNotification({
  webhookUrl,
  secret = '',
  fetchImpl = fetch,
  ...releaseInfo
}) {
  const safeUrl = validateFeishuWebhookUrl(webhookUrl);
  const payload = buildDesktopReleaseCardPayload({ ...releaseInfo, secret });
  const response = await fetchImpl(safeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Feishu webhook returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Feishu webhook returned non-JSON response: ${text.slice(0, 300)}`);
  }
  const code = body?.code ?? body?.StatusCode ?? 0;
  if (code !== 0) {
    throw new Error(`Feishu webhook rejected payload (code=${code}): ${body?.msg ?? body?.StatusMessage ?? text}`);
  }
  return { ok: true, response: body };
}

function parseCommitsJson(raw) {
  if (!raw || !String(raw).trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const commits = parseCommitsJson(process.env.RELEASE_COMMITS_JSON);
  const manualNotes = process.env.RELEASE_NOTES?.trim() || '';
  const commitSubject = process.env.COMMIT_SUBJECT?.trim() || '';
  const previousVersion = process.env.PREVIOUS_VERSION?.trim() || '';
  const compareUrl = process.env.COMPARE_URL?.trim() || '';
  const version = process.env.EXPECTED_VERSION || process.env.RELEASE_VERSION || '';
  const channel = process.env.CHANNEL || process.env.OPENMOTION_RELEASE_CHANNEL || 'test';

  const changelog = formatStructuredReleaseChangelog({
    commits,
    manualNotes,
    commitSubject,
  });

  if (process.env.GITHUB_STEP_SUMMARY) {
    const heading = previousVersion
      ? `#### What's changed in v${version} (since v${previousVersion})`
      : `#### What's changed in v${version}`;
    const summaryLines = [heading, changelog.plainMarkdown];
    if (compareUrl) {
      summaryLines.push(`\nCompare: ${compareUrl}`);
    }
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summaryLines.join('\n')}\n\n`, 'utf8');
  }

  const notifyEnabled = process.env.FEISHU_NOTIFY_ENABLED === 'true';
  if (!notifyEnabled) {
    console.log('FEISHU_NOTIFY_ENABLED is not true; generated structured changelog only (Feishu send paused).');
    process.exit(0);
  }

  const webhookUrl = process.env.FEISHU_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    console.log('FEISHU_WEBHOOK_URL not configured; skipping Feishu desktop release notification.');
    process.exit(0);
  }

  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '';

  const mirrorOriginEnv =
    process.env.MIRROR_PUBLIC_ORIGIN === undefined
      ? DEFAULT_MIRROR_ORIGIN
      : process.env.MIRROR_PUBLIC_ORIGIN.trim();
  const mirrorConsoleEnv =
    process.env.MIRROR_CONSOLE_URL === undefined
      ? DEFAULT_MIRROR_CONSOLE_URL
      : process.env.MIRROR_CONSOLE_URL.trim();

  await sendFeishuReleaseNotification({
    webhookUrl,
    secret: process.env.FEISHU_WEBHOOK_SECRET?.trim() || '',
    channel,
    version,
    buildVersion: process.env.RELEASE_BUILD_VERSION || '',
    previousVersion,
    publicOrigin: process.env.RELEASE_PUBLIC_ORIGIN || 'https://releases.open-design.ai',
    mirrorOrigin: mirrorOriginEnv,
    mirrorSource: process.env.MIRROR_SOURCE_ID?.trim() || DEFAULT_MIRROR_SOURCE,
    mirrorConsoleUrl: mirrorConsoleEnv,
    branch: process.env.GITHUB_REF_NAME || '',
    commitSha: process.env.GITHUB_SHA || '',
    commitSubject,
    commits,
    manualNotes,
    compareUrl,
    actor: process.env.GITHUB_ACTOR || '',
    includeWinPortable:
      process.env.INCLUDE_WIN_PORTABLE !== undefined
        ? process.env.INCLUDE_WIN_PORTABLE === 'true'
        : channel === 'stable',
    runUrl,
    includeMacX64: process.env.INCLUDE_MAC_X64 !== 'false',
  });
  console.log('Sent Feishu desktop release notification.');
}
