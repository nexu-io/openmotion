/** Project and template handoff URLs retain their editor context. Keep this
 * decision independent of the Studio catalog so bootstrap can reuse it. */
export function workspacePageName(query: URLSearchParams, hash: string) {
  const page = query.get('page');
  if (page !== null && page !== 'api') return page;
  if (query.has('project') || query.has('session') || hash.startsWith('#project/') || query.get('templates') === '1' || query.get('hostChrome') === '1') return null;
  return 'explore';
}
