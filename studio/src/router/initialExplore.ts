import { workspacePageName } from '../../../shared/workspace-page-name';

/** Only warm an unambiguous Explore landing, not the library or a template
 * detail over it. Never speculate based on a query alone on other paths. */
export function isInitialExplore({ pathname, search, hash }: Pick<Location, 'pathname' | 'search' | 'hash'>) {
  if (pathname !== '/' && !/^\/explore(?:\/[\w-]+)?\/?$/.test(pathname)) return false;
  const query = new URLSearchParams(search);
  if (query.get('templates') === '1' || query.get('template') || query.get('hostChrome') === '1') return false;
  if (pathname !== '/' && !query.has('page')) return true;
  return workspacePageName(query, hash) === 'explore';
}
