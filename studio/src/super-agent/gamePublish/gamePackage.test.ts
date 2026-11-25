// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildPlatformZip, buildPlayable, rewritePlayableHtml, splitInlineScripts, zipStore } from './gamePackage';
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
});
