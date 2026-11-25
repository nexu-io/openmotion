import { and, eq, inArray } from 'drizzle-orm';
import { validateTextPatchStructure, type TextPatch } from '../../shared/text-patch.ts';
import type { BlobScope, StoragePort } from '../contracts/storage.ts';
import { CloudError } from '../contracts/errors.ts';
import type { DbExecutor } from '../db/client.ts';
import { textBoundaryBlocks } from '../db/schema/text-boundaries.ts';
import { catalogBlobKey, workspaceBlobKey } from '../infra/storage.ts';
import { planTextRevision, readTextPatches } from '../infra/text-revisions.ts';

import { BLOCK_BYTES, MAX_TEXT_BYTES, prepareFullBaseline } from '../infra/text-snapshot-boundaries.ts';

export { prepareFullBaseline };
const invalid = (message: string) => new CloudError('INVALID_ARGUMENT', message, { status: 400, applied: false });
const splitCharacter = () => invalid('Replacement splits a UTF-8 character');

type Scope = { workspaceId: string; projectId: string };
type ValidationInput = Scope & {
  base: { blobScope: BlobScope; sha256: string; sizeBytes: number };
  patch: unknown;
  storage: Pick<StoragePort, 'getObjectBuffer'>;
};

/** Check positions in inserted text; map the remaining, ordered positions back to its parent file. */
export function mapPatchBoundariesToParent(points: readonly number[], patch: TextPatch): number[] {
  const inherited = [];
  let next = 0, shift = 0;
  for (const [start, count, insert] of patch) {
    const position = start + shift;
    while (next < points.length && points[next] < position) inherited.push(points[next++] - shift);
    const inserted = Buffer.from(insert, 'utf8');
    const end = position + inserted.length;
    while (next < points.length && points[next] <= end) {
      if ((inserted[points[next++] - position] & 0xc0) === 0x80) throw splitCharacter();
    }
    shift += inserted.length - count;
    if (next === points.length) break;
  }
  while (next < points.length) inherited.push(points[next++] - shift);
  return inherited;
}

/** Verify client byte offsets against server-owned versions without fetching the complete document on warm saves. */
export async function validateTextPatch(db: DbExecutor, input: ValidationInput): Promise<number> {
  const { workspaceId, projectId, base, patch, storage } = input;
  let newSize: number;
  try {
    newSize = validateTextPatchStructure(patch, base.sizeBytes, MAX_TEXT_BYTES);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : 'Invalid text patch');
  }
  // Endpoints were already checked when each parent splice was accepted. Only interior cuts need provenance.
  let points = [...new Set((patch as TextPatch).flatMap(([offset, removed]) => [offset, offset + removed]))]
    .filter(point => point > 0 && point < base.sizeBytes);
  let hash = base.sha256;
  let scope: 'catalog' | 'workspace' = base.blobScope === 'catalog' ? 'catalog' : 'workspace';
  if (base.blobScope === 'patch') {
    if (points.length === 0) return newSize;
    const chain = await planTextRevision(db, workspaceId, hash);
    for await (const { patch } of readTextPatches(db, workspaceId, chain.patches.reverse())) {
      points = mapPatchBoundariesToParent(points, patch);
      if (!points.length) return newSize;
    }
    hash = chain.base.sha256!;
    scope = chain.base.scope === 'catalog' ? 'catalog' : 'workspace';
  }
  // Check block 0 even for a pure append to a legacy physical source: it may never have been validated as UTF-8.
  const blockIds = points.length ? [...new Set(points.map(point => Math.floor(point / BLOCK_BYTES)))] : [0];
  const rows = await db.select({ blockIndex: textBoundaryBlocks.blockIndex, continuations: textBoundaryBlocks.continuations })
    .from(textBoundaryBlocks).where(and(eq(textBoundaryBlocks.workspaceId, workspaceId),
      eq(textBoundaryBlocks.projectId, projectId), eq(textBoundaryBlocks.snapshotSha, hash), inArray(textBoundaryBlocks.blockIndex, blockIds)));
  if (rows.length !== blockIds.length) {
    const bytes = await storage.getObjectBuffer(scope === 'catalog' ? catalogBlobKey(hash) : workspaceBlobKey(workspaceId, hash), MAX_TEXT_BYTES);
    for (const point of points) if ((bytes[point] & 0xc0) === 0x80) throw splitCharacter();
    await prepareFullBaseline(db, { workspaceId, projectId, scope, id: hash, bytes });
  } else {
    const blocks = new Map(rows.map(row => [row.blockIndex, row.continuations]));
    for (const point of points) {
      const local = point % BLOCK_BYTES;
      const bits = blocks.get(Math.floor(point / BLOCK_BYTES))!;
      if ((bits[local >>> 3] & (1 << (local & 7))) !== 0) throw splitCharacter();
    }
  }
  return newSize;
}
