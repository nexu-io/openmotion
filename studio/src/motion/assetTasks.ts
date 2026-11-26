import type { GenerationJob, Modality } from '../../../shared/gateway';

export type AssetTaskMode = 'direct';
export interface AssetTask {
  key: string; id: string; mode: AssetTaskMode; title: string; updatedAt: number;
  state: GenerationJob['state']; tone: Modality;
  detail: string; jobs: GenerationJob[];
}

export const isActiveAssetTask = (task: AssetTask) => ['queued', 'running'].includes(task.state);
const taskPriority = (task: AssetTask) => isActiveAssetTask(task) ? 1 : 0;

export function hasSavedGeneration(job: GenerationJob): job is GenerationJob & { libraryAssets: NonNullable<GenerationJob['libraryAssets']> } {
  return job.state === 'completed' && !job.savePending && Boolean(job.libraryAssets?.length);
}

export function matchesGenerationQuery(job: GenerationJob, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || [job.library?.title, job.prompt, job.model.id, job.model.modelId, job.model.label]
    .some(value => value?.toLowerCase().includes(needle));
}

/** A view over persisted generation jobs, never a second execution or history store. */
export function assetTasks(jobs: GenerationJob[]): AssetTask[] {
  const tasks: AssetTask[] = [];
  for (const job of jobs) {
    if (!job.library && !job.saveToLibrary) continue;
    tasks.push({
      key: `direct:${job.id}`,
      id: job.id,
      mode: 'direct',
      title: job.prompt,
      updatedAt: job.updatedAt,
      state: job.state,
      tone: job.modality,
      detail: job.model.label,
      jobs: [job],
    });
  }
  return tasks.sort((a, b) => taskPriority(b) - taskPriority(a) || b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
}

/** A delayed poll must not erase a just-submitted task or regress its progress. */
export function mergeAssetJobs(current: GenerationJob[], incoming: GenerationJob[]): GenerationJob[] {
  const merged = new Map(current.map(job => [job.id, job]));
  for (const job of incoming) if ((merged.get(job.id)?.updatedAt ?? -1) <= job.updatedAt) merged.set(job.id, job);
  return [...merged.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export const taskStateLabel = (task: AssetTask) => task.state;
export const taskStateIcon = (task: AssetTask) => task.state === 'failed' ? 'error-warning-line'
  : task.state === 'running' || task.state === 'queued' ? 'loader-4-line'
  : task.state === 'cancelled' ? 'stop-circle-line'
  : 'checkbox-circle-line';
