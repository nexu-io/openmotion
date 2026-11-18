import { registeredProvider } from '../shared/provider-registry.ts';
import type { ProviderAdapter } from './providers.ts';
import { apiJson, ProviderError, publicProviderFetch, MAX_MEDIA_BYTES } from './network.ts';

export const fishAudio: ProviderAdapter = {
  async generate(job, ctx) {
    const { voice, speed, prosody = {}, ...parameters } = { ...job.model.defaults, ...job.parameters };
    if (job.modality !== 'audio' || job.model.mode !== 'text-to-speech' || typeof voice !== 'string' || !voice.trim()) throw new Error('Choose a speech voice');
    if (!prosody || typeof prosody !== 'object' || Array.isArray(prosody)) throw new Error('Invalid Fish Audio prosody');
    await ctx.progress('submitting');
    const response = await (ctx.fetcher === fetch ? publicProviderFetch : ctx.fetcher)('https://api.fish.audio/v1/tts', {
      method: 'POST', headers: { Authorization: `Bearer ${ctx.key}`, 'Content-Type': 'application/json', model: job.model.modelId },
      body: JSON.stringify({ ...parameters, text: job.prompt, reference_id: voice, format: 'mp3', prosody: { ...prosody, speed: speed ?? (prosody as Record<string, unknown>).speed ?? 1 } }), signal: ctx.signal, redirect: 'error',
    });
    if (!response.ok) throw new ProviderError(`Fish Audio HTTP ${response.status}`, response.status);
    if (response.headers.get('content-type')?.includes('json')) throw new Error('Fish Audio returned an error instead of speech');
    return [Buffer.from(await response.arrayBuffer())];
  },
};
export const miniMaxSpeech: ProviderAdapter = {
  async generate(job, ctx) {
    const { voice, speed, voice_setting = {}, audio_setting = {}, ...parameters } = { ...job.model.defaults, ...job.parameters };
    if (job.modality !== 'audio' || job.model.mode !== 'text-to-speech' || typeof voice !== 'string' || !voice.trim()) throw new Error('Choose a speech voice');
    if (!voice_setting || typeof voice_setting !== 'object' || Array.isArray(voice_setting) || !audio_setting || typeof audio_setting !== 'object' || Array.isArray(audio_setting)) throw new Error('Invalid MiniMax speech settings');
    if ((voice_setting as Record<string, unknown>).voice_id !== undefined && (voice_setting as Record<string, unknown>).voice_id !== voice) throw new Error('Conflicting MiniMax voice ID');
    if (job.prompt.length > 10000) throw new Error('MiniMax speech accepts at most 10000 characters');
    await ctx.progress('submitting');
    // Synchronous speech can outlast catalogue requests and returns hex audio inside JSON.
    const fetcher = ctx.fetcher === fetch ? (url: Parameters<typeof fetch>[0], init?: RequestInit) => publicProviderFetch(url, init, 15 * 60_000) : ctx.fetcher;
    const result = await apiJson(fetcher, `${registeredProvider(job.model.provider)!.baseUrl}/v1/t2a_v2`, {
      method: 'POST', headers: { Authorization: `Bearer ${ctx.key}`, 'Content-Type': 'application/json' }, signal: ctx.signal,
      body: JSON.stringify({ ...parameters, model: job.model.modelId, text: job.prompt, stream: false, output_format: 'hex',
        voice_setting: { ...voice_setting, voice_id: voice, speed: speed ?? (voice_setting as Record<string, unknown>).speed ?? 1 }, audio_setting: { format: 'mp3', ...audio_setting } }),
    }, { timeoutMs: 15 * 60_000, maxBytes: MAX_MEDIA_BYTES });
    if (result.base_resp?.status_code !== 0) throw new Error(`MiniMax speech rejected the request (${Number(result.base_resp?.status_code) || 'unknown'})`);
    const audio = result.data?.audio;
    if (typeof audio !== 'string' || !audio.length || audio.length % 2 || !/^[a-f0-9]+$/i.test(audio)) throw new Error('MiniMax returned no valid speech audio');
    return [Buffer.from(audio, 'hex')];
  },
};
