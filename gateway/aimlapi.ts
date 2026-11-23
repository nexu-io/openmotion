import { setTimeout as delay } from 'node:timers/promises';
import type { Model, Modality } from '../shared/gateway.ts';
import { registeredProvider } from '../shared/provider-registry.ts';
import { classifyModel, modelKey, validModelId } from './catalog.ts';
import { apiJson, MAX_MEDIA_BYTES, ProviderError, retryRead, type Fetcher } from './network.ts';
import type { ProviderAdapter } from './providers.ts';

const origin = registeredProvider('aimlapi')!.baseUrl;
/** Catalogue `type` decides the operation; model names never add a modality. Chat, transcription, embeddings and realtime rows are skipped. */
const operations: Record<string, { modality: Modality; mode: string }> = {
  'openai/image-generations': { modality: 'image', mode: 'text-to-image' },
  'internal/video-generations/submit': { modality: 'video', mode: 'text-to-video' },
  'internal/audio-generations/submit': { modality: 'audio', mode: 'text-to-audio' },
  'internal/text-to-speech': { modality: 'audio', mode: 'text-to-speech' },
};
const pending = ['queued', 'generating', 'waiting', 'active', 'processing', 'pending'];
const failed = ['error', 'failed', 'cancelled', 'canceled', 'timeout', 'expired'];
// Synchronous image and speech requests can take minutes on larger models; a timed-out paid POST is never resent.
const synchronous = { timeoutMs: 10 * 60_000, maxBytes: MAX_MEDIA_BYTES };

export function normalizeAimlapiModels(rows: any[]): Model[] {
  return rows.flatMap(row => {
    const operation = operations[row?.type];
    if (!operation) return [];
    const id = row.id;
    try { validModelId(id); } catch { return []; }
    const inputs = row.modalities?.input;
    // Rows that need audio or image input only (stems, transcription) cannot start from a prompt.
    if (Array.isArray(inputs) && !inputs.includes('text')) return [];
    // An explicit task in the ID (for example image-to-video) refines the mode within the catalogue's modality.
    const explicit = classifyModel(String(id));
    const mode = explicit?.modality === operation.modality && operation.mode !== 'text-to-speech' ? explicit.mode : operation.mode;
    return [{ id: modelKey('aimlapi', id), provider: 'aimlapi', modelId: id, label: String(row.info?.name ?? id).slice(0, 180),
      modality: operation.modality, mode, source: 'live' as const, description: String(row.info?.description ?? '').slice(0, 500) }];
  });
}
/** The catalogue is public; listing models never marks a key as verified. */
export async function aimlapiModels(fetcher: Fetcher): Promise<Model[]> {
  const body = await apiJson(fetcher, `${origin}/v1/models?include=modalities`);
  if (!Array.isArray(body.data)) throw new Error('AI/ML API catalogue format changed');
  return normalizeAimlapiModels(body.data);
}
function urls(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).flatMap(item => typeof item === 'string' ? [item] : typeof (item as { url?: unknown })?.url === 'string' ? [(item as { url: string }).url] : []).slice(0, 8);
}
function taskId(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,240}$/.test(value)) throw new Error('AI/ML API did not return a generation ID');
  return value;
}

export const aimlapi: ProviderAdapter = {
  async generate(job, ctx) {
    const headers = { Authorization: `Bearer ${ctx.key}`, 'Content-Type': 'application/json' };
    const parameters = { ...job.model.defaults, ...job.parameters };
    await ctx.progress('submitting');
    if (job.modality === 'image') {
      const result = await apiJson(ctx.fetcher, `${origin}/v1/images/generations`, { method: 'POST', headers, signal: ctx.signal,
        body: JSON.stringify({ ...parameters, model: job.model.modelId, prompt: job.prompt }) }, synchronous);
      if (!Array.isArray(result.data) || !result.data.length) throw new Error('AI/ML API returned no images');
      return result.data.slice(0, 8).map((image: { b64_json?: unknown; url?: unknown }) => {
        if (typeof image.b64_json === 'string' && image.b64_json) return Buffer.from(image.b64_json, 'base64');
        if (typeof image.url === 'string') return image.url;
        throw new Error('AI/ML API returned an unsupported image response');
      });
    }
    if (job.modality === 'audio' && job.model.mode === 'text-to-speech') {
      const response = await ctx.fetcher(`${origin}/v1/tts`, { method: 'POST', headers, redirect: 'error',
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(synchronous.timeoutMs)]),
        body: JSON.stringify({ ...parameters, model: job.model.modelId, text: job.prompt }) });
      // Do not forward the provider body: it may echo the request.
      if (!response.ok) throw new ProviderError(`Provider HTTP ${response.status}${response.status === 401 || response.status === 403 ? ': credentials or permissions rejected' : ''}`, response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_MEDIA_BYTES) throw new Error('Provider response exceeds 256 MB');
      // Speech models answer either with a file link in JSON or with the audio bytes themselves.
      if (!response.headers.get('content-type')?.includes('json')) return [bytes];
      let body: any;
      try { body = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Provider returned invalid JSON'); }
      const media = urls(body.audio);
      if (!media.length) throw new Error('AI/ML API returned no speech audio');
      return media;
    }
    const path = job.modality === 'video' ? '/v2/video/generations' : '/v2/generate/audio';
    let task = await apiJson(ctx.fetcher, origin + path, { method: 'POST', headers, signal: ctx.signal,
      body: JSON.stringify({ ...parameters, model: job.model.modelId, prompt: job.prompt }) });
    const id = taskId(task.id);
    await ctx.progress('submitted', id);
    for (;;) {
      if (task.status === 'completed') {
        const media = urls(job.modality === 'video' ? task.video : task.audio_file);
        if (!media.length) throw new Error('AI/ML API completed without media output');
        return media;
      }
      if (failed.includes(task.status)) throw new Error(`AI/ML API generation ${task.status}`);
      if (!pending.includes(task.status)) throw new Error('AI/ML API returned an unknown task status');
      await delay(ctx.pollMs ?? (job.modality === 'video' ? 5000 : 3000), undefined, { signal: ctx.signal });
      // Polling reads the original task only; a failed read is retried, the paid submission never is.
      task = await retryRead(() => apiJson(ctx.fetcher, `${origin}${path}?${new URLSearchParams({ generation_id: id })}`, { headers, signal: ctx.signal }), ctx.signal);
      await ctx.progress('generating');
    }
  },
};
