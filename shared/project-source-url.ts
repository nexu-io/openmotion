/** A mutable file read is an API resource even when the authored path ends in a media extension. */
export const PROJECT_SOURCE_ROUTE = '/api/projects/:id/file-source';

export function projectSourceReadUrl(projectId: string, path: string): string {
  return PROJECT_SOURCE_ROUTE.replace(':id', encodeURIComponent(projectId)) + '?path=' + encodeURIComponent(path);
}
