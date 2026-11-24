import type { OrderedEditEvent } from '../../../shared/ordered-edit-event';
import { applyTextPatchBytes } from '../../../shared/text-patch';
import { confirmedSource, rememberSource } from '../utils/confirmedTextSources';
import { changedFileVersion } from '../components/editor/manualEditsParsing';

// Replaying many byte splices on a multi-megabyte file can block the UI longer
// than one incremental read. Bound only inline work, never the saved edit.
const INLINE_COPY_BUDGET = 32 * 1024 * 1024;

export function orderedFileChange(payload: unknown): OrderedEditEvent | undefined {
  const ordered = (payload as {ordered?: OrderedEditEvent} | null)?.ordered;
  return ordered && typeof ordered.fromRevision === 'string' && Number.isSafeInteger(ordered.historySeq) &&
    Array.isArray(ordered.steps) && ordered.steps.length && ordered.steps.every(step => typeof step?.id === 'string')
    ? ordered : undefined;
}

/** Cheap warm read from already committed bytes. Any missing link takes the usual authoritative GET. */
export function projectOrderedFile(project: string, path: string, payload: unknown) {
  const ordered = orderedFileChange(payload);
  const target = changedFileVersion(payload, path);
  const source = confirmedSource(project, path);
  if (!target || !source) return;
  if (source.version === target) return source;
  if (!ordered) return;
  let version = source.version;
  let copied = 0;
  let bytes: Uint8Array | undefined;
  try {
    for (const step of ordered.steps) {
      for (const change of step.patches ?? []) {
        if (change.path !== path || change.from !== version) continue;
        bytes ??= new TextEncoder().encode(source.content);
        copied += bytes.length;
        if (copied > INLINE_COPY_BUDGET) return;
        bytes = applyTextPatchBytes(bytes, change.patch);
        version = change.to;
      }
    }
    if (!bytes || version !== target) return;
    return { content: new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes), version };
  } catch {
    return;
  }
}

export function readOrderedFile(project: string, path: string, payload: unknown) {
  if (!orderedFileChange(payload)) return;
  const source = projectOrderedFile(project, path, payload);
  if (source && source !== confirmedSource(project, path)) rememberSource(project, path, source);
  return source;
}
