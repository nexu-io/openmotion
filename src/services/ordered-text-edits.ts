import type {
  OrderedTextEditBase, OrderedTextEditOperation, OrderedTextEditReceipt, OrderedTextEditResult,
} from '../../shared/ordered-text-edits.ts';
import { CloudError, isCloudError } from '../contracts/errors.ts';
import type { CommitProjectFilesResult } from './project-files-service.ts';
import { orderedTextEditSchema } from './text-edit-input.ts';

function invalid(message: string) {
  return new CloudError('INVALID_ARGUMENT', message, { status: 400, applied: false });
}

/** Validate the envelope and all intra-batch links before accepting the first operation. */
function parseOrderedTextEdits(input: unknown, patchWrites: boolean) {
  const parsed = orderedTextEditSchema.safeParse(input);
  if (!parsed.success) throw invalid('Supply a valid ordered text edit batch');
  const previous = new Map<string, Set<string>>();
  for (const op of parsed.data.operations) {
    if (!patchWrites && op.files.some(file => 'patch' in file)) {
      throw new CloudError('SERVICE_UNAVAILABLE', 'Text patch writes are disabled', { status: 503, applied: false });
    }
    if (previous.has(op.id)) throw invalid('Use distinct operation IDs');
    const check = (path: string, base: OrderedTextEditBase) => {
      if (base && typeof base === 'object' && !previous.get(base.after)?.has(path)) {
        throw invalid('A version reference must name an earlier edit of the same file');
      }
    };
    for (const file of op.files) check(file.path, file.baseVersion);
    for (const [path, base] of Object.entries(op.dependencies ?? {})) check(path, base);
    previous.set(op.id, new Set(op.files.map(file => file.path)));
  }
  return parsed.data.operations;
}

type ResolvedOperation = Omit<OrderedTextEditOperation, 'id' | 'files' | 'dependencies'> & {
  files: Array<OrderedTextEditOperation['files'][number] & {baseVersion: string | null}>;
  dependencies?: Record<string, string | null>;
};

/** A transport batch preserves each edit's existing transaction and idempotency receipt. */
export async function commitOrderedTextEdits(
  body: unknown, commit: (operation: ResolvedOperation, id: string) => Promise<CommitProjectFilesResult>, patchWrites = true,
): Promise<OrderedTextEditResult> {
  const receipts = new Map<string, OrderedTextEditReceipt>();
  function resolve(path: string, base: OrderedTextEditBase): string | null {
    if (base === null) return null;
    if (typeof base === 'string') return base;
    const versions = receipts.get(base.after)?.versions;
    if (!versions || !Object.hasOwn(versions, path)) throw new Error('Missing output version for an accepted edit');
    return versions[path]!;
  }
  for (const { id, files, dependencies, ...metadata } of parseOrderedTextEdits(body, patchWrites)) {
    try {
      const result = await commit({
        ...metadata,
        files: files.map(file => ({...file, baseVersion: resolve(file.path, file.baseVersion)})),
        ...(dependencies && {dependencies: Object.fromEntries(
          Object.entries(dependencies).map(([path, base]) => [path, resolve(path, base)]),
        )}),
      }, id);
      receipts.set(id, { id, versions: result.versionsByPath, changedPaths: result.changedPaths,
        revision: result.revision, versionId: result.versionId, writeToken: result.writeToken });
    } catch (error) {
      // Auth and transient failures retain their HTTP semantics. An uncertain transport
      // outcome is retried with the same operation IDs, including the committed prefix.
      if (!isCloudError(error) || !['INVALID_ARGUMENT', 'INVALID_PATH', 'VERSION_CONFLICT', 'REQUEST_ID_CONFLICT'].includes(error.code)) throw error;
      const { path, currentVersion } = error.details ?? {};
      return { committed: [...receipts.values()], failed: {
        id, status: error.status, code: error.code, message: error.message,
        ...(typeof path === 'string' && {path}),
        ...(typeof currentVersion === 'string' ? { currentVersion } : currentVersion === null ? { currentVersion: null } : {}),
      } };
    }
  }
  return { committed: [...receipts.values()] };
}
