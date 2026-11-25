// A fetch preload may finish before Studio subscribes to project changes. Accept its
// data only against the project head observed after subscription. Only the direct
// editor navigation has these links; SPA switches and ordinary refreshes use live reads.
type OpeningTree = { revision?: string; entryVersion?: string | null };
type Source = { content?: string; version?: string | null; missing?: boolean };
type SourceRead = { response: Response; data?: Source };

function versionSignal() {
  let resolve!: (version: string | null) => void;
  const promise = new Promise<string | null>(done => { resolve = done; });
  return { promise, resolve };
}

function createOpening(projectId: string) {
  return { projectId, connected: versionSignal(), tree: versionSignal(),
    fileChangeReceived: false, connectionSeen: false, missingConnection: false,
    treeConsumed: false, sourceConsumed: false };
}

// One direct navigation per document. Only the two opaque versions are retained.
let active: ReturnType<typeof createOpening> | undefined;
let completed: string | undefined;

function openingFor(projectId: string) {
  if (active?.projectId === projectId) return active;
  if (completed === projectId || typeof document === "undefined") return;
  const link = document.querySelector<HTMLLinkElement>('link[data-editor-bootstrap][href*="?view=editor"]');
  if (link && new URL(link.href).pathname === `/api/projects/${encodeURIComponent(projectId)}`) {
    active = createOpening(projectId);
    return active;
  }
}

function finish(opening: ReturnType<typeof createOpening>) {
  if (active === opening && opening.treeConsumed && opening.sourceConsumed && !opening.missingConnection) {
    completed = opening.projectId;
    active = undefined;
  }
}

export function hasEditorOpeningPreload(projectId: string): boolean {
  return !!openingFor(projectId);
}

export function leaveEditorOpening(projectId: string) {
  if (active?.projectId !== projectId) return;
  active.connected.resolve(null);
  active.tree.resolve(null);
  active = undefined;
}

// A rolling deployment, blocked stream or failed tree must not hold the editor.
// A fresh HTTP read is still usable; a delayed SSE connection reconciles the gap.
async function briefly<T>(pending: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1200); })]);
  } finally { clearTimeout(timer); }
}

export function noteOpeningConnection(projectId: string, revision: string | null): boolean {
  const opening = openingFor(projectId);
  if (!opening) return false;
  opening.connectionSeen = true;
  opening.connected.resolve(revision);
  const needsCatchUp = opening.missingConnection;
  opening.missingConnection = false;
  finish(opening);
  return needsCatchUp;
}

export function noteOpeningFileChange(projectId: string) {
  if (active?.projectId === projectId) active.fileChangeReceived = true;
}

export async function readEditorOpeningTree<T extends OpeningTree>(projectId: string, read: () => Promise<T>): Promise<T> {
  const opening = openingFor(projectId);
  if (!opening || opening.treeConsumed) return read();
  try {
    const early = await read();
    const head = await briefly(opening.connected.promise);
    if (!opening.connectionSeen) opening.missingConnection = true;
    // If a file event raced the handshake its ordering relative to the head is
    // unknown. The first read consumed the preload, so a second read goes to HTTP.
    // Subsequent file-list changes already trigger a newer listing in useFileTree.
    // A busy editor never has to wait for a quiet interval to use this snapshot.
    const tree = head && !opening.fileChangeReceived && early.revision === head ? early : await read();
    opening.treeConsumed = true;
    opening.tree.resolve(tree.entryVersion ?? null);
    finish(opening);
    return tree;
  } finally {
    // A failed/unauthorized listing must never strand the independent source read.
    opening.tree.resolve(null);
  }
}

export async function readEditorOpeningSource(projectId: string, url: string, read: (base?: { content: string; version: string }) => Promise<SourceRead>): Promise<SourceRead> {
  if (url !== `/api/projects/${encodeURIComponent(projectId)}/files/index.html`) return read();
  const opening = openingFor(projectId);
  if (!opening || opening.sourceConsumed) return read();
  const early = await read();
  const version = await briefly(opening.tree.promise);
  if (!version && !opening.connectionSeen) opening.missingConnection = true;
  const etag = early.data?.version ?? early.response.headers?.get("etag");
  const content = early.data?.content;
  const verified = version && !opening.fileChangeReceived && etag === version ? early
    : await read(etag && typeof content === "string" ? { content, version: etag } : undefined);
  opening.sourceConsumed = true;
  finish(opening);
  return verified;
}
