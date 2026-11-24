import { z } from 'zod';
import { MAX_ORDERED_TEXT_EDITS } from '../../shared/ordered-text-edits.ts';

const version = z.string().regex(/^"(?:sha256|patch):[a-f0-9]{64}"$/);
const operationId = z.string().min(1).max(100);
const splice = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.string()])
  .transform(([offset, removed, insert]) => [offset, removed, insert] as const);

function textEditFields<V extends z.ZodType>(base: V) {
  const path = z.string();
  const files = z.array(z.union([
    z.strictObject({ path, baseVersion: base, patch: z.array(splice).max(4096) }),
    z.strictObject({ path, baseVersion: base.nullable(), content: z.string() }),
  ])).min(1).max(256);
  return {
    files,
    dependencies: z.record(z.string(), base.nullable()).optional(),
    label: z.string().trim().min(1).max(256).optional(),
    undoGroup: z.uuid().optional(),
  };
}

export const textEditSchema = z.strictObject({
  ...textEditFields(version),
  installComponent: z.string().min(1).max(200).optional(),
});

const orderedOperation = z.strictObject({
  id: operationId,
  ...textEditFields(z.union([version, z.strictObject({ after: operationId })])),
});

export const orderedTextEditSchema = z.strictObject({
  operations: z.array(orderedOperation).min(1).max(MAX_ORDERED_TEXT_EDITS),
});
