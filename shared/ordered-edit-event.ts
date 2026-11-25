import type { TextPatch } from './text-patch.ts';

/** Only byte patches validated for the exact parent revision may travel inline. */
export interface CommittedFilePatch {
  path: string;
  from: string;
  to: string;
  patch: TextPatch;
}

export interface OrderedEditEvent {
  fromRevision: string;
  steps: { id: string; revision: string; patches?: CommittedFilePatch[] }[];
  historySeq: number;
}
