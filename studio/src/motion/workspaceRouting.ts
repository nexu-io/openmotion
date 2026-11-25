import { artifactViewers, type SessionArtifact } from '../../../shared/session';
import { editorProjectIdFromPath } from '../../../shared/spa-routes';
import { parseProjectIdFromHash } from '../utils/projectRouting';
import { sessionPath } from '../../../shared/workspace-url';

export const projectHref = (id: string) => {
  const encoded = encodeURIComponent(id);
  return `/editor/${encoded}#project/${encoded}`;
};
export const sessionHref = (id: string, projectId?: string, openArtifact = false) => sessionPath(id, projectId, { openArtifact });
export const validWorkspaceProject = (id: string) => /^(?:project|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(id);

/** Semantic `/editor/:id`, hash links from MCP, and legacy query links all address the same project. */
export function requestedProject(search: string, hash: string, pathname = ''): string | null {
  const pathId = pathname ? editorProjectIdFromPath(pathname) : null;
  if (pathId !== null) return pathId;
  const query = new URLSearchParams(search).get('project');
  return query ?? parseProjectIdFromHash(hash) ?? (hash.startsWith('#project/') ? '' : null);
}

export type OpenedPreview = { projectId?: string; revision?: string; sessionId?: string; artifact?: SessionArtifact | null };
export type OpeningHead = { projectId: string; revision: string };
export type WorkspaceRoute = { sessionId: string; artifact?: SessionArtifact; openingHead?: OpeningHead };

export function confirmedRoute(opened: OpenedPreview, projectId: string, sessionId: string | null): WorkspaceRoute | null {
  if (sessionId && opened.sessionId && sessionId !== opened.sessionId) throw new Error('该产物不属于此会话');
  // Earlier cloud versions acknowledged the scoped open without returning a viewer artifact.
  if (opened.artifact === undefined) return null;
  const artifact = opened.artifact;
  if (!artifact || !validWorkspaceProject(projectId) || opened.projectId !== projectId || artifact.projectId !== projectId ||
    !opened.sessionId || !validWorkspaceProject(opened.sessionId) || !Object.hasOwn(artifactViewers, artifact.kind) ||
    typeof artifact.id !== 'string' || !artifact.id || typeof artifact.title !== 'string') {
    throw new Error('项目状态与当前页面不匹配，请重新打开对应项目。');
  }
  return { sessionId: opened.sessionId, artifact };
}
