import type { GalleryTemplate } from '../../../shared/catalog';
export const GITHUB_REPOSITORY = 'https://github.com/nexu-io/openmotion';
export const repositorySupportLinks = [
  { label: "What's new", href: `${GITHUB_REPOSITORY}/releases`, icon: 'history-line' },
  { label: 'Feedback', href: `${GITHUB_REPOSITORY}/issues/new/choose`, icon: 'chat-1-line' },
] as const;
const STARS_API = 'https://api.github.com/repos/nexu-io/openmotion';
const CACHE_KEY = 'openmotion.github-stars';
const BACKOFF_KEY = 'openmotion.github-stars.backoff';
const CACHE_TTL = 5 * 60 * 1000;
const DEFAULT_RETRY_MS = 60_000;
const MAX_RATE_LIMIT_RETRY_MS = 15 * 60_000;
type StarsCache = { count: number; at: number };

function readPersistedRetryAt(): number {
  try {
    const raw = Number(localStorage.getItem(BACKOFF_KEY));
    if (Number.isFinite(raw) && raw > Date.now() && raw - Date.now() <= MAX_RATE_LIMIT_RETRY_MS) return raw;
  } catch { /* Unavailable storage must not affect navigation. */ }
  return 0;
}

function persistRetryAt(nextRetryAt: number): void {
  try {
    if (nextRetryAt > Date.now()) localStorage.setItem(BACKOFF_KEY, String(nextRetryAt));
    else localStorage.removeItem(BACKOFF_KEY);
  } catch { /* Best effort. */ }
}

export function templateRepositoryUrl(template: GalleryTemplate): string {
  if (['product-promo', 'nyt-graph', 'decision-tree'].includes(template.id)) return `${GITHUB_REPOSITORY}/tree/main/template-library/${template.id}`;
  if (/^motion-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(template.id)) return `${GITHUB_REPOSITORY}/tree/main/library/templates/catalog/${template.id}`;
  return `${GITHUB_REPOSITORY}/tree/main/library/templates`;
}

/** One public request shared by both headers; persisted successes survive reloads. */
export function createRepositoryStarsReader() {
  let cached: StarsCache | undefined;
  let pending: Promise<number | null> | undefined;
  let retryAt = 0;
  return function readStars(): Promise<number | null> {
    if (!cached) {
      try {
        const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as StarsCache | null;
        if (value && Number.isSafeInteger(value.count) && value.count >= 0 && Number.isFinite(value.at) && value.at <= Date.now()) cached = value;
      } catch { /* Unavailable or invalid storage must not affect navigation. */ }
    }
    if (Date.now() < Math.max(retryAt, readPersistedRetryAt())) return Promise.resolve(null);
    if (cached && Date.now() - cached.at < CACHE_TTL) return Promise.resolve(cached.count);
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetch(STARS_API, { credentials: 'omit', headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(5000) });
        if (response.status === 403 || response.status === 429) {
          const resetSeconds = Number(response.headers.get('x-ratelimit-reset'));
          const now = Date.now();
          const resetMs = Number.isFinite(resetSeconds) && resetSeconds * 1000 > now
            ? Math.min(resetSeconds * 1000 - now, MAX_RATE_LIMIT_RETRY_MS)
            : DEFAULT_RETRY_MS;
          retryAt = now + Math.max(DEFAULT_RETRY_MS, resetMs);
          persistRetryAt(retryAt);
          return null;
        }
        if (!response.ok) throw new Error('GitHub unavailable');
        const { stargazers_count: count } = await response.json();
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid star count');
        cached = { count, at: Date.now() };
        persistRetryAt(0);
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(cached)); } catch { /* Memory cache remains available. */ }
        return count as number;
      } catch {
        retryAt = Date.now() + DEFAULT_RETRY_MS;
        return null;
      } finally { pending = undefined; }
    })();
    return pending;
  };
}

export const readRepositoryStars = createRepositoryStarsReader();
