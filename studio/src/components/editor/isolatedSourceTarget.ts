/** The editable location reported by the preview document the user is looking at. */
export interface IsolatedSourceTarget {
  sourceFile: string;
  sha256?: string;
  fileVersion?: string;
  elementId?: string;
  hfId?: string;
}

export function isolatedSourceVersion(target: IsolatedSourceTarget): string {
  return target.fileVersion ?? '"sha256:' + target.sha256 + '"';
}

export function isIsolatedSourceFile(target: IsolatedSourceTarget | null): target is IsolatedSourceTarget {
  if (!target || typeof target.sourceFile !== "string" || !/\.html?$/i.test(target.sourceFile)) return false;
  const safePath = target.sourceFile.split("/").every(part => part && part !== "." && part !== "..");
  return safePath && !/[\\:%?#\u0000-\u001f]/.test(target.sourceFile)
    && /^"(?:sha256|patch):[0-9a-f]{64}"$/.test(isolatedSourceVersion(target));
}

export function isIsolatedSourceTarget(target: IsolatedSourceTarget | null): target is IsolatedSourceTarget {
  return isIsolatedSourceFile(target) && [target.hfId, target.elementId].some(id => typeof id === "string" && id.length > 0);
}

export function isolatedPatchTarget(location: IsolatedSourceTarget) {
  const { sourceFile, elementId, hfId } = location;
  const target = { ...(hfId && { hfId }), ...(elementId && { id: elementId }) };
  return { sourceFile, ifMatch: isolatedSourceVersion(location), target };
}


const mountedSources = new WeakMap<Document, { projectId: string; sourceVersions: Record<string, string> } | null>();

/** Read once from the actual same-origin preview, never from a newer background file read. */
export function mountedCanvasVersion(doc: Document, projectId: string, path: string): string | undefined {
  if (!mountedSources.has(doc)) {
    const tag = doc.querySelector("script[data-openmotion-source-versions], script[data-openmotion-preview]");
    try {
      const data = JSON.parse(tag?.getAttribute("data-openmotion-preview") ?? tag?.textContent ?? "null");
      mountedSources.set(doc, data && typeof data.sourceVersions === "object" ? data : null);
    } catch { mountedSources.set(doc, null); }
  }
  const source = mountedSources.get(doc);
  const tag = source?.projectId === projectId && source.sourceVersions?.[path];
  if (!tag || typeof tag !== "string") return;
  if (/^[a-f0-9]{64}$/.test(tag)) return '"sha256:' + tag + '"';
  return /^"(?:sha256|patch):[a-f0-9]{64}"$/.test(tag) ? tag : undefined;
}

/** A verified soft history restore changed this document, not other frames at the same old version. */
export function recordMountedCanvasRestore(doc: Document, project: string, path: string, version: string) {
  const source = mountedSources.get(doc);
  if (source?.projectId === project) source.sourceVersions[path] = version;
}
