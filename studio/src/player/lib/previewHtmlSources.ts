type PreviewSources = { projectId: string; entry: string; paths: Set<string> };
const frames = new WeakMap<HTMLIFrameElement, PreviewSources>();

export function forgetPreviewHtmlSources(frame: HTMLIFrameElement | null) {
  if (frame) frames.delete(frame);
}

export function rememberPreviewHtmlSources(frame: HTMLIFrameElement, projectId: string, paths: unknown) {
  if (Array.isArray(paths) && paths.length && paths.every(path => typeof path === "string") && paths.includes("index.html")) {
    frames.set(frame, { projectId, entry: paths[0], paths: new Set(paths) });
  } else {
    frames.delete(frame);
  }
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
