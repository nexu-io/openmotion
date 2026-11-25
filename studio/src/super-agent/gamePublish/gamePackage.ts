/**
 * Builds real packages in the browser from the game's own files:
 *  - reads /motion-api/games/:id/play/index.html and inlines the local files it references;
 *  - single-file zips for itch.io and Douyin Interactive Space;
 *  - a Xiaohongshu zip with inline scripts moved into files;
 *  - playable ads per network (store button rewritten to the network CTA, network files added).
 * Every check result is measured on the file the user downloads.
 */
import { playableNetwork, type PlayableNetwork } from './playableNetworks';

export type GamePackageTarget = 'itch' | 'douyin' | 'xiaohongshu' | 'playable';

export interface GamePackageCheck {
  /** English source key. */
  label: string;
  /** English source key, translated with `vars`. */
  value: string;
  vars?: Record<string, string | number>;
  tone: 'ok' | 'warn' | 'fail';
}

export interface GamePackageResult {
  fileName: string;
  bytes: number;
  limitBytes?: number;
  checks: GamePackageCheck[];
  blob: Blob;
}

export interface LoadedGameHtml {
  html: string;
  /** Local files that were inlined. */
  inlined: number;
  /** Local references that could not be read. */
  missing: string[];
}

// ---- Zip (store, no compression) ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Zip archive with stored (uncompressed) entries and UTF-8 names. */
export function zipStore(files: Array<{ name: string; data: Uint8Array | string }>): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const entries = files.map(file => {
    const name = encoder.encode(file.name);
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    return { name, data, crc: crc32(data) };
  });
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  for (const entry of entries) {
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, entry.crc, true);
    local.setUint32(18, entry.data.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, entry.name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), entry.name, entry.data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, 0, true);
    dir.setUint16(14, DOS_DATE, true);
    dir.setUint32(16, entry.crc, true);
    dir.setUint32(20, entry.data.length, true);
    dir.setUint32(24, entry.data.length, true);
    dir.setUint16(28, entry.name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), entry.name);
    offset += 30 + entry.name.length + entry.data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((sum, part) => sum + part.length, 0)));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

// ---- Reading the game ----

const ASSET_REF = /(["'(])((?:\.\/)?[\w\-.]+(?:\/[\w\-.]+)*\.(?:png|jpe?g|gif|webp|svg|mp3|ogg|wav|m4a|json|woff2?|ttf|otf))(["')])/gi;

function isLocal(ref: string | null): ref is string {
  return Boolean(ref) && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref!);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Reads the game's index.html and inlines the local files it references. */
export async function loadGameHtml(gameId: string, fetchImpl: typeof fetch = fetch): Promise<LoadedGameHtml> {
  const base = `/motion-api/games/${encodeURIComponent(gameId)}/play/`;
  const res = await fetchImpl(`${base}index.html`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not read the game (${res.status})`);
  const source = await res.text();
  const missing = new Set<string>();
  let inlined = 0;
  const readText = async (ref: string) => {
    const file = await fetchImpl(new URL(ref, new URL(base, location.origin)).toString());
    if (!file.ok) { missing.add(ref); return null; }
    inlined += 1;
    return file.text();
  };
  const readDataUri = async (ref: string) => {
    const file = await fetchImpl(new URL(ref, new URL(base, location.origin)).toString());
    if (!file.ok) { missing.add(ref); return null; }
    const type = file.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
    inlined += 1;
    return `data:${type};base64,${bytesToBase64(new Uint8Array(await file.arrayBuffer()))}`;
  };

  const doc = new DOMParser().parseFromString(source, 'text/html');
  for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
    const src = script.getAttribute('src');
    if (!isLocal(src)) continue;
    const text = await readText(src);
    if (text == null) continue;
    script.removeAttribute('src');
    script.textContent = text.replace(/<\/script/gi, '<\\/script');
  }
  for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))) {
    const href = link.getAttribute('href');
    if (!isLocal(href)) continue;
    const css = await readText(href);
    if (css == null) continue;
    const style = doc.createElement('style');
    style.textContent = css;
    link.replaceWith(style);
  }
  for (const element of Array.from(doc.querySelectorAll('img[src], audio[src], video[src], source[src], link[rel~="icon"][href]'))) {
    const attr = element.hasAttribute('src') ? 'src' : 'href';
    const ref = element.getAttribute(attr);
    if (!isLocal(ref)) continue;
    const uri = await readDataUri(ref);
    if (uri) element.setAttribute(attr, uri);
  }
  let html = `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;

  // Files referenced from scripts and styles (e.g. 'assets/coin.png').
  const refs = new Set<string>();
  for (const match of html.matchAll(ASSET_REF)) refs.add(match[2]);
  for (const ref of refs) {
    const uri = await readDataUri(ref);
    if (uri) html = html.split(`${'"'}${ref}${'"'}`).join(`"${uri}"`).split(`'${ref}'`).join(`'${uri}'`).split(`(${ref})`).join(`(${uri})`);
  }
  return { html, inlined, missing: [...missing] };
}

// ---- Playable ads ----

export interface PlayableBuildInput {
  html: string;
  network: PlayableNetwork;
  ios?: string;
  android?: string;
  orientation?: 'portrait' | 'landscape';
  /** Text of the download button added when the game has no store button of its own. */
  buttonText: string;
}

export interface PlayableRewrite {
  html: string;
  /** openStore / window.open calls routed to the network CTA. */
  rewrites: number;
  injectedButton: boolean;
}

const MRAID_REQUIRED = new Set(['mraid', 'applovin', 'liftoff']);
const GOOGLE_EXIT_API = 'https://tpc.googlesyndication.com/pagead/gadgets/html5/api/exitapi.js';

function escapeHtml(text: string) {
  return text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!));
}

/** Routes the game's store button to the network CTA and adds the files the network asks for. */
export function rewritePlayableHtml(input: PlayableBuildInput): PlayableRewrite {
  const { network } = input;
  let html = input.html;
  let rewrites = 0;
  html = html.replace(/\bfunction\s+openStore\s*\(/g, () => { rewrites += 1; return 'function __omGameOpenStore('; });
  html = html.replace(/\bwindow\.open\s*\(/g, () => { rewrites += 1; return 'window.__omCta('; });

  const store = JSON.stringify({ ios: input.ios ?? '', android: input.android ?? '' }).replace(/</g, '\\u003c');
  const shim = `<script>(function(){var s=${store};window.__omStoreUrl=function(){return /android/i.test(navigator.userAgent)?(s.android||s.ios):(s.ios||s.android)};window.__omCta=function(){var url=window.__omStoreUrl();try{${network.ctaCode}}catch(e){}window.__omCtaCount=(window.__omCtaCount||0)+1;};window.openStore=function(){window.__omCta();};})();</script>`;
  const headParts: string[] = [];
  if (MRAID_REQUIRED.has(network.id)) headParts.push('<script src="mraid.js"></script>');
  if (network.id === 'google') {
    headParts.push(`<meta name="ad.orientation" content="${input.orientation ?? 'portrait'}">`);
    headParts.push(`<script type="text/javascript" src="${GOOGLE_EXIT_API}"></script>`);
  }
  headParts.push(shim);
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => `${match}${headParts.join('')}`) : `${headParts.join('')}${html}`;

  const injectedButton = rewrites === 0;
  if (injectedButton) {
    const button = `<button id="om-cta" type="button" style="position:fixed;left:50%;transform:translateX(-50%);bottom:max(48px,calc(env(safe-area-inset-bottom) + 36px));z-index:2147483647;min-height:44px;padding:12px 28px;border:0;border-radius:24px;font-weight:700" onclick="window.__omCta()">${escapeHtml(input.buttonText)}</button>`;
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${button}</body>`) : `${html}${button}`;
  }
  return { html, rewrites, injectedButton };
}

function externalHosts(html: string, allowed: string[]): string[] {
  const hosts = new Set<string>();
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
    if (allowed.includes(match[1])) continue;
    try { hosts.add(new URL(match[1]).host); } catch { hosts.add(match[1]); }
  }
  return [...hosts];
}

export function buildPlayable(loaded: LoadedGameHtml, input: Omit<PlayableBuildInput, 'html' | 'network'> & { networkName: string; slug: string }): GamePackageResult {
  const network = playableNetwork(input.networkName);
  if (!network) throw new Error('Unknown ad network');
  const rewrite = rewritePlayableHtml({ ...input, html: loaded.html, network });
  const html = rewrite.html;
  const zipped = network.id === 'google' || network.id === 'tiktok';
  const files: Array<{ name: string; data: string }> = [{ name: 'index.html', data: html }];
  if (network.id === 'tiktok') files.push({ name: 'config.json', data: JSON.stringify({ playable_orientation: input.orientation === 'landscape' ? 2 : 1, playable_languages: ['zh', 'en'] }) });
  const data = zipped ? zipStore(files) : new TextEncoder().encode(html);
  const limitBytes = network.limitMb * 1024 * 1024;
  const hasMraidScript = /<script[^>]+src=["'][^"']*mraid\.js["']/i.test(html);
  const checks: GamePackageCheck[] = [
    { label: 'Package size', value: '{size} of {limit} MB', vars: { size: formatBytes(data.length), limit: network.limitMb }, tone: data.length <= limitBytes ? 'ok' : 'fail' },
    rewrite.injectedButton
      ? { label: 'Store button', value: 'The game had no store button; added one that calls {cta}', vars: { cta: network.cta }, tone: 'ok' }
      : { label: 'Store button', value: 'Routed {count} store call(s) to {cta}', vars: { count: rewrite.rewrites, cta: network.cta }, tone: 'ok' },
    { label: 'Store links', value: 'iOS: {ios} · Android: {android}', vars: { ios: input.ios || '—', android: input.android || '—' }, tone: input.ios && input.android ? 'ok' : 'warn' },
    loaded.missing.length
      ? { label: 'Local files', value: '{count} file(s) could not be read: {files}', vars: { count: loaded.missing.length, files: loaded.missing.slice(0, 3).join(', ') }, tone: 'fail' }
      : { label: 'Local files', value: 'Inlined {count} file(s) into the package', vars: { count: loaded.inlined }, tone: 'ok' },
  ];
  const external = externalHosts(html, network.id === 'google' ? [GOOGLE_EXIT_API] : []);
  checks.push(external.length
    ? { label: 'External resources', value: 'Still loads from {hosts}', vars: { hosts: external.join(', ') }, tone: 'fail' }
    : { label: 'External resources', value: network.id === 'google' ? 'None besides exitapi.js' : 'None', tone: 'ok' });
  if (MRAID_REQUIRED.has(network.id)) checks.push({ label: 'mraid.js', value: hasMraidScript ? 'Added as the first script' : 'Missing', tone: hasMraidScript ? 'ok' : 'fail' });
  else checks.push({ label: 'mraid.js', value: hasMraidScript ? 'Present, but this network does not allow it' : 'Not included', tone: hasMraidScript ? 'fail' : 'ok' });
  if (network.id === 'google') checks.push({ label: 'Google tags', value: 'Added ad.orientation and exitapi.js', tone: 'ok' });
  if (network.id === 'tiktok') {
    checks.push({ label: 'config.json', value: 'Included in the zip', tone: 'ok' });
    checks.push({ label: 'TikTok SDK', value: 'Not added; add it as the TikTok console asks', tone: 'warn' });
  }
  if (network.id === 'mintegral') {
    const hooks = ['gameReady', 'gameEnd', 'gameRetry'].filter(hook => !html.includes(hook));
    checks.push(hooks.length
      ? { label: 'Mintegral hooks', value: 'Not called by the game: {hooks}', vars: { hooks: hooks.join(', ') }, tone: 'warn' }
      : { label: 'Mintegral hooks', value: 'gameReady, gameEnd and gameRetry are called', tone: 'ok' });
  }
  if (network.id === 'moloco') {
    const xhr = html.includes('XMLHttpRequest');
    checks.push({ label: 'XMLHttpRequest', value: xhr ? 'Found; Moloco does not allow it' : 'Not used', tone: xhr ? 'fail' : 'ok' });
  }
  if (network.extra) checks.push({ label: 'Extra assets', value: '{asset} (upload it in the ad console)', vars: { asset: network.extra }, tone: 'warn' });
  const fileName = `${input.slug}-${network.id}.${zipped ? 'zip' : 'html'}`;
  return { fileName, bytes: data.length, limitBytes, checks, blob: new Blob([data], { type: zipped ? 'application/zip' : 'text/html' }) };
}

// ---- Platform zips ----

/** Moves inline scripts into files, as Xiaohongshu Mini Tools require. */
export function splitInlineScripts(html: string): { html: string; scripts: Array<{ name: string; data: string }>; inlineHandlers: number } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const scripts: Array<{ name: string; data: string }> = [];
  for (const script of Array.from(doc.querySelectorAll('script:not([src])'))) {
    const type = script.getAttribute('type');
    if (type && !/^(?:text\/javascript|module|application\/javascript)$/i.test(type)) continue;
    const name = `script-${scripts.length + 1}.js`;
    scripts.push({ name, data: script.textContent ?? '' });
    script.textContent = '';
    script.setAttribute('src', name);
  }
  const inlineHandlers = Array.from(doc.querySelectorAll('*')).reduce((sum, element) => sum + element.getAttributeNames().filter(name => /^on/i.test(name)).length, 0);
  return { html: `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`, scripts, inlineHandlers };
}

const PLATFORM_LIMIT_MB: Partial<Record<GamePackageTarget, number>> = { douyin: 8, xiaohongshu: 8 };

export function buildPlatformZip(loaded: LoadedGameHtml, target: Exclude<GamePackageTarget, 'playable'>, slug: string): GamePackageResult {
  const checks: GamePackageCheck[] = [];
  let files: Array<{ name: string; data: string }> = [{ name: 'index.html', data: loaded.html }];
  if (target === 'xiaohongshu') {
    const split = splitInlineScripts(loaded.html);
    files = [{ name: 'index.html', data: split.html }, ...split.scripts];
    checks.push({ label: 'Inline scripts', value: 'Moved {count} script(s) into files', vars: { count: split.scripts.length }, tone: 'ok' });
    if (split.inlineHandlers) checks.push({ label: 'Inline event handlers', value: '{count} onclick-style attribute(s) left; Builder Hub may reject them', vars: { count: split.inlineHandlers }, tone: 'warn' });
    checks.push({ label: 'ES2017', value: 'Not converted; Builder Hub checks it on upload', tone: 'warn' });
  }
  const data = zipStore(files);
  const limitMb = PLATFORM_LIMIT_MB[target];
  checks.unshift(limitMb
    ? { label: 'Package size', value: '{size} of {limit} MB', vars: { size: formatBytes(data.length), limit: limitMb }, tone: data.length <= limitMb * 1024 * 1024 ? 'ok' : 'fail' }
    : { label: 'Package size', value: '{size}', vars: { size: formatBytes(data.length) }, tone: 'ok' });
  checks.splice(1, 0, { label: 'Entry', value: 'index.html at the root of the zip', tone: 'ok' });
  checks.push(loaded.missing.length
    ? { label: 'Local files', value: '{count} file(s) could not be read: {files}', vars: { count: loaded.missing.length, files: loaded.missing.slice(0, 3).join(', ') }, tone: 'fail' }
    : { label: 'Local files', value: 'Inlined {count} file(s) into the package', vars: { count: loaded.inlined }, tone: 'ok' });
  const external = externalHosts(loaded.html, []);
  checks.push(external.length
    ? { label: 'External resources', value: 'Still loads from {hosts}', vars: { hosts: external.join(', ') }, tone: target === 'itch' ? 'warn' : 'fail' }
    : { label: 'External resources', value: 'None', tone: 'ok' });
  return { fileName: `${slug}-${target}.zip`, bytes: data.length, limitBytes: limitMb ? limitMb * 1024 * 1024 : undefined, checks, blob: new Blob([data], { type: 'application/zip' }) };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function gameSlug(title: string, gameId: string): string {
  const ascii = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return ascii || `game-${gameId.slice(0, 8)}`;
}

/** Saves the package with the browser's download. */
export function downloadPackage(result: Pick<GamePackageResult, 'blob' | 'fileName'>) {
  const url = URL.createObjectURL(result.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
