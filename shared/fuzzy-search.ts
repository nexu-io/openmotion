// Pure multilingual fuzzy, synonym, and similarity search engine.
// Erasable TypeScript only (Node --experimental-strip-types compatible, zero Node/Studio deps).

import {
  CJK_LEXICON,
  MAX_CJK_LEXICON_LENGTH,
  SEARCH_STOPWORDS_EN,
  SEARCH_STOPWORDS_ZH,
  SYNONYM_CLUSTERS,
  TRADITIONAL_TO_SIMPLIFIED,
  ZH_FILLER_PHRASES,
} from './search-synonyms.ts';

export type SearchFieldWeightKey = 'title' | 'tags' | 'aliases' | 'subtitle' | 'id' | 'author' | 'description' | 'extra';

export interface SearchFieldInput {
  readonly weight?: number;
  readonly values?: readonly (string | null | undefined)[] | null;
}

export interface SearchDocumentInput {
  readonly id?: string | null;
  readonly title?: string | null;
  readonly subtitle?: string | null;
  readonly description?: string | null;
  readonly tags?: readonly (string | null | undefined)[] | null;
  readonly aliases?: readonly (string | null | undefined)[] | null;
  readonly author?: string | null;
  readonly extra?: readonly (string | null | undefined)[] | null;
}

export interface SearchConceptGroup {
  readonly raw: string;
  readonly stem: string;
  readonly isAscii: boolean;
  readonly isShortAscii: boolean;
  readonly isPhrase: boolean;
  readonly literalSubTerms: readonly string[];
  readonly tightTerms: readonly NormalizedVariant[];
  readonly relatedTerms: readonly NormalizedVariant[];
}

export interface ParsedSearchQuery {
  readonly raw: string;
  readonly normalized: string;
  readonly isIdentifier: boolean;
  readonly groups: readonly SearchConceptGroup[];
  readonly highlightTerms: readonly string[];
}

interface NormalizedVariant {
  readonly text: string;
  readonly stem: string;
  readonly isAscii: boolean;
  readonly isShortAscii: boolean;
  readonly hasSpace: boolean;
}

interface IndexedField {
  readonly weight: number;
  readonly text: string;
  readonly compact: string;
  readonly words: readonly string[];
  readonly wordSet: ReadonlySet<string>;
  readonly stemSet: ReadonlySet<string>;
}

export interface PreparedSearchDocument {
  readonly normalizedTitle: string;
  readonly fields: readonly IndexedField[];
  readonly allWordSet: ReadonlySet<string>;
  readonly allStemSet: ReadonlySet<string>;
  readonly allCompact: string;
  readonly allText: string;
}

export interface RankedResult<T> {
  readonly item: T;
  readonly score: number;
}

const FIELD_WEIGHTS: Record<SearchFieldWeightKey, number> = {
  title: 4.0,
  tags: 3.4,
  aliases: 3.2,
  subtitle: 2.6,
  id: 2.2,
  author: 2.2,
  description: 1.6,
  extra: 1.6,
};

const SEPARATOR_RE = /[_\-./·|—–:,、，。？！?!()[\]【】"'`~@#%^&*+=<>\\;；：（）「」『』]+/g;
const COMBINING_LATIN_RE = /[\u0300-\u036f]/g;
const CJK_RUN_RE = /[\u4e00-\u9fff]+/g;
const ASCII_TOKEN_RE = /[a-z0-9]+/g;
const NON_LATIN_RUN_RE = /[^\s\u4e00-\u9fffa-z0-9]+/g;

function foldTraditional(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    out += TRADITIONAL_TO_SIMPLIFIED[ch] ?? ch;
  }
  return out;
}

export function normalizeSearchText(input: string): string {
  if (!input) return '';
  const foldedLatin = input
    .normalize('NFD')
    .replace(COMBINING_LATIN_RE, '')
    .normalize('NFC')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u0131/g, 'i');
  const simplified = foldTraditional(foldedLatin);
  return simplified.replace(SEPARATOR_RE, ' ').replace(/\s+/g, ' ').trim();
}

export function stemEnglishToken(token: string): string {
  if (!/^[a-z][a-z0-9]*$/.test(token) || token.length < 4) return token;
  let w = token;
  if (w.endsWith('ies') && w.length >= 5) return w.slice(0, -3) + 'y';
  if (/(ch|sh|x|z|ss)es$/.test(w) && w.length >= 5) return w.slice(0, -2);
  if (w.endsWith('ations') && w.length >= 8) return w.slice(0, -6) + 'at';
  if (w.endsWith('ation') && w.length >= 7) return w.slice(0, -5) + 'at';
  if (w.endsWith('ating') && w.length >= 7) return w.slice(0, -5) + 'at';
  if (w.endsWith('ated') && w.length >= 6) return w.slice(0, -4) + 'at';
  if (w.endsWith('ates') && w.length >= 6) return w.slice(0, -4) + 'at';
  if (w.endsWith('ate') && w.length >= 6) return w.slice(0, -3) + 'at';
  if (w.endsWith('ers') && w.length >= 7) return w.slice(0, -3);
  if (w.endsWith('er') && w.length >= 6) return w.slice(0, -2);
  if (w.endsWith('s') && w.length >= 4 && !/(ss|us|is)$/.test(w)) {
    w = w.slice(0, -1);
  }
  if (w.endsWith('ing') && w.length >= 6) {
    let base = w.slice(0, -3);
    if (base.length >= 4 && base[base.length - 1] === base[base.length - 2]) {
      base = base.slice(0, -1);
    }
    return base;
  }
  if (w.endsWith('ied') && w.length >= 5) return w.slice(0, -3) + 'y';
  if (w.endsWith('ed') && w.length >= 5) {
    let base = w.slice(0, -2);
    if (base.length >= 4 && base[base.length - 1] === base[base.length - 2]) {
      base = base.slice(0, -1);
    }
    return base;
  }
  return w;
}

function segmentCjkRun(run: string): string[] {
  if (run.length <= 1) return run ? [run] : [];
  if (CJK_LEXICON.has(run)) return [run];
  const tokens: string[] = [];
  let i = 0;
  let unmatchedStart = -1;
  const flushUnmatched = (end: number) => {
    if (unmatchedStart < 0) return;
    const span = run.slice(unmatchedStart, end);
    unmatchedStart = -1;
    if (span.length <= 2) {
      tokens.push(span);
      return;
    }
    for (let k = 0; k < span.length - 1; k++) {
      tokens.push(span.slice(k, k + 2));
    }
  };
  while (i < run.length) {
    let matchedLen = 0;
    const maxLen = Math.min(MAX_CJK_LEXICON_LENGTH, run.length - i);
    for (let len = maxLen; len >= 2; len--) {
      if (CJK_LEXICON.has(run.slice(i, i + len))) {
        matchedLen = len;
        break;
      }
    }
    if (matchedLen > 0) {
      flushUnmatched(i);
      tokens.push(run.slice(i, i + matchedLen));
      i += matchedLen;
    } else {
      if (unmatchedStart < 0) unmatchedStart = i;
      i++;
    }
  }
  flushUnmatched(run.length);
  return tokens;
}

export function segmentSearchTokens(normalizedInput: string): string[] {
  const normalized = normalizeSearchText(normalizedInput);
  if (!normalized) return [];
  const rawMatches: { index: number; text: string }[] = [];
  for (const m of normalized.matchAll(ASCII_TOKEN_RE)) {
    rawMatches.push({ index: m.index ?? 0, text: m[0] });
  }
  for (const m of normalized.matchAll(CJK_RUN_RE)) {
    const segs = segmentCjkRun(m[0]);
    for (let i = 0; i < segs.length; i++) {
      rawMatches.push({ index: (m.index ?? 0) + (i + 1) / (segs.length + 2), text: segs[i] });
    }
  }
  for (const m of normalized.matchAll(NON_LATIN_RUN_RE)) {
    rawMatches.push({ index: m.index ?? 0, text: m[0] });
  }
  rawMatches.sort((a, b) => a.index - b.index);
  return rawMatches.map(m => m.text).filter(Boolean);
}

// Precompute normalized cluster index once at startup for O(1) synonym lookups.
interface ClusterNormalized {
  readonly id: string;
  readonly tightSet: ReadonlySet<string>;
  readonly relatedSet: ReadonlySet<string>;
  readonly tightVariants: readonly NormalizedVariant[];
  readonly relatedVariants: readonly NormalizedVariant[];
}

function makeVariant(raw: string): NormalizedVariant | null {
  const text = normalizeSearchText(raw);
  if (!text) return null;
  const isAscii = /^[a-z0-9 ]+$/.test(text);
  const compact = text.replace(/\s+/g, '');
  const stem = isAscii && !text.includes(' ') ? stemEnglishToken(text) : text;
  return {
    text,
    stem,
    isAscii,
    isShortAscii: isAscii && !text.includes(' ') && compact.length <= 3,
    hasSpace: text.includes(' '),
  };
}

const CLUSTERS_NORMALIZED: readonly ClusterNormalized[] = SYNONYM_CLUSTERS.map(cluster => {
  const tightSet = new Set<string>();
  const tightVariants: NormalizedVariant[] = [];
  for (const term of cluster.terms) {
    const v = makeVariant(term);
    if (!v || tightSet.has(v.text)) continue;
    tightSet.add(v.text);
    tightVariants.push(v);
  }
  const relatedSet = new Set<string>();
  const relatedVariants: NormalizedVariant[] = [];
  for (const term of cluster.related ?? []) {
    const v = makeVariant(term);
    if (!v || tightSet.has(v.text) || relatedSet.has(v.text)) continue;
    relatedSet.add(v.text);
    relatedVariants.push(v);
  }
  return { id: cluster.id, tightSet, relatedSet, tightVariants, relatedVariants };
});

// Multi-word / special compound phrases sorted longest first so "product promo" is matched as one unit.
const REGISTERED_PHRASES: readonly string[] = Array.from(
  new Set(
    CLUSTERS_NORMALIZED.flatMap(c =>
      [...c.tightVariants, ...c.relatedVariants].filter(v => v.hasSpace).map(v => v.text),
    ),
  ),
).sort((a, b) => b.length - a.length);

const FILLER_PHRASES_SORTED: readonly string[] = [...ZH_FILLER_PHRASES]
  .map(p => normalizeSearchText(p))
  .filter(Boolean)
  .sort((a, b) => b.length - a.length);

function stripFillersIfContentRemains(normalized: string): string {
  let stripped = normalized;
  for (const filler of FILLER_PHRASES_SORTED) {
    if (stripped.includes(filler)) {
      stripped = stripped.split(filler).join(' ');
    }
  }
  stripped = stripped.replace(/\s+/g, ' ').trim();
  return stripped || normalized;
}

function collectSynonymsForTerm(normalizedTerm: string, stem: string): {
  tightTerms: NormalizedVariant[];
  relatedTerms: NormalizedVariant[];
} {
  const tightMap = new Map<string, NormalizedVariant>();
  const relatedMap = new Map<string, NormalizedVariant>();
  for (const cluster of CLUSTERS_NORMALIZED) {
    const matchesExact = cluster.tightSet.has(normalizedTerm);
    const matchesStem =
      !matchesExact &&
      stem.length >= 4 &&
      cluster.tightVariants.some(v => !v.hasSpace && v.isAscii && v.text.length >= 4 && v.stem === stem);
    if (!matchesExact && !matchesStem) continue;
    for (const v of cluster.tightVariants) {
      if (v.text !== normalizedTerm && !tightMap.has(v.text)) tightMap.set(v.text, v);
    }
    for (const v of cluster.relatedVariants) {
      if (v.text !== normalizedTerm && !tightMap.has(v.text) && !relatedMap.has(v.text)) {
        relatedMap.set(v.text, v);
      }
    }
  }
  return {
    tightTerms: Array.from(tightMap.values()),
    relatedTerms: Array.from(relatedMap.values()),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const QUERY_CACHE = new Map<string, ParsedSearchQuery>();
const QUERY_CACHE_MAX = 128;

export function parseSearchQuery(rawQuery: string): ParsedSearchQuery {
  const cached = QUERY_CACHE.get(rawQuery);
  if (cached) {
    QUERY_CACHE.delete(rawQuery);
    QUERY_CACHE.set(rawQuery, cached);
    return cached;
  }

  const trimmedRaw = rawQuery.trim();
  const normalized = normalizeSearchText(rawQuery);
  const isIdentifier = /^[a-z0-9][a-z0-9._:/-]+$/i.test(trimmedRaw) && /[-_./:]/.test(trimmedRaw);
  if (!normalized) {
    const empty: ParsedSearchQuery = { raw: rawQuery, normalized: '', isIdentifier: false, groups: [], highlightTerms: [] };
    return empty;
  }

  let working = stripFillersIfContentRemains(normalized);
  const groups: SearchConceptGroup[] = [];
  const seenGroupKeys = new Set<string>();
  const highlightSet = new Set<string>();

  // Step 1: Consume registered multi-word phrases at boundaries before single-word splitting.
  for (const phrase of REGISTERED_PHRASES) {
    if (!working.includes(phrase)) continue;
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(phrase)}($|[^a-z0-9])`, 'g');
    if (!pattern.test(working)) continue;
    working = working.replace(pattern, '$1 $2').replace(/\s+/g, ' ').trim();
    if (seenGroupKeys.has(phrase)) continue;
    seenGroupKeys.add(phrase);
    const literalSubTerms = segmentSearchTokens(phrase);
    const { tightTerms, relatedTerms } = collectSynonymsForTerm(phrase, phrase);
    groups.push({
      raw: phrase,
      stem: phrase,
      isAscii: /^[a-z0-9 ]+$/.test(phrase),
      isShortAscii: false,
      isPhrase: true,
      literalSubTerms,
      tightTerms,
      relatedTerms,
    });
    highlightSet.add(phrase);
    for (const sub of literalSubTerms) {
      if (sub.length > 1) highlightSet.add(sub);
    }
  }

  // Step 2: Tokenize remaining text cleanly.
  const remainingTokens = segmentSearchTokens(working);
  const contentTokens = remainingTokens.filter(
    tok => !SEARCH_STOPWORDS_ZH.has(tok) && !SEARCH_STOPWORDS_EN.has(tok),
  );
  const finalTokens = contentTokens.length > 0 || groups.length > 0 ? contentTokens : remainingTokens;

  for (const tok of finalTokens) {
    if (seenGroupKeys.has(tok)) continue;
    seenGroupKeys.add(tok);
    const isAscii = /^[a-z0-9]+$/.test(tok);
    const stem = isAscii ? stemEnglishToken(tok) : tok;
    const { tightTerms, relatedTerms } = collectSynonymsForTerm(tok, stem);
    groups.push({
      raw: tok,
      stem,
      isAscii,
      isShortAscii: isAscii && tok.length <= 3,
      isPhrase: false,
      literalSubTerms: [tok],
      tightTerms,
      relatedTerms,
    });
    if (!isAscii || tok.length > 1 || (groups.length === 1 && finalTokens.length === 1)) {
      highlightSet.add(tok);
    }
  }
  for (const rawTok of trimmedRaw.split(/\s+/).filter(Boolean)) {
    if (rawTok.length > 1 || groups.length <= 1) {
      highlightSet.add(rawTok);
    }
  }

  const parsed: ParsedSearchQuery = {
    raw: rawQuery,
    normalized,
    isIdentifier,
    groups,
    highlightTerms: Array.from(highlightSet).sort((a, b) => b.length - a.length),
  };

  if (QUERY_CACHE.size >= QUERY_CACHE_MAX) {
    const oldest = QUERY_CACHE.keys().next().value;
    if (oldest !== undefined) QUERY_CACHE.delete(oldest);
  }
  QUERY_CACHE.set(rawQuery, parsed);
  return parsed;
}

export function extractHighlightTerms(query: string): string[] {
  return [...parseSearchQuery(query).highlightTerms];
}

function indexField(text: string, weight: number): IndexedField {
  const norm = normalizeSearchText(text);
  const compact = norm.replace(/\s+/g, '');
  const words: string[] = [];
  const wordSet = new Set<string>();
  const stemSet = new Set<string>();
  for (const m of norm.matchAll(ASCII_TOKEN_RE)) {
    const w = m[0];
    words.push(w);
    wordSet.add(w);
    const st = stemEnglishToken(w);
    stemSet.add(st);
  }
  return { weight, text: norm, compact, words, wordSet, stemSet };
}

export function prepareSearchDocument(input: SearchDocumentInput): PreparedSearchDocument {
  const fieldInputs: [string, number][] = [];
  if (input.title) fieldInputs.push([input.title, FIELD_WEIGHTS.title]);
  if (input.tags?.length) {
    const joined = input.tags.filter((v): v is string => Boolean(v && v.trim())).join(' ');
    if (joined) fieldInputs.push([joined, FIELD_WEIGHTS.tags]);
  }
  if (input.aliases?.length) {
    const joined = input.aliases.filter((v): v is string => Boolean(v && v.trim())).join(' ');
    if (joined) fieldInputs.push([joined, FIELD_WEIGHTS.aliases]);
  }
  if (input.subtitle) fieldInputs.push([input.subtitle, FIELD_WEIGHTS.subtitle]);
  if (input.id) fieldInputs.push([input.id, FIELD_WEIGHTS.id]);
  if (input.author) fieldInputs.push([input.author, FIELD_WEIGHTS.author]);
  if (input.description) fieldInputs.push([input.description, FIELD_WEIGHTS.description]);
  if (input.extra?.length) {
    const joined = input.extra.filter((v): v is string => Boolean(v && v.trim())).join(' ');
    if (joined) fieldInputs.push([joined, FIELD_WEIGHTS.extra]);
  }

  const fields = fieldInputs.map(([txt, weight]) => indexField(txt, weight));
  const allWordSet = new Set<string>();
  const allStemSet = new Set<string>();
  const texts: string[] = [];
  for (const f of fields) {
    if (!f.text) continue;
    texts.push(f.text);
    for (const w of f.wordSet) allWordSet.add(w);
    for (const st of f.stemSet) allStemSet.add(st);
  }
  const allText = texts.join(' ');
  const allCompact = allText.replace(/\s+/g, '');
  return {
    normalizedTitle: input.title ? normalizeSearchText(input.title) : '',
    fields,
    allWordSet,
    allStemSet,
    allCompact,
    allText,
  };
}

function damerauLevenshtein(a: string, b: string, maxDist: number): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > maxDist) return maxDist + 1;
  if (a === b) return 0;

  const prev2 = new Array<number>(n + 1).fill(0);
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1).fill(0);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, prev2[j - 2] + 1);
      }
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist + 1) return maxDist + 1;
    for (let j = 0; j <= n; j++) {
      prev2[j] = prev[j];
      prev[j] = curr[j];
    }
  }
  return prev[n];
}

function matchSingleVariantInField(variant: NormalizedVariant, field: IndexedField): number {
  if (!field.text) return 0;
  if (variant.hasSpace) {
    if (field.text.includes(variant.text)) {
      if (!variant.isAscii) return 1.0;
      const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(variant.text)}($|[^a-z0-9])`);
      return re.test(field.text) ? 1.0 : 0;
    }
    return 0;
  }
  if (variant.isShortAscii) {
    return field.wordSet.has(variant.text) ? 1.0 : 0;
  }
  if (variant.isAscii) {
    if (field.wordSet.has(variant.text)) return 1.0;
    if (variant.stem.length >= 4 && field.stemSet.has(variant.stem)) return 0.92;
    for (const w of field.words) {
      if (w.startsWith(variant.text)) return 0.84;
    }
    if (field.text.includes(variant.text)) return 0.78;
    return 0;
  }
  // CJK or other non-ASCII scripts
  if (field.text.includes(variant.text)) return 1.0;
  if (variant.text.length >= 2 && field.compact.includes(variant.text)) return 0.92;
  return 0;
}

function matchLiteralTokenInField(
  tok: string,
  stem: string,
  isAscii: boolean,
  isShortAscii: boolean,
  field: IndexedField,
): number {
  if (!field.text) return 0;
  if (isShortAscii) {
    return field.wordSet.has(tok) ? 1.0 : 0;
  }
  if (isAscii) {
    if (field.wordSet.has(tok)) return 1.0;
    if (stem.length >= 4 && field.stemSet.has(stem)) return 0.92;
    for (const w of field.words) {
      if (w.startsWith(tok)) return 0.84;
    }
    if (field.text.includes(tok)) return 0.78;
    if (tok.length >= 4) {
      const maxDist = tok.length >= 8 ? 2 : 1;
      let bestDist = maxDist + 1;
      for (const w of field.words) {
        if (w.length < 3 || Math.abs(tok.length - w.length) > maxDist) continue;
        if (maxDist === 2 && w.length < 6) continue;
        const dist = damerauLevenshtein(tok, w, maxDist);
        if (dist < bestDist) {
          bestDist = dist;
          if (dist === 1) break;
        }
      }
      if (bestDist <= maxDist) {
        return bestDist === 1 ? 0.68 : 0.52;
      }
    }
    return 0;
  }
  // Non-ASCII (CJK, Japanese kana/kanji, Korean, etc.)
  if (field.text.includes(tok)) return 1.0;
  if (tok.length >= 2 && field.compact.includes(tok)) return 0.92;
  return 0;
}

function matchGroupOnDoc(group: SearchConceptGroup, doc: PreparedSearchDocument): number {
  let bestFieldWeighted = 0;
  let matchingFieldCount = 0;

  for (const field of doc.fields) {
    let fieldStrength = 0;

    // 1. Direct literal or phrase match
    if (group.isPhrase) {
      if (field.text.includes(group.raw)) {
        const re = group.isAscii
          ? new RegExp(`(^|[^a-z0-9])${escapeRegex(group.raw)}($|[^a-z0-9])`)
          : null;
        if (!re || re.test(field.text)) {
          fieldStrength = 1.0;
        }
      }
      if (fieldStrength === 0 && group.literalSubTerms.length >= 2) {
        let allSubMatched = true;
        let minSub = 1.0;
        for (const sub of group.literalSubTerms) {
          const isAscii = /^[a-z0-9]+$/.test(sub);
          const s = matchLiteralTokenInField(
            sub,
            isAscii ? stemEnglishToken(sub) : sub,
            isAscii,
            isAscii && sub.length <= 3,
            field,
          );
          if (s === 0) {
            allSubMatched = false;
            break;
          }
          if (s < minSub) minSub = s;
        }
        if (allSubMatched) fieldStrength = 0.85 * minSub;
      }
    } else {
      fieldStrength = matchLiteralTokenInField(
        group.raw,
        group.stem,
        group.isAscii,
        group.isShortAscii,
        field,
      );
    }

    // 2. Tight synonym match
    if (fieldStrength < 0.76 && group.tightTerms.length > 0) {
      for (const variant of group.tightTerms) {
        const hit = matchSingleVariantInField(variant, field);
        if (hit > 0) {
          const score = 0.76 * hit;
          if (score > fieldStrength) fieldStrength = score;
          if (fieldStrength >= 0.76) break;
        }
      }
    }

    // 3. Broad related synonym match
    if (fieldStrength < 0.5 && group.relatedTerms.length > 0) {
      for (const variant of group.relatedTerms) {
        const hit = matchSingleVariantInField(variant, field);
        if (hit > 0) {
          const score = 0.5 * hit;
          if (score > fieldStrength) fieldStrength = score;
          if (fieldStrength >= 0.5) break;
        }
      }
    }

    if (fieldStrength > 0) {
      matchingFieldCount++;
      const weighted = fieldStrength * field.weight;
      if (weighted > bestFieldWeighted) bestFieldWeighted = weighted;
    }
  }

  // Fallback for multi-word phrases spread across different document fields (e.g., title + tag):
  if (bestFieldWeighted === 0 && group.isPhrase && group.literalSubTerms.length >= 2) {
    let crossScoreSum = 0;
    let allCrossMatched = true;
    for (const sub of group.literalSubTerms) {
      const isAscii = /^[a-z0-9]+$/.test(sub);
      let subBest = 0;
      for (const field of doc.fields) {
        const s = matchLiteralTokenInField(
          sub,
          isAscii ? stemEnglishToken(sub) : sub,
          isAscii,
          isAscii && sub.length <= 3,
          field,
        );
        if (s * field.weight > subBest) subBest = s * field.weight;
      }
      if (subBest === 0) {
        allCrossMatched = false;
        break;
      }
      crossScoreSum += subBest;
    }
    if (allCrossMatched) {
      bestFieldWeighted = (crossScoreSum / group.literalSubTerms.length) * 0.75;
    }
  }

  if (bestFieldWeighted === 0) return 0;
  return bestFieldWeighted + Math.max(0, matchingFieldCount - 1) * 0.15;
}

export function scoreSearchDocument(
  docInput: SearchDocumentInput | PreparedSearchDocument,
  queryOrParsed: string | ParsedSearchQuery,
): number {
  const parsed = typeof queryOrParsed === 'string' ? parseSearchQuery(queryOrParsed) : queryOrParsed;
  if (!parsed.groups.length) return 1;

  const doc = 'fields' in docInput ? docInput : prepareSearchDocument(docInput);
  if (!doc.fields.length) return 0;

  if (parsed.isIdentifier) {
    const compactNeedle = parsed.normalized.replace(/\s+/g, '');
    const contiguousMatch = doc.fields.some(
      field => field.text.includes(parsed.normalized) || (compactNeedle.length >= 4 && field.compact.includes(compactNeedle)),
    );
    if (!contiguousMatch) return 0;
  }

  let totalScore = 0;
  let matchedGroups = 0;

  for (const group of parsed.groups) {
    const score = matchGroupOnDoc(group, doc);
    if (score > 0) {
      matchedGroups++;
      totalScore += score;
    }
  }

  const totalGroups = parsed.groups.length;
  const required = parsed.isIdentifier || totalGroups <= 2 ? totalGroups : Math.max(2, Math.ceil(totalGroups * 0.6));
  if (matchedGroups < required) return 0;

  const coordMultiplier = totalGroups > 1 ? Math.pow(matchedGroups / totalGroups, 1.5) : 1;
  let finalScore = totalScore * coordMultiplier;

  if (doc.normalizedTitle && parsed.normalized) {
    if (doc.normalizedTitle === parsed.normalized) finalScore += 2.0;
    else if (doc.normalizedTitle.startsWith(parsed.normalized)) finalScore += 0.8;
  }

  return finalScore;
}

export function matchesSearchDocument(
  docInput: SearchDocumentInput | PreparedSearchDocument,
  queryOrParsed: string | ParsedSearchQuery,
): boolean {
  return scoreSearchDocument(docInput, queryOrParsed) > 0;
}

export interface PreparedSearchEntry<T> {
  readonly item: T;
  readonly doc: PreparedSearchDocument;
}

export function rankPreparedSearchResults<T>(
  entries: readonly PreparedSearchEntry<T>[],
  query: string,
): RankedResult<T>[] {
  const parsed = parseSearchQuery(query);
  if (!parsed.groups.length) {
    return entries.map(({ item }) => ({ item, score: 1 }));
  }
  const ranked: { item: T; score: number; index: number }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const score = scoreSearchDocument(entry.doc, parsed);
    if (score > 0) ranked.push({ item: entry.item, score, index: i });
  }
  ranked.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return ranked.map(({ item, score }) => ({ item, score }));
}

export function rankSearchResults<T>(
  items: readonly T[],
  query: string,
  toDoc: (item: T) => SearchDocumentInput,
): RankedResult<T>[] {
  const parsed = parseSearchQuery(query);
  if (!parsed.groups.length) {
    return items.map(item => ({ item, score: 1 }));
  }
  const ranked: { item: T; score: number; index: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const score = scoreSearchDocument(toDoc(item), parsed);
    if (score > 0) ranked.push({ item, score, index: i });
  }
  ranked.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return ranked.map(({ item, score }) => ({ item, score }));
}
