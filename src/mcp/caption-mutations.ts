import { createHash, randomUUID } from 'node:crypto';
import type { loadCaptionSourceOperations } from '../../shared/transcript-captions.ts';
import type { CaptionSourceCommand } from '../../packages/edit-core/captions.ts';
import type { AuthContext } from '../contracts/auth.ts';
import { CloudError } from '../contracts/errors.ts';
import type { ProjectFilesService } from '../services/project-files-service.ts';

type CaptionOps = Awaited<ReturnType<typeof loadCaptionSourceOperations>>;

function requestHash(request: Record<string, unknown>): string {
  // JSON object key order may change across MCP clients; cue array order is significant.
  const json = JSON.stringify(request, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
  });
  return createHash('sha256').update(json).digest('hex');
}

export async function commitCaptionCommand(
  files: ProjectFilesService, auth: AuthContext, ops: CaptionOps, projectId: string,
  compositionPath: string, command: CaptionSourceCommand, args: Record<string, unknown>,
) {
  const requestId = String(args.requestId ?? '');
  const expectedRevision = String(args.expectedRevision ?? '');
  const expectedVersionId = String(args.expectedVersionId ?? '');
  if (!requestId || !expectedRevision || !expectedVersionId) {
    throw new CloudError('INVALID_ARGUMENT', 'Caption edits require requestId, expectedRevision and expectedVersionId.', { status: 400 });
  }
  const scope = `project:${projectId}:captions`;
  const inputHash = requestHash(args);
  const current = await files.readTextForCommand(auth, projectId, compositionPath, scope, requestId, inputHash);
  if (current.kind === 'replay') {
    return { projectId, compositionPath, ...current.commit.commandResult, revision: current.commit.revision };
  }
  let edited: ReturnType<CaptionOps['editCaptionSource']>;
  try {
    const id = typeof args.transcriptId === 'string' ? args.transcriptId : randomUUID();
    edited = ops.editCaptionSource(current.content, command, id, args);
  } catch (error) {
    throw new CloudError('INVALID_ARGUMENT', error instanceof Error ? error.message : 'Invalid caption edit', {status: 400, applied: false});
  }
  const { content, count, trackId } = edited;
  const commit = await files.commitChanges(auth, {
    projectId, expectedRevision, expectedVersionId, requestId, idempotencyScope: scope,
    commandReceipt: { inputHash, result: { trackId, count } },
    ops: [{ op: 'upsert_text', path: compositionPath, content, stampHfIds: true }],
    source: 'agent', actorKind: 'agent', summary: `Edited captions in ${compositionPath}`,
  });
  return { projectId, compositionPath, ...commit.commandResult, revision: commit.revision };
}
