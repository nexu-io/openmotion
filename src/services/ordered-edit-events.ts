import type { CommittedFilePatch, OrderedEditEvent } from '../../shared/ordered-edit-event.ts';
import type { ProjectEvent } from '../contracts/events.ts';
import type { CommitProjectFilesResult } from './project-files-service.ts';
import type { PendingTextRevision } from './project-text-edits.ts';
import { formatFileVersion } from '../studio/etag.ts';

const INLINE_PATCH_BYTES = 64 * 1024;
type Entry = { commit: CommitProjectFilesResult; patches?: CommittedFilePatch[]; indexHeadHash?: string };
type Publish = (event: ProjectEvent) => Promise<unknown>;

/** Request scoped. A concurrent writer splits our steps into separate revision ranges. */
export class OrderedEditEvents {
  private entries: Entry[] = [];
  private bytes = 0;

  private readonly workspaceId: string;
  private readonly projectId: string;

  constructor(workspaceId: string, projectId: string) {
    this.workspaceId = workspaceId;
    this.projectId = projectId;
  }

  record(commit: CommitProjectFilesResult, revisions: readonly PendingTextRevision[], indexHeadHash?: string) {
    if (commit.replayed || !commit.changedPaths.length) return;
    const patches = revisions.map(row => ({
      path: row.path, from: formatFileVersion(row.parentScope, row.parentId),
      to: commit.versionsByPath[row.path], patch: row.patch,
    }));
    if (this.bytes <= INLINE_PATCH_BYTES) this.bytes += Buffer.byteLength(JSON.stringify(patches));
    this.entries.push({ commit, indexHeadHash, patches: this.bytes <= INLINE_PATCH_BYTES ? patches : undefined });
  }

  async publish(publish: Publish) {
    for (let start = 0; start < this.entries.length;) {
      let end = start + 1;
      while (end < this.entries.length && this.entries[end].commit.previousRevision === this.entries[end - 1].commit.revision) end++;
      await this.publishRange(this.entries.slice(start, end), publish);
      start = end;
    }
  }

  private async publishRange(entries: Entry[], publish: Publish) {
    const last = entries[entries.length - 1].commit;
    const versions = new Map<string, string>();
    const compositions = new Set<string>();
    let indexHeadHash: string | undefined;
    for (const entry of entries) {
      const { commit } = entry;
      if (commit.changedPaths.includes('index.html')) indexHeadHash = entry.indexHeadHash;
      for (const path of commit.changedPaths) versions.set(path, commit.versionsByPath[path]);
      for (const path of commit.affectedCompositions) compositions.add(path);
    }
    const ordered: OrderedEditEvent = {
      fromRevision: entries[0].commit.previousRevision!,
      steps: entries.map(({commit, patches}) => ({
        id: commit.writeToken, revision: commit.revision,
        ...(patches?.length && this.bytes <= INLINE_PATCH_BYTES ? { patches } : {}),
      })),
      historySeq: last.historySeq,
    };
    const base = { workspaceId: this.workspaceId, projectId: this.projectId, revision: last.revision,
      versionId: last.versionId ?? undefined, ts: Date.now(), writeToken: last.writeToken };
    await publish({ ...base, type: 'files-changed', paths: [...versions.keys()],
      fileVersions: Object.fromEntries(versions), indexHeadHash, ordered,
      affectedCompositions: [...compositions], fileTreeChanged: entries.some(e => e.commit.fileTreeChanged),
      affectsPreview: entries.some(e => e.commit.affectsPreview) });
    // Older subscribers know only this event for refreshing an open history panel.
    await publish({ ...base, type: 'history-changed', historySeq: last.historySeq, includedInOrderedEdit: true });
  }
}
