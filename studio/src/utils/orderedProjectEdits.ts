import { MAX_ORDERED_TEXT_EDITS, type OrderedTextEditOperation, type OrderedTextEditReceipt, type OrderedTextEditResult } from '../../../shared/ordered-text-edits';
import { confirmedSource, forgetSource, rememberSource, supportsOrderedTextEdits, supportsProjectTextEdits } from './confirmedTextSources';
import { acknowledgeFileEdit } from './isolatedEditVersions';
import { reconcileFileEdit } from './rebasedFileEdit';
import { studioApiFetch } from './studioApiFetch';
import { createStudioWriteToken, markStudioWriteToken } from './studioFileVersion';
import { createStudioSaveHttpError, retryStudioSave, StudioFileConflictError, StudioSaveNetworkError, StudioSaveHttpError } from './studioSaveDiagnostics';
import { trackStudioProjectSave } from './studioSaveState';

type Output = { versions: Record<string, string>; changedPaths: string[] };
export type EditFile<Version extends string | null = string> = { path: string; before: string; after: string; version: Version };
export type DraftSource = { content: string; version: string | null };
type PreparedFile = EditFile<string | null>;
type Plan = Omit<OrderedTextEditOperation, 'id' | 'files' | 'dependencies'> & {
  edits: PreparedFile[]; label: string; dependencies?: Record<string, string | null>;
};
type Prepare = (drafts: ReadonlyMap<string, DraftSource>) => Promise<Plan>;
type Intent = { at: number; prepare: Prepare; allowReplay: boolean; resolve(value: Output): void; reject(reason: unknown): void };
type Step = { intent: Intent; edits: PreparedFile[]; payload: OrderedTextEditOperation };
type Barrier = { at: number; run(): Promise<void>; reject(reason: unknown): void };
type Queue = { project: string; waiting: (Intent | Barrier)[]; running: boolean; timer?: ReturnType<typeof setTimeout> };
const queues = new Map<string, Queue>();

export function hasOrderedProjectEdits(project: string) {
  return queues.has(project);
}

export function enqueueProjectEdit(project: string, path: string, prepare: Prepare, allowReplay = false) {
  const current = projectQueue(project);
  return trackStudioProjectSave(project, path, () => new Promise<Output>((resolve, reject) => {
    current.waiting.push({ at: Date.now(), prepare, allowReplay, resolve, reject });
    schedule(current);
  }));
}

function projectQueue(project: string): Queue {
  let queue = queues.get(project);
  if (!queue) {
    queue = { project, waiting: [], running: false };
    queues.set(project, queue);
  }
  return queue;
}

/** A guarded semantic write retains its own protocol and takes one place in the project FIFO. */
export function runOrderedProjectBarrier<T>(project: string, task: () => Promise<T>): Promise<T> {
  if (!supportsOrderedTextEdits(project)) return task();
  const queue = projectQueue(project);
  return new Promise((resolve, reject) => {
    queue.waiting.push({ at: Date.now(), run: async () => { resolve(await task()); }, reject });
    schedule(queue);
  });
}

function schedule(queue: Queue) {
  if (queue.running) return;
  const first = queue.waiting[0];
  if (!first) {
    queues.delete(queue.project);
    return;
  }
  const last = queue.waiting.at(-1)!;
  const urgent = queue.waiting.length >= MAX_ORDERED_TEXT_EDITS || queue.waiting.some(item => 'run' in item);
  const delay = Math.min(first.at + 1000, last.at + 100) - Date.now();
  if (urgent || delay <= 0) {
    clearTimeout(queue.timer);
    queue.timer = undefined;
    void flush(queue);
  } else if (!queue.timer) {
    // New input can extend the idle window, but cannot displace an overdue flush.
    queue.timer = setTimeout(() => {
      queue.timer = undefined;
      schedule(queue);
    }, delay);
  }
}

async function send(project: string, operations: OrderedTextEditOperation[]) {
  const body = JSON.stringify({ operations });
  return retryStudioSave(async () => {
    let response: Response;
    try {
      response = await studioApiFetch('/api/projects/' + encodeURIComponent(project) + '/text-edits/batch',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    } catch (cause) { throw new StudioSaveNetworkError('Could not send project edits', { cause }); }
    if (!response.ok) throw await createStudioSaveHttpError(response, 'Could not save project edits');
    try { return await response.json() as OrderedTextEditResult; }
    catch (cause) { throw new StudioSaveNetworkError('Incomplete ordered edit receipt', { cause }); }
  });
}

async function prepareSteps(queue: Queue, steps: Step[]) {
  // Input received during compilation belongs to the next delivery.
  const count = Math.min(queue.waiting.length, MAX_ORDERED_TEXT_EDITS);
  const { createTextPatch } = await import('../../../shared/create-text-patch');
  const { stampHfIdsInPlace } = await import('@hyperframes/parsers/hf-ids');
  const drafts = new Map<string, DraftSource>();
  const producers = new Map<string, string>();
  let retainedChars = 0;
  // Bound transient source copies. A single large edit always makes progress.
  for (let i = 0; i < count && retainedChars < 4 * 1024 * 1024; i++) {
    const intent = queue.waiting[0]!;
    if ('run' in intent) break;
    let plan;
    try { plan = await intent.prepare(drafts); }
    catch (error) {
      if (steps.length) break; // A dependency may become available after the prefix is confirmed.
      queue.waiting.shift();
      intent.reject(error);
      continue;
    }
    const id = createStudioWriteToken();
    const files: OrderedTextEditOperation['files'] = [];
    const dependencies: NonNullable<OrderedTextEditOperation['dependencies']> = { ...plan.dependencies };
    for (const edit of plan.edits) {
      const prior = producers.get(edit.path);
      const baseVersion = prior ? { after: prior } : edit.version;
      if (edit.before === edit.after && baseVersion !== null) {
        dependencies[edit.path] = baseVersion;
        continue;
      }
      if (/\.html?$/i.test(edit.path)) edit.after = stampHfIdsInPlace(edit.after);
      const patch = baseVersion === null || !supportsProjectTextEdits(queue.project) ? null : createTextPatch(edit.before, edit.after);
      files.push({ path: edit.path, baseVersion, ...(patch === null ? { content: edit.after } : { patch }) });
    }
    if (!files.length && steps.length) break; // Resolve a no-op against confirmed versions.
    queue.waiting.shift();
    if (!files.length) {
      intent.resolve({ versions: Object.fromEntries(plan.edits.flatMap(edit => edit.version === null ? [] : [[edit.path, edit.version]])), changedPaths: [] });
      continue;
    }
    const written = new Set(files.map(file => file.path));
    for (const edit of plan.edits) {
      if (!written.has(edit.path)) continue;
      drafts.set(edit.path, { content: edit.after, version: edit.version });
      producers.set(edit.path, id);
      retainedChars += edit.after.length;
    }
    const { edits, ...metadata } = plan;
    steps.push({ intent, edits, payload: { ...metadata, id, dependencies, files } });
  }
}

function accept(project: string, step: Step, receipt: OrderedTextEditReceipt, priorVersions: Map<string, string>) {
  const versions = { ...receipt.versions };
  const written = new Set(step.payload.files.map(file => file.path));
  for (const file of step.edits) {
    const before = priorVersions.get(file.path) ?? file.version;
    const version = versions[file.path] ?? before;
    if (version === null) continue;
    versions[file.path] = version;
    if (!written.has(file.path)) continue;
    priorVersions.set(file.path, version);
    const observed = confirmedSource(project, file.path);
    // A peer read may already be newer than the delayed acknowledgement.
    if (!observed || observed.version === before || observed.version === version) {
      rememberSource(project, file.path, { version, content: file.after });
      acknowledgeFileEdit(project, file.path, before, version);
    }
  }
  step.intent.resolve({ versions, changedPaths: receipt.changedPaths });
}

async function flush(queue: Queue) {
  queue.running = true;
  const steps: Step[] = [];
  try {
    const first = queue.waiting[0];
    if (first && 'run' in first) {
      queue.waiting.shift();
      try { await first.run(); } catch (error) { first.reject(error); }
      return;
    }
    await prepareSteps(queue, steps);
    if (!steps.length) return;
    for (const step of steps) markStudioWriteToken(step.payload.id);
    const result = await send(queue.project, steps.map(step => step.payload));
    const count = result.committed.length;
    const failed = result.failed;
    if (count > steps.length || (count < steps.length) !== Boolean(failed) ||
        failed && failed.id !== steps[count]?.payload.id ||
        result.committed.some((r, i) => r.id !== steps[i].payload.id ||
          !steps[i].payload.files.every(f => typeof r.versions[f.path] === 'string'))) {
      throw new Error('Invalid ordered edit receipt');
    }
    const priorVersions = new Map<string, string>();
    result.committed.forEach((receipt, i) => accept(queue.project, steps[i], receipt, priorVersions));
    if (!failed) return;
    const step = steps[count];
    const conflict = failed.status === 409 && (failed.code === 'VERSION_CONFLICT' || failed.code === 'VERSION_MISMATCH');
    const path = failed.path ?? step.edits[0].path;
    if (conflict) forgetSource(queue.project, path);
    const retry = conflict && step.intent.allowReplay;
    queue.waiting.unshift(...steps.slice(count + (retry ? 0 : 1)).map(s => s.intent));
    if (retry) step.intent.allowReplay = false;
    else if (conflict) {
      reconcileFileEdit(queue.project, path, failed.currentVersion);
      step.intent.reject(new StudioFileConflictError({ filePath: path, currentVersion: failed.currentVersion ?? null,
        attemptedContent: step.edits.find(f => f.path === path)?.after ?? '', currentContent: null, syncLatest: true }));
    } else step.intent.reject(new StudioSaveHttpError(failed.message, failed.status));
  } catch (error) {
    for (const step of steps) step.intent.reject(error);
    if (!steps.length) queue.waiting.splice(0).forEach(intent => intent.reject(error));
  } finally {
    queue.running = false;
    schedule(queue);
  }
}
