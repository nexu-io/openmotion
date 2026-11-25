import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GAME_COMMUNITY_URL,
  buildGameCommunityFeedUrl,
  resetGameCommunityUrlCache,
  resolveGameCommunityUrl,
} from './gameCommunityUrl';

describe('gameCommunityUrl', () => {
  beforeEach(() => {
    resetGameCommunityUrlCache();
    vi.restoreAllMocks();
  });

  it('builds /games URL from production, dashboard, local QA, and fallback origins', () => {
    expect(buildGameCommunityFeedUrl(undefined)).toBe(DEFAULT_GAME_COMMUNITY_URL);
    expect(buildGameCommunityFeedUrl('')).toBe(DEFAULT_GAME_COMMUNITY_URL);
    expect(buildGameCommunityFeedUrl('javascript:alert(1)')).toBe(DEFAULT_GAME_COMMUNITY_URL);
    expect(buildGameCommunityFeedUrl('https://open-design.ai/cloud')).toBe('https://open-design.ai/cloud/games');
    expect(buildGameCommunityFeedUrl('https://open-design.ai/cloud/')).toBe('https://open-design.ai/cloud/games');
    expect(buildGameCommunityFeedUrl('https://open-design.ai/cloud/dashboard')).toBe('https://open-design.ai/cloud/games');
    expect(buildGameCommunityFeedUrl('https://open-design.ai/cloud/games/')).toBe('https://open-design.ai/cloud/games');
    expect(buildGameCommunityFeedUrl('http://127.0.0.1:5179')).toBe('http://127.0.0.1:5179/games');
  });

  it('deduplicates and caches account consoleUrl lookups and falls back gracefully on errors', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ state: 'signed-in', consoleUrl: 'http://127.0.0.1:5179' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([resolveGameCommunityUrl(), resolveGameCommunityUrl()]);
    expect(a).toBe('http://127.0.0.1:5179/games');
    expect(b).toBe('http://127.0.0.1:5179/games');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cached = await resolveGameCommunityUrl();
    expect(cached).toBe('http://127.0.0.1:5179/games');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resetGameCommunityUrlCache();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await resolveGameCommunityUrl()).toBe(DEFAULT_GAME_COMMUNITY_URL);
  });
});
