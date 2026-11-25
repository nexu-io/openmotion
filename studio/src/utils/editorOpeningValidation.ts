import type { OpeningHead } from '../motion/workspaceRouting';

// Only direct navigations have these links. A matching scoped open can verify the
// preload before subscription; the post-subscribe head still has to close the gap.
type OpeningTree = { revision?: string; entryVersion?: string | null };
type Source = { content?: string; version?: string | null; missing?: boolean };
type SourceRead = { response: Response; data?: Source };
const OPENING_DEADLINE_MS = 1200;

function versionSignal() {
  let resolve!: (version: string | null) => void;
  const promise = new Promise<string | null>(done => { resolve = done; });
  return { promise, resolve };
}

function createOpening(projectId: string) {
  return { projectId, connected: versionSignal(), tree: versionSignal(),
    fileChangeReceived: false, connectionSeen: false, missingConnection: false,
    beforeSubscription: null as string | null, deadlineExpired: false, treeRequest: 0, treeConsumed: false, sourceConsumed: false };
}

// One direct navigation per document. Keep only opaque versions, never source bytes.
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
  if (active === opening && opening.treeConsumed && opening.sourceConsumed && !opening.missingConnection && !opening.beforeSubscription) {
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
    return await Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), OPENING_DEADLINE_MS); })]);
  } finally { clearTimeout(timer); }
}

// A blocked stream won't necessarily report an error or reopen. Keep the live
// HTTP fallback, but do it in the background if the route already verified the tree.
export function watchOpeningDeadline(projectId: string, catchUp: () => void) {
  const opening = openingFor(projectId);
  if (!opening) return;
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { stopped = true; clearTimeout(timer); };
  void opening.connected.promise.then(stop);
  void opening.tree.promise.then(() => {
    if (!stopped && opening.beforeSubscription) timer = setTimeout(() => {
      if (active !== opening || !opening.beforeSubscription || opening.deadlineExpired) return;
      opening.deadlineExpired = true;
      catchUp();
    }, OPENING_DEADLINE_MS);
  });
  return stop;
}

export function noteOpeningConnection(projectId: string, revision: string | null): boolean {
  const opening = openingFor(projectId);
  if (!opening) return false;
  opening.connectionSeen = true;
  opening.connected.resolve(revision);
  const needsCatchUp = opening.missingConnection || (opening.beforeSubscription !== null &&
    (revision !== opening.beforeSubscription || opening.fileChangeReceived));
  // The source preload may still be in flight, or not yet requested. Do not
  // confirm it against an entry version from a tree that now needs reconciliation.
  if (needsCatchUp) opening.fileChangeReceived = true;
  opening.beforeSubscription = null;
  opening.missingConnection = false;
  finish(opening);
  return needsCatchUp;
}

export function noteOpeningFileChange(projectId: string) {
  if (active?.projectId === projectId) active.fileChangeReceived = true;
}

export async function readEditorOpeningTree<T extends OpeningTree>(projectId: string, read: () => Promise<T>, scopedHead?: OpeningHead): Promise<T> {
  const opening = openingFor(projectId);
  if (!opening || opening.treeConsumed) return read();
  const request = ++opening.treeRequest;
  try {
    const early = await read();
    let tree = early;
    if (active === opening && request === opening.treeRequest && !opening.connectionSeen && !opening.fileChangeReceived &&
        scopedHead?.projectId === projectId && early.revision && early.revision === scopedHead.revision) {
      opening.beforeSubscription = early.revision;
    } else {
      const head = await briefly(opening.connected.promise);
      if (request === opening.treeRequest && !opening.connectionSeen) opening.missingConnection = true;
      // A file event racing the handshake has unknown ordering. The preload has
      // been consumed, so the second read goes to HTTP; don't wait for quiescence.
      if (active !== opening || !head || opening.fileChangeReceived || early.revision !== head) tree = await read();
    }
    if (request === opening.treeRequest) {
      opening.treeConsumed = true;
      opening.tree.resolve(tree.entryVersion ?? null);
      finish(opening);
    }
    return tree;
  } finally {
    // A failed/unauthorized listing must never strand the independent source read.
    if (request === opening.treeRequest) opening.tree.resolve(null);
  }
}

export async function readEditorOpeningSource(projectId: string, url: string, read: (base?: { content: string; version: string }) => Promise<SourceRead>, knownVersion?: string): Promise<SourceRead> {
  if (url !== `/api/projects/${encodeURIComponent(projectId)}/files/index.html`) return read();
  const opening = openingFor(projectId);
  if (!opening || opening.sourceConsumed) return read();
  const early = await read();
  const version = await briefly(opening.tree.promise);
  if (!version && !opening.connectionSeen) opening.missingConnection = true;
  const etag = early.data?.version ?? early.response.headers?.get("etag");
  const content = early.data?.content;
  const verified = active === opening && version && !opening.fileChangeReceived && !opening.deadlineExpired && etag === version &&
    (!knownVersion || knownVersion === version) ? early
    : await read(etag && typeof content === "string" ? { content, version: etag } : undefined);
  opening.sourceConsumed = true;
  finish(opening);
  return verified;
}
