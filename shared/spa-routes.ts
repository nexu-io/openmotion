import { isWorkspaceSettingsPage } from './workspace-url.ts';

/**
 * Prefixes owned by local/cloud HTTP APIs, MCP protocol endpoints, static build
 * assets, or host integration handlers. Neither the local server nor dev proxies
 * may rewrite these paths to `studio/build/index.html`.
 */
export const RESERVED_BACKEND_PREFIXES = [
  '/api',
  '/motion-api',
  '/design-api',
  '/mcp',
  '/mcp-ui',
  '/connect',
  '/sessions',
  '/editor-assets',
  '/guide-assets',
  '/design-system',
  '/web',
  '/.well-known',
  '/__hyperframes_config',
] as const;

/**
 * Explicit allowlist of Studio SPA route prefixes served with `studio/build/index.html`.
 * Keeping an allowlist (instead of a blind wildcard) guarantees unknown backend routes,
 * missing assets, and repository source paths continue returning 404.
 */
export const SPA_ROUTE_PREFIXES = [
  '/',
  '/explore',
  '/create',
  '/motion',
  '/cinema',
  '/design',
  '/sound',
  '/scenarios',
  '/game',
  '/skills',
  '/models',
  '/assets',
  '/brand-kit',
  '/settings',
  '/mcp-setup',
  '/templates',
  '/editor',
] as const;

/**
 * Standalone SPA path prefixes that render without requiring a local native
 * Hyperframes editor process to start beforehand.
 */
export const STANDALONE_SPA_PREFIXES = SPA_ROUTE_PREFIXES.filter(
  prefix => prefix !== '/' && prefix !== '/editor',
);

const NON_SPA_FILE_EXTENSION = /\.(?:js|mjs|cjs|ts|tsx|jsx|css|map|json|html|htm|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|eot|mp4|webm|mov|m4a|mp3|wav|txt|md|ya?ml|xml|zip|tgz|pdf)$/i;

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === '/') return pathname === '/';
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

export function isReservedBackendPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return RESERVED_BACKEND_PREFIXES.some(prefix => matchesPrefix(normalized, prefix));
}

export function isSpaRoutePath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  if (normalized === '/') return true;
  if (isReservedBackendPath(normalized)) return false;
  if (NON_SPA_FILE_EXTENSION.test(normalized)) return false;
  return SPA_ROUTE_PREFIXES.some(prefix => prefix !== '/' && matchesPrefix(normalized, prefix));
}

/**
 * Standalone Studio routes stay usable even when the local native project
 * cannot initialize (for example Settings, MCP setup, Explore, or Studios).
 */
export function isStandaloneSpaPath(pathname: string, search = '', hash = ''): boolean {
  const normalized = normalizePathname(pathname);
  if (normalized === '/') return isWorkspaceSettingsPage(search, hash);
  if (matchesPrefix(normalized, '/editor')) return false;
  return STANDALONE_SPA_PREFIXES.some(prefix => matchesPrefix(normalized, prefix));
}

/** Extract the project ID from `/editor/:projectId`, if present. */
export function editorProjectIdFromPath(pathname: string): string | null {
  const normalized = normalizePathname(pathname);
  const match = normalized.match(/^\/editor\/([^/]+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
