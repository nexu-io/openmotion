// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GalleryTemplate } from '../../../shared/catalog';
import { createRepositoryStarsReader, GITHUB_REPOSITORY, templateRepositoryUrl } from './githubRepository';

beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('shares a single public star request and reuses persisted counts across readers', async () => {
  const fetcher = vi.fn(async () => Response.json({ stargazers_count: 9796 }));
  vi.stubGlobal('fetch', fetcher);
  const read = createRepositoryStarsReader();
  expect(await Promise.all([read(), read()])).toEqual([9796, 9796]);
  expect(await createRepositoryStarsReader()()).toBe(9796);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith('https://api.github.com/repos/nexu-io/openmotion', expect.objectContaining({ credentials: 'omit' }));
});

it('hides an expired count when GitHub is unavailable, then retries after the cooldown', async () => {
  let now = 5_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  localStorage.setItem('openmotion.github-stars', JSON.stringify({ count: 9000, at: 1 }));
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 403 })).mockResolvedValueOnce(Response.json({ stargazers_count: 9796 }));
  vi.stubGlobal('fetch', fetcher);
  const read = createRepositoryStarsReader();
  expect(await read()).toBeNull();
  expect(await read()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  now += 61_000;
  expect(await read()).toBe(9796);
});

it('hides the count for malformed data instead of showing a snapshot', async () => {
  localStorage.setItem('openmotion.github-stars', 'invalid');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ stargazers_count: -1 })));
  expect(await createRepositoryStarsReader()()).toBeNull();
});

it('links repository templates and built-in projects to their exact public directories', () => {
  const template = (id: string) => ({ id }) as GalleryTemplate;
  expect(templateRepositoryUrl(template('product-promo'))).toBe(`${GITHUB_REPOSITORY}/tree/main/template-library/product-promo`);
  expect(templateRepositoryUrl(template('motion-dfb1a35a-a70e-489f-8e02-b74068fc0b8c'))).toBe(`${GITHUB_REPOSITORY}/tree/main/library/templates/catalog/motion-dfb1a35a-a70e-489f-8e02-b74068fc0b8c`);
  expect(templateRepositoryUrl(template('../invalid'))).toBe(`${GITHUB_REPOSITORY}/tree/main/library/templates`);
});

it.each([undefined, null, '9796', -1, 1.5])('rejects an invalid star count (%s)', async count => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ stargazers_count: count })));
  expect(await createRepositoryStarsReader()()).toBeNull();
});

it('accepts zero stars and refreshes a successful count after five minutes', async () => {
  let now = 5_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ stargazers_count: 0 })).mockResolvedValueOnce(Response.json({ stargazers_count: 123 }));
  vi.stubGlobal('fetch', fetcher);
  const read = createRepositoryStarsReader();
  expect(await read()).toBe(0);
  now += 299_000;
  expect(await read()).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  now += 2_000;
  expect(await read()).toBe(123);
});

it('hides the count when the request times out', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Timed out', 'TimeoutError'); }));
  expect(await createRepositoryStarsReader()()).toBeNull();
});

it('persists GitHub 403/429 rate-limit backoff across readers honoring full x-ratelimit-reset and Retry-After deadlines', async () => {
  let now = 10_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  // Primary rate limit 40 minutes away must not be truncated to 15 minutes.
  const resetEpochSeconds = Math.ceil((now + 40 * 60_000) / 1000);
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response('', { status: 403, headers: { 'x-ratelimit-reset': String(resetEpochSeconds) } }))
    .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '180' } }))
    .mockResolvedValueOnce(new Response('', { status: 403, headers: { 'retry-after': new Date(now + 40 * 60_000 + 181_000 + 120_000).toUTCString() } }))
    .mockResolvedValueOnce(Response.json({ stargazers_count: 10001 }));
  vi.stubGlobal('fetch', fetcher);

  expect(await createRepositoryStarsReader()()).toBeNull();
  // Still backed off at 20 minutes (past the old 15-minute cap) across a fresh reader.
  now += 20 * 60_000;
  expect(await createRepositoryStarsReader()()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);

  // After the full 40-minute reset window, retries and receives secondary Retry-After: 180s.
  now += 20 * 60_000 + 1000;
  expect(await createRepositoryStarsReader()()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);

  now += 120_000;
  expect(await createRepositoryStarsReader()()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);

  // After 180s Retry-After, retries and receives HTTP-date Retry-After (+120s).
  now += 61_000;
  expect(await createRepositoryStarsReader()()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(3);

  now += 60_000;
  expect(await createRepositoryStarsReader()()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(3);

  now += 62_000;
  expect(await createRepositoryStarsReader()()).toBe(10001);
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it('does not let an unexhausted primary x-ratelimit-reset extend a secondary Retry-After cooldown', async () => {
  let now = 20_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const reset40m = Math.ceil((now + 40 * 60_000) / 1000);
  const reset40mAfter = Math.ceil((now + 61_000 + 40 * 60_000) / 1000);
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response('', {
      status: 403,
      headers: {
        'retry-after': '60',
        'x-ratelimit-remaining': '42',
        'x-ratelimit-reset': String(reset40m),
      },
    }))
    .mockResolvedValueOnce(new Response('', {
      status: 403,
      headers: {
        'retry-after': '60',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(reset40mAfter),
      },
    }))
    .mockResolvedValueOnce(Response.json({ stargazers_count: 10002 }));
  vi.stubGlobal('fetch', fetcher);

  // Secondary limit with remaining=42 must wait only 60s, NOT 40 minutes.
  expect(await createRepositoryStarsReader()()).toBeNull();
  now += 59_000;
  expect(await createRepositoryStarsReader()()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);

  now += 2_000;
  expect(await createRepositoryStarsReader()()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);

  // Primary quota exhausted (remaining=0) with both headers must wait the full 40-minute reset.
  now += 20 * 60_000;
  expect(await createRepositoryStarsReader()()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);

  now += 20 * 60_000 + 2_000;
  expect(await createRepositoryStarsReader()()).toBe(10002);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
