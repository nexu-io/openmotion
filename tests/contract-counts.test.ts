import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { phase1Tools } from '../shared/phase1-tools.ts';
import { webMcpToolNames } from '../tracking/events.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

/**
 * Count sentences an open change already corrects, keyed by a fragment of the sentence rather than a
 * line number: an unrelated insertion above one of them must not turn the entry into a false report.
 * Every sentence is corrected here instead, so the set is empty and stays that way.
 */
const acceptedDrift = new Set<string>();

/** Ported upstream content keeps its own vocabulary and never states this product's totals. */
const excludedPrefixes = ['library/'];

const numberWords: Record<string, number> = {
  fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, 'twenty-one': 21, 'twenty-two': 22,
  'twenty-three': 23, 'twenty-four': 24, 'twenty-five': 25, 'twenty-six': 26, 'twenty-seven': 27,
  'twenty-eight': 28, 'twenty-nine': 29, thirty: 30,
};

const chineseDigits: Record<string, number> = { 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** Chinese numerals carry no separator, so 十八 is 18 and 二十二 is 22. */
function chineseNumber(text: string) {
  if (text.includes('十')) {
    const [tens, ones] = text.split('十');
    const high = tens === '' ? 1 : chineseDigits[tens];
    const low = ones === '' ? 0 : chineseDigits[ones];
    return high === undefined || low === undefined ? undefined : high * 10 + low;
  }
  const digits = [...text].map(char => chineseDigits[char]);
  return digits.some(value => value === undefined) ? undefined : Number(digits.join(''));
}

function claimValue(token: string) {
  if (/^\d+$/.test(token)) return Number(token);
  return numberWords[token.toLowerCase()] ?? chineseNumber(token);
}

/**
 * The totals the shipped documents state, each derived from a maintained source: the registered
 * domain names from shared/phase1-tools.ts, the page tools a Studio session registers from the
 * closed WebMCP name list, and the domain capabilities those names represent. The one documented
 * compatibility name reuses the openmotion_assets_use capability instead of adding another one.
 */
const compatibilityNames = ['openmotion_assets'];
for (const name of compatibilityNames) assert.ok(phase1Tools.some(tool => tool.name === name), `the compatibility name ${name} is no longer registered`);
const expectedTotals = {
  names: phase1Tools.length,
  pageTools: webMcpToolNames.length,
  capabilities: phase1Tools.length - compatibilityNames.length,
} as const;
type ClaimKind = keyof typeof expectedTotals;

/**
 * The sentence families that state a total: an English count before the noun and the heading form,
 * the same count in brackets after the noun, Chinese and Japanese word orders with digits or
 * numerals, the Chinese enumeration that names its total before a colon, and the WebMCP page-tool and
 * domain-capability families. A phrase that names its own subset, such as "eighteen video/workspace
 * names" inside the twenty-two total, is not a total claim and is not asserted as one.
 */
const claimPatterns: ReadonlyArray<{ kind: ClaimKind; pattern: RegExp }> = [
  { kind: 'names', pattern: /(?<![\w-])(\d+|[a-z]+(?:-[a-z]+)?)\s+(?:(?:public|registered|domain|MCP|Tool|tool|openmotion_|phase-one)\s+){0,4}names\b/gi },
  { kind: 'names', pattern: /\bnames\s*\(\s*(\d+)/gi },
  { kind: 'names', pattern: /\b(?:registered|public|domain)\b[^\n]{0,60}?\bnames?\b[^\n]{0,40}?\(\s*(\d+|[a-z]+(?:-[a-z]+)?)\s*[,)]/gi },
  { kind: 'names', pattern: /(?<![\w-])(\d+|[一二三四五六七八九十两]+)\s*个[^\n。;0-9]{0,40}?(?:注册|公开|MCP)[^\n。;0-9]{0,40}?名(?:称)?/g },
  { kind: 'names', pattern: /(?<![\w-])(\d+|[一二三四五六七八九十两]+)\s*个(?:公开)?(?:注册)?名(?:称)?\s*[::：]/g },
  { kind: 'names', pattern: /(?<![\w-])(\d+|[一二三四五六七八九十]+)\s*個の(?:公開\s*)?(?:MCP\s*)?名(?:前)?/g },
  { kind: 'names', pattern: /(?:公開|登録)\s*(?:MCP\s*)?名(?:前)?\s*(\d+)\s*個/g },
  { kind: 'pageTools', pattern: /(?<![\w-])(\d+|[a-z]+(?:-[a-z]+)?)\s+(?:(?:registered|public|WebMCP)\s+){0,3}page\s+(?:WebMCP\s+)?tools?\b/gi },
  { kind: 'capabilities', pattern: /(?<![\w-])(\d+|[a-z]+(?:-[a-z]+)?)\s+(?:(?:registered|public|domain)\s+){0,3}(?:domain\s+)?capabilit(?:y|ies)\b/gi },
];

/** Every total a line states, once per site, in the order the sites appear. */
export function countClaims(line: string) {
  const claims: Array<{ kind: ClaimKind; value: number; text: string; start: number }> = [];
  for (const { kind, pattern } of claimPatterns) {
    for (const match of line.matchAll(pattern)) {
      const start = match.index ?? 0;
      // Two families can describe one site, such as a heading that repeats the noun before the count.
      if (claims.some(claim => start < claim.start + claim.text.length && claim.start < start + match[0].length)) continue;
      const value = claimValue(match[1]);
      if (value !== undefined) claims.push({ kind, value, text: match[0], start });
    }
  }
  return claims.sort((a, b) => a.start - b.start).map(({ kind, value, text }) => ({ kind, value, text }));
}

/**
 * Shipped Markdown pages, taken from the repository index rather than a maintained folder list, so a
 * new or renamed documentation directory enters the check by being committed.
 */
function trackedDocuments() {
  return execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean).filter(file => !excludedPrefixes.some(prefix => file.startsWith(prefix))).sort();
}

async function claimSites() {
  const sites: Array<{ file: string; line: number; kind: ClaimKind; value: number; text: string }> = [];
  for (const file of trackedDocuments()) {
    const lines = (await readFile(path.join(root, file), 'utf8')).split('\n');
    lines.forEach((line, index) => {
      for (const claim of countClaims(line)) sites.push({ file, line: index + 1, ...claim });
    });
  }
  return sites;
}

const isAccepted = (text: string) => [...acceptedDrift].some(fragment => text.includes(fragment));

test('the public contract totals come from the registry, not from prose', () => {
  // 18 video/workspace names including the openmotion_assets compatibility alias, plus 4 design tools.
  assert.equal(phase1Tools.length, 22);
  assert.equal(phase1Tools.filter(tool => tool.name.startsWith('openmotion_design_')).length, 4);
  assert.equal(new Set(phase1Tools.map(tool => tool.name)).size, phase1Tools.length);
  assert.deepEqual(Object.values(expectedTotals), [22, 27, 21]);
});

test('total sentences in shipped documents state the derived totals', async () => {
  const sites = await claimSites();
  assert.ok(sites.length >= 40, `the shipped documents still state totals, found ${sites.length}`);
  const stale = sites.filter(site => site.value !== expectedTotals[site.kind] && !isAccepted(site.text));
  assert.deepEqual(stale.map(site => `${site.file}:${site.line} says "${site.text}" (${site.kind}, expected ${expectedTotals[site.kind]})`), [],
    'A total sentence must state the value derived from the registry, the WebMCP name list or the capability count');
  // An accepted fragment that no sentence states any more has to leave the list.
  for (const fragment of acceptedDrift) assert.ok(sites.some(site => site.text.includes(fragment)), `accepted drift "${fragment}" is no longer in any sentence; remove it from acceptedDrift`);
});

test('the claim scanner reads the shipped phrasings and ignores subset or incidental counts', () => {
  const claims = (line: string) => countClaims(line).map(claim => [claim.kind, claim.value]);
  // Digit, spelled-out and qualified forms, in the orders the shipped documents use.
  assert.deepEqual(claims('已收敛为 [18 个 openmotion_ 注册名](mcp-phase1-tools.md)'), [['names', 18]]);
  assert.deepEqual(claims('the eighteen registered names remain unchanged'), [['names', 18]]);
  assert.deepEqual(claims('states twenty-two registered domain names'), [['names', 22]]);
  assert.deepEqual(claims('the public phase-one MCP surface contains **eighteen names: nine project tools**'), [['names', 18]]);
  assert.deepEqual(claims('## Public MCP names (18, including one compatibility alias)'), [['names', 18]]);
  assert.deepEqual(claims('calling every registered public Tool name in `shared/mcp-profiles.json` (eighteen, including one asset compatibility alias)'), [['names', 18]]);
  assert.deepEqual(claims('当前一期给宿主 Agent 的公开 MCP 只含下方 22 个注册的 openmotion_ Tool 名称(含 1 个兼容别名)'), [['names', 22]]);
  assert.deepEqual(claims('一期公开 MCP 包含**十八个名称:九个工程工具、两个模板目录工具**'), [['names', 18]]);
  assert.deepEqual(claims('公開 MCP 名 18 個(素材ライブラリの互換エイリアス 1 個を含む)'), [['names', 18]]);
  assert.deepEqual(claims('第 1 段階の公開 MCP は**18 個の名前:プロジェクト用 9 個**です'), [['names', 18]]);
  // The page-tool and capability families the WebMCP pages use.
  assert.deepEqual(claims('for twenty-seven page tools in total'), [['pageTools', 27]]);
  assert.deepEqual(claims('The shared WebMCP registrar measures all twenty-three page tools'), [['pageTools', 23]]);
  assert.deepEqual(claims('All nineteen registered page tools share one reporting boundary'), [['pageTools', 19]]);
  assert.deepEqual(claims('five Studio observation/navigation tools accompany seventeen domain capabilities'), [['capabilities', 17]]);
  assert.deepEqual(claims('It keeps fifteen capabilities'), [['capabilities', 15]]);
  assert.deepEqual(claims('Non-App clients keep twenty-two registered domain names covering twenty-one domain capabilities, one of the names being the `openmotion_assets` compatibility alias'), [['names', 22], ['capabilities', 21]]);
  assert.deepEqual(claims('The twenty-two registered names represent twenty-one domain capabilities'), [['names', 22], ['capabilities', 21]]);
  // A named subset, another count in the same sentence and link syntax are not totals.
  assert.deepEqual(claims('Phase one retains twenty-two registered domain openmotion_ names (eighteen video/workspace names including the openmotion_assets compatibility alias, plus four tools).'), [['names', 22]]);
  assert.deepEqual(claims('只公开以下 22 个注册名称(18 个视频/工作区名含一个资产兼容名,加 4 个 Design Studio HTML 设计工具)'), [['names', 22]]);
  assert.deepEqual(claims('也不改变一期 18 个公开 MCP Tool 注册名。'), [['names', 18]]);
  assert.deepEqual(claims('five editor-scoped `openmotion_studio_*` observation/navigation tools'), []);
  assert.deepEqual(claims('The ZIP uses ordinary STORE or DEFLATE entries, UTF-8 names and relative forward-slash paths.'), []);
  assert.deepEqual(claims('a sentence about names in general'), []);
});