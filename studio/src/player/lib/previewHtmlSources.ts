type PreviewSources = { projectId: string; entry: string; paths: Set<string> };
const frames = new WeakMap<HTMLIFrameElement, PreviewSources>();
const sceneFiles = new WeakMap<HTMLIFrameElement, { projectId: string; paths: Set<string> }>();

export function forgetPreviewHtmlSources(frame: HTMLIFrameElement | null) {
  if (frame) { frames.delete(frame); sceneFiles.delete(frame); }
}

export function rememberPreviewHtmlSources(frame: HTMLIFrameElement, projectId: string, paths: unknown, independentSceneFiles?: unknown) {
  if (Array.isArray(independentSceneFiles) && independentSceneFiles.every(path => typeof path === 'string' && /\.html?$/i.test(path) && path !== 'index.html')) {
    sceneFiles.set(frame, { projectId, paths: new Set(independentSceneFiles) });
  } else sceneFiles.delete(frame);
  if (Array.isArray(paths) && paths.length && paths.every(path => typeof path === "string") && paths.includes("index.html")) {
    frames.set(frame, { projectId, entry: paths[0], paths: new Set(paths) });
  } else {
    frames.delete(frame);
  }
}

export function areIndependentPreviewFiles(frame: HTMLIFrameElement, projectId: string, path: string, editing?: readonly string[]) {
  const scene = sceneFiles.get(frame);
  return !!(scene?.projectId === projectId && scene.paths.has(path) && editing?.length &&
    editing.every(file => file !== path && scene.paths.has(file)));
}

/** This graph belongs to the mounted document. Verified in-place edits preserve its HTML inputs. */
export function isUnrelatedPreviewHtmlChange(
  frame: HTMLIFrameElement | null, projectId: string | null, activePath: string | null,
  changed: readonly string[] | null, treeChanged: boolean,
): boolean {
  const scope = frame && frames.get(frame);
  return Boolean(scope && scope.projectId === projectId && activePath === scope.entry && !treeChanged &&
    changed?.length && changed.every(path => /\.html?$/i.test(path) && !scope.paths.has(path)));
}
