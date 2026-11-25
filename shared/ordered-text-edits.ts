import type { TextPatch } from './text-patch.ts';

export const MAX_ORDERED_TEXT_EDITS = 128;
export const ORDERED_TEXT_EDITS_HEADER = 'X-OpenMotion-Ordered-Edits';

export type OrderedTextEditBase = string | null | { after: string };
export type OrderedTextEditFile = { path: string; baseVersion: OrderedTextEditBase } & (
  | { patch: TextPatch }
  | { content: string }
);

export interface OrderedTextEditOperation {
  id: string;
  files: OrderedTextEditFile[];
  dependencies?: Record<string, OrderedTextEditBase>;
  beatAssets?: string[];
  installComponent?: string;
  label?: string;
  undoGroup?: string;
}

export interface OrderedTextEditReceipt {
  id: string;
  versions: Record<string, string>;
  changedPaths: string[];
  versionId: string | null;
  revision: string;
  writeToken: string;
}

export interface OrderedTextEditFailure {
  id: string;
  status: number;
  code: string;
  message: string;
  path?: string;
  currentVersion?: string | null;
}

export interface OrderedTextEditResult {
  committed: OrderedTextEditReceipt[];
  failed?: OrderedTextEditFailure;
}
