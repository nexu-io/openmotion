import { ORDERED_TEXT_EDITS_HEADER } from '../../../shared/ordered-text-edits';
import { getCachedCloudDisklessMode } from './cloudRuntime';
import { studioFileContentVersion } from "./studioFileVersion";

// Sources belong to the exact revision observed on a capability-advertising cloud read.
// Keep recent active compositions only. An eviction always has an authoritative read fallback.
export interface ConfirmedSource { content: string; version: string }
const sources = new Map<string, ConfirmedSource>();
const capableProjects = new Map<string, { patches: boolean; ordered: boolean }>();
let codeUnits = 0;
const key = (projectId: string, path: string) => JSON.stringify([projectId, path]);

// A save can already have the selected file on its way to the SDK. Wait for
// that read, then check the exact required revision before using its content.
const pendingReads = new Map<string, Promise<unknown>>();

export function observePendingSourceRead<T>(projectId: string, path: string, read: Promise<T>) {
  const id = key(projectId, path);
  pendingReads.set(id, read);
  return read.finally(() => {
    if (pendingReads.get(id) === read) pendingReads.delete(id);
  });
}

export function pendingSourceRead(projectId: string, path: string) {
  return pendingReads.get(key(projectId, path));
}

type AssetSummary = {version?: string; mimeType?: string};
const assetListings = new Map<string, Readonly<Record<string, AssetSummary>>>();

/** Reuse the file tree response. Binary inputs need their identity, never their bytes. */
export function observeEditAssets(project: string, assets?: Readonly<Record<string, AssetSummary>>) {
  assetListings.delete(project);
  if (assets) assetListings.set(project, assets);
  if (assetListings.size > 16) assetListings.delete(assetListings.keys().next().value!);
}
export function observedEditAsset(project: string, path: string) {
  return assetListings.get(project)?.[path];
}

export function confirmedSource(projectId: string, path: string) {
  return sources.get(key(projectId, path));
}

// Only HTTP reads completed during one uninterrupted period without file events are
// reusable when revisiting a clip. The weak set owns no source bytes.
const observedStreams = new Map<string, { stream: EventSource; reads: WeakSet<ConfirmedSource> }>();
export function trackSourceReadStream(projectId: string | null, stream: EventSource) {
  if (!projectId) return;
  const renew = () => observedStreams.set(projectId, { stream, reads: new WeakSet() });
  const close = () => {
    if (observedStreams.get(projectId)?.stream === stream) observedStreams.delete(projectId);
  };
  const invalidate = () => {
    if (observedStreams.get(projectId)?.stream === stream) renew();
  };
  stream.addEventListener("open", renew);
  stream.addEventListener("file-change", invalidate);
  stream.addEventListener("error", close);
  return () => {
    close();
    stream.removeEventListener("open", renew);
    stream.removeEventListener("file-change", invalidate);
    stream.removeEventListener("error", close);
  };
}
export function liveSourceReads(projectId: string) {
  const owner = observedStreams.get(projectId);
  return owner && owner.stream.readyState === EventSource.OPEN ? owner.reads : undefined;
}

export function supportsProjectTextEdits(projectId: string) {
  return capableProjects.get(projectId)?.patches === true;
}

export function supportsOrderedTextEdits(projectId: string) {
  return getCachedCloudDisklessMode() || capableProjects.get(projectId)?.ordered === true;
}

export async function observedSourceVersion(projectId: string, path: string, content: string) {
  const known = confirmedSource(projectId, path);
  if (known?.content === content) return known.version;
  return studioFileContentVersion(content);
}

export function forgetSource(projectId: string, path: string) {
  if (assetListings.get(projectId)?.[path]) assetListings.delete(projectId);
  forget(key(projectId, path));
}

export function forgetProjectSources(projectId: string) {
  for (const id of sources.keys()) {
    if (JSON.parse(id)[0] === projectId) forget(id);
  }
}

function forget(id: string) {
  const previous = sources.get(id);
  if (previous) codeUnits -= previous.content.length;
  sources.delete(id);
}

export function rememberSource(projectId: string, path: string, source: ConfirmedSource) {
  const id = key(projectId, path);
  forget(id);
  sources.set(id, source);
  codeUnits += source.content.length;
  // A single large active file still needs its revision for the next write.
  while (sources.size > 1 && (sources.size > 64 || codeUnits > 4 * 1024 * 1024)) {
    forget(sources.keys().next().value!);
  }
}

export function observeSourceRead(projectId: string, path: string, response: Response, data: { content?: string; version?: string | null }) {
  const version = data.version ?? response.headers?.get('etag');
  const capable = response.headers?.get('X-OpenMotion-Text-Edits') === '1';
  const ordered = response.headers?.get(ORDERED_TEXT_EDITS_HEADER) === '1';
  capableProjects.delete(projectId);
  if (capable || ordered) {
    capableProjects.set(projectId, { patches: capable, ordered });
    if (capableProjects.size > 128) capableProjects.delete(capableProjects.keys().next().value!);
  }
  if ((capable || ordered) && typeof data.content === 'string' && version) rememberSource(projectId, path, {content: data.content, version});
  else forgetSource(projectId, path);
}
