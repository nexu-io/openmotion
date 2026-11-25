// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildPlatformZip, buildPlayable, loadGameHtml, rewritePlayableHtml, splitInlineScripts, zipStore } from './gamePackage';
import { PLAYABLE_NETWORKS, playableNetwork } from './playableNetworks';

const GAME = '<!DOCTYPE html><html><head><title>t</title></head><body><button onclick="openStore(1)">x</button><script>function openStore(s){window.mraid&&mraid.open("a")}</script></body></html>';
const loaded = { html: GAME, inlined: 2, missing: [] };

describe('gamePackage', () => {
  it('writes a valid stored zip', () => {
    const zip = zipStore([{ name: 'index.html', data: 'hello' }, { name: 'config.json', data: '{}' }]);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(zip.length - 12, true)).toBe(2);
    // CRC-32 of "hello"
    expect(view.getUint32(14, true)).toBe(0x3610a686);
  });

  it('routes the store button to each network CTA', () => {
    for (const network of PLAYABLE_NETWORKS) {
      const { html, rewrites, injectedButton } = rewritePlayableHtml({ html: GAME, network, ios: 'https://apps.apple.com/app/id1', buttonText: 'Download' });
      expect(rewrites).toBe(1);
      expect(injectedButton).toBe(false);
      expect(html).toContain(network.ctaCode);
      expect(html).not.toContain('function openStore(');
      const hasMraid = html.includes('<script src="mraid.js"></script>');
      expect(hasMraid).toBe(['mraid', 'applovin', 'liftoff'].includes(network.id));
    }
  });

  it('adds a store button when the game has none', () => {
    const { html, injectedButton } = rewritePlayableHtml({ html: '<html><head></head><body></body></html>', network: playableNetwork('meta')!, buttonText: 'Download' });
    expect(injectedButton).toBe(true);
    expect(html).toContain('id="om-cta"');
  });

  it('measures the real file and flags a package over the limit', () => {
    const big = { ...loaded, html: GAME.replace('<title>t</title>', `<title>${'x'.repeat(2.2 * 1024 * 1024)}</title>`) };
    const meta = buildPlayable(big, { networkName: 'Meta (≤2 MB)', slug: 'g', ios: 'https://a', android: 'https://b', buttonText: 'Download' });
    expect(meta.checks[0]).toMatchObject({ label: 'Package size', tone: 'fail' });
    expect(meta.bytes).toBe(meta.blob.size);
    const tiktok = buildPlayable(loaded, { networkName: 'TikTok / Pangle', slug: 'g', ios: 'https://a', buttonText: 'Download' });
    expect(tiktok.fileName).toBe('g-tiktok.zip');
    expect(tiktok.checks.find(check => check.label === 'config.json')?.tone).toBe('ok');
  });

  it('moves inline scripts into files for Xiaohongshu and counts inline handlers', () => {
    const split = splitInlineScripts(GAME);
    expect(split.scripts).toHaveLength(1);
    expect(split.html).toContain('src="script-1.js"');
    expect(split.inlineHandlers).toBe(1);
    const zip = buildPlatformZip(loaded, 'douyin', 'g');
    expect(zip.limitBytes).toBe(8 * 1024 * 1024);
    expect(zip.checks[0]).toMatchObject({ label: 'Package size', tone: 'ok' });
  });

  it.each(['xiaohongshu', 'douyin'] as const)('flags actual %s archives exceeding 8 MB', target => {
    const normal = buildPlatformZip(loaded, target, 'g');
    expect(normal.limitBytes).toBe(8 * 1024 * 1024);
    // Multi-byte text and ZIP entry headers count towards the downloaded size.
    const oversized = buildPlatformZip({ ...loaded, html: `<html><body>${'月'.repeat(3 * 1024 * 1024)}</body></html>` }, target, 'g');
    expect(oversized.bytes).toBe(oversized.blob.size);
    expect(oversized.bytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(oversized.checks[0]).toMatchObject({ label: 'Package size', tone: 'fail' });
  });

  it('inlines the actual local game scripts, styles and images and reports missing files', async () => {
    const source = '<html><head><link rel="stylesheet" href="style.css"></head><body><img src="assets/icon.svg"><script src="client.js"></script><audio src="missing.mp3"></audio></body></html>';
    const files: Record<string, [string, string]> = {
      'index.html': [source, 'text/html'],
      'style.css': ['canvas { display: block; }', 'text/css'],
      'client.js': ['window.gameLoaded = true;', 'text/javascript'],
      'assets/icon.svg': ['<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'],
    };
    const result = await loadGameHtml('game-id', async input => {
      const file = String(input).split('/play/')[1];
      const value = files[file];
      return value ? new Response(value[0], { headers: { 'content-type': value[1] } }) : new Response('', { status: 404 });
    });
    expect(result.inlined).toBe(3);
    expect(result.missing).toEqual(['missing.mp3']);
    expect(result.html).toContain('<style>canvas { display: block; }</style>');
    expect(result.html).toContain('window.gameLoaded = true;');
    expect(result.html).toContain('data:image/svg+xml;base64,');
    expect(result.html).not.toContain('src="client.js"');
    expect(buildPlatformZip(result, 'itch', 'g').checks).toContainEqual(expect.objectContaining({ label: 'Local files', tone: 'fail' }));
  });
});
