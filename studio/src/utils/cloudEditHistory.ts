import type { HistoryStepGuard, OrderedTextEditReceipt } from '../../../shared/ordered-text-edits';
import type { RestoreFiles } from './gsapUndoRestore';
import type { EditFile } from './orderedProjectEdits';
import { fileEditPins, retireFileEditChain } from './isolatedEditVersions';
import { createStudioWriteToken } from './studioFileVersion';
import { confirmedSource, rememberSource } from './confirmedTextSources';

type Direction = 'undo' | 'redo';
type Cursor = { versionId: string; revision: string };
type Delta = { before: string; after: string; beforeVersion: string; afterVersion: string };
type Deltas = Record<string, Delta>;
type Edge = { id: string; intentId: string; from: Cursor; to: Cursor; files: Deltas; seq: number; undoGroup?: string };
type Projection = { edits: EditFile<string | null>[]; undoGroup?: string };
type Pending = { id: string; from: Cursor; files: RestoreFiles };
type Offer = { versionId?: string; targetVersionId?: string; targetRevision?: string };
type Navigation = { supportsGuardedSteps?: boolean; currentVersionId?: string | null; revision?: string; back: Offer | null; forward: Offer | null };

const same = (a: Cursor | null | undefined, b: Cursor) => a?.versionId === b.versionId && a.revision === b.revision;
const subscribed = new Map<string, CloudEditHistory>();
const MAX_CHARS = 4 * 1024 * 1024;

/** Only a mounted editor retains receipts. In-flight callbacks keep their original editor identity. */
export function watchCloudEditHistory(project: string, history: CloudEditHistory) {
  subscribed.set(project, history);
  return () => {
    if (subscribed.get(project) === history) subscribed.delete(project);
    history.clear();
  };
}

export function beginOrderedHistory(project: string, projection?: () => Promise<Projection>) {
  return subscribed.get(project)?.begin(projection);
}

function combine(previous: Deltas, recent: Deltas): Deltas | null {
  const files = { ...previous };
  for (const [path, file] of Object.entries(recent)) {
    const old = files[path];
    if (old && (old.afterVersion !== file.beforeVersion || old.after !== file.before)) return null;
    files[path] = old ? { ...file, before: old.before, beforeVersion: old.beforeVersion } : file;
    if (files[path].beforeVersion === file.afterVersion) delete files[path];
  }
  return files;
}

function restore(project: string, files: Deltas, direction: Direction): RestoreFiles {
  const undo = direction === 'undo';
  return Object.fromEntries(Object.entries(files).map(([path, f]) => [path, {
    previous: undo ? f.after : f.before, restored: undo ? f.before : f.after,
    versions: { previousVersion: undo ? f.afterVersion : f.beforeVersion, previous: fileEditPins(project, path, undo ? f.afterVersion : f.beforeVersion),
      restored: undo ? f.beforeVersion : f.afterVersion },
  }]));
}

function matchesProjection(pending: Pending, edge: Edge) {
  return same(pending.from, edge.from) && Object.keys(pending.files).length === Object.keys(edge.files).length &&
    Object.entries(pending.files).every(([path, file]) => edge.files[path]?.after === file.previous &&
      edge.files[path]?.before === file.restored && edge.files[path]?.beforeVersion === file.versions?.restored);
}

/** Install exact file identities only while the guarded transaction still owns presentation. */
export function confirmCloudRestore(project: string, files: RestoreFiles, paths: string[]) {
  if (paths.length !== Object.keys(files).length || !paths.every(path => {
    const versions = files[path]?.versions;
    const source = confirmedSource(project, path);
    return versions && (!source || source.version === versions.previousVersion || source.version === versions.restored);
  })) return undefined;
  for (const path of paths) {
    const file = files[path];
    retireFileEditChain(project, path);
    rememberSource(project, path, { content: file.restored, version: file.versions!.restored });
  }
  return files;
}

export class CloudEditHistory {
  private edges = new Map<string, Edge>();
  private head: Cursor | null = null;
  private back: Offer | null = null;
  private forward: Offer | null = null;
  private epoch = 0;
  private waiting = 0;
  private latestIntent?: { id: string; settled: Promise<void>; finish(): void };
  private pending: Pending | null = null;
  private tokens = new Set<string>();
  private supportsGuardedSteps = false;
  // A navigation GET started before an edit, step or notification cannot replace its cursor.
  clock = 0;

  constructor(private project: string) {}

  clear() {
    this.epoch++;
    this.clock++;
    this.edges.clear();
    this.head = null;
    this.pending = null;
    this.latestIntent?.finish();
    this.latestIntent = undefined;
  }

  offered(nav: Navigation) {
    this.supportsGuardedSteps = nav.supportsGuardedSteps === true || !!(nav.back?.targetVersionId || nav.forward?.targetVersionId);
    this.head = nav.currentVersionId && nav.revision ? { versionId: nav.currentVersionId, revision: nav.revision } : null;
    this.back = nav.back;
    this.forward = nav.forward;
  }

  owns(token?: string) { return Boolean(token && this.tokens.has(token)); }

  mark(token: string) {
    this.tokens.add(token);
    if (this.tokens.size > 256) this.tokens.delete(this.tokens.values().next().value!);
  }

  begin(projection?: () => Promise<Projection>) {
    const epoch = this.epoch;
    const from = this.head;
    const alone = ++this.waiting === 1;
    const intentId = createStudioWriteToken();
    let finish!: () => void;
    const settled = new Promise<void>(resolve => { finish = resolve; });
    this.latestIntent = { id: intentId, settled, finish };
    this.pending = null;
    let pending: Pending | null = null;
    let finished = false;
    const stage = (plan: Projection) => {
      if (finished || !this.supportsGuardedSteps || !from || !alone || this.waiting !== 1 || this.epoch !== epoch || !same(this.head, from)) return;
      if (plan.undoGroup && this.edges.get(from.versionId)?.undoGroup === plan.undoGroup) return;
      const edits = plan.edits.filter(f => f.before !== f.after);
      if (!edits.length || edits.some(f => !f.version) || edits.reduce((sum, f) => sum + f.before.length + f.after.length, 0) > MAX_CHARS) return;
      const files = Object.fromEntries(edits.map(f => [f.path, { previous: f.after, restored: f.before,
        versions: { previous: fileEditPins(this.project, f.path, f.version!), restored: f.version! } }]));
      this.pending = pending = { id: createStudioWriteToken(), from, files };
    };
    if (projection) void projection().then(stage, () => {});
    return {
      mark: (token: string) => this.mark(token),
      accept: (receipt: OrderedTextEditReceipt, files: Deltas, undoGroup?: string) => {
        if (this.epoch === epoch) this.accept(intentId, receipt, files, pending, undoGroup);
      },
      finish: (unconfirmed = false) => {
        finished = true;
        this.waiting--;
        finish();
        if (this.latestIntent?.id === intentId) this.latestIntent = undefined;
        if (this.pending === pending) this.pending = null;
        // A lost reply can hide a committed change, including a change on another path.
        if (unconfirmed && this.epoch === epoch) this.clear();
      },
    };
  }

  private accept(intentId: string, receipt: OrderedTextEditReceipt, delta: Deltas, pending: Pending | null, undoGroup?: string) {
    if (!receipt.changedPaths.length) return;
    this.clock++;
    if (!receipt.parentRevision || !receipt.parentVersionId || !receipt.versionId || !receipt.revision ||
        receipt.historySeq === undefined || receipt.coalesced === undefined) { this.clear(); return; }
    const parent = { revision: receipt.parentRevision, versionId: receipt.parentVersionId };
    this.supportsGuardedSteps = true;
    const to = { revision: receipt.revision, versionId: receipt.versionId };
    if (same(this.head, parent)) {
      this.head = to;
      this.back = { versionId: to.versionId };
      this.forward = null;
    } else if (!same(this.head, to)) {
      // A peer committed between local packets, or a later navigation already arrived.
      // The receipt still describes its own edge, but only a fresh cursor may offer it.
      this.head = null;
    }
    const previous = this.edges.get(parent.versionId);
    const partial = receipt.changedPaths.some(path => !Object.hasOwn(delta, path));
    const group = receipt.coalesced && previous?.seq === receipt.historySeq && same(previous.to, parent) ? previous : null;
    const files = partial || (receipt.coalesced && !group) ? null : group ? combine(group.files, delta) : delta;
    this.edges.delete(to.versionId);
    if (!files || !Object.keys(files).length) return;
    const edge = { from: group?.from ?? parent, to, files, seq: receipt.historySeq, id: receipt.id, intentId, undoGroup };
    if (pending && matchesProjection(pending, edge)) edge.id = pending.id;
    this.edges.set(to.versionId, edge);
    let chars = 0;
    for (const cached of [...this.edges.values()].reverse()) {
      for (const f of Object.values(cached.files)) chars += f.before.length + f.after.length;
      if (chars > MAX_CHARS) this.edges.delete(cached.to.versionId);
    }
    if (this.edges.size > 64) this.edges.delete(this.edges.keys().next().value!);
  }

  confirmed(direction: Direction) {
    if (this.waiting || !this.head) return null;
    const undo = direction === 'undo';
    const offered = undo ? this.back : this.forward;
    const edge = offered?.versionId && this.edges.get(offered.versionId);
    if (!edge || !same(this.head, undo ? edge.to : edge.from)) return null;
    const target = undo ? edge.from : edge.to;
    if (offered.targetVersionId && (offered.targetVersionId !== target.versionId || offered.targetRevision !== target.revision)) return null;
    const guard: HistoryStepGuard = { expectedRevision: this.head.revision, expectedVersionId: this.head.versionId,
      expectedTargetVersionId: target.versionId, expectedTargetRevision: target.revision };
    return { id: edge.id, intentId: edge.intentId, files: restore(this.project, edge.files, direction), guard };
  }

  pendingUndoId() { return this.supportsGuardedSteps ? this.latestIntent?.id : undefined; }

  waitingFor(id: string) { return this.latestIntent?.id === id ? this.latestIntent.settled : undefined; }

  needsIntentCursor(id: string) {
    return !this.head && !this.waiting && [...this.edges.values()].some(edge => edge.intentId === id);
  }

  predict(direction: Direction) {
    if (this.waiting && direction === 'undo' && this.pending && same(this.head, this.pending.from)) return this.pending;
    return this.confirmed(direction);
  }
}
