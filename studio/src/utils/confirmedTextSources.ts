import { ORDERED_TEXT_EDITS_HEADER } from '../../../shared/ordered-text-edits';
import { studioFileContentVersion } from "./studioFileVersion";

// Sources belong to the exact revision observed on a capability-advertising cloud read.
// Keep recent active compositions only. An eviction always has an authoritative read fallback.
export interface ConfirmedSource { content: string; version: string }
const sources = new Map<string, ConfirmedSource>();
const capableProjects = new Map<string, boolean>();
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

export function confirmedSource(projectId: string, path: string) {
  return sources.get(key(projectId, path));
}

export function supportsProjectTextEdits(projectId: string) {
  return capableProjects.has(projectId);
}

export function supportsOrderedTextEdits(projectId: string) {
  return capableProjects.get(projectId) === true;
}

export async function observedSourceVersion(projectId: string, path: string, content: string) {
  const known = confirmedSource(projectId, path);
  if (known?.content === content) return known.version;
  return studioFileContentVersion(content);
}

export function forgetSource(projectId: string, path: string) {
  forget(key(projectId, path));
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
  capableProjects.delete(projectId);
  if (capable) {
    capableProjects.set(projectId, response.headers?.get(ORDERED_TEXT_EDITS_HEADER) === '1');
    if (capableProjects.size > 128) capableProjects.delete(capableProjects.keys().next().value!);
  }
  if (capable && typeof data.content === 'string' && version) rememberSource(projectId, path, {content: data.content, version});
  else forgetSource(projectId, path);
}
