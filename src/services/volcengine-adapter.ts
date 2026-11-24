import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { publicProviderFetch, readCappedText, streamMedia, MAX_JSON_BYTES, type Fetcher } from '../../gateway/network.ts';
import type { Modality, Model } from '../../shared/gateway.ts';
import { generationOptions } from '../../shared/generation-options.ts';
import {
  GatewayError,
  type GatewayBillingSummary,
  type GatewayCallContext,
  type GatewaySubmitInput,
  type GatewayTaskOutput,
  type GatewayTaskPollResult,
  type PlatformModelGateway,
} from './model-gateway.ts';

/**
 * Volcengine Ark (火山方舟) backend for the single platform gateway slot (`MODEL_GATEWAY_MODE=volcengine`).
 *
 * Like the mock backend it occupies the `opendesign` provider identity, so routes, jobs and MCP discovery stay
 * unchanged. Credentials come only from the service environment (`ARK_API_KEY`); there is no workspace key form.
 *
 * - Video: async task — `POST {base}/contents/generations/tasks`, poll `GET {base}/contents/generations/tasks/{id}`.
 * - Image: synchronous — `POST {base}/images/generations`; the result is held in memory until the worker polls it.
 *   A process restart between submit and poll loses the image result (reported as outcome unknown, never resubmitted).
 * - Speech: Doubao speech synthesis 2.0 over HTTP SSE — `POST {speech}/api/v3/tts/unidirectional/sse`, single
 *   `X-Api-Key` (`VOLC_TTS_API_KEY`), resource `seed-tts-2.0`. Synchronous; audio is held like images.
 * - Sound/music: Seed Audio 1.0 — `POST {speech}/api/v3/tts/create`, synchronous, same key. Documented for sound
 *   effects and timbres; full music tracks are not a documented capability.
 */

export const DEFAULT_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
/** Seedance model IDs confirmed from the Ark console by this deployment's operator (2026-11-23). */
export const DEFAULT_ARK_VIDEO_MODELS = [
  'doubao-seedance-2-5-260628',
  'doubao-seedance-2-0-260128',
  'doubao-seedance-2-0-mini-260615',
] as const;

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,180}$/;
export const DEFAULT_VOLC_SPEECH_BASE_URL = 'https://openspeech.bytedance.com';
export const VOLC_TTS_MODEL = 'seed-tts-2.0';
export const VOLC_SOUND_MODEL = 'seed-audio-1.0';
/** Synchronous results (image URLs, speech/sound bytes) held until the worker polls. */
const SYNC_TASK_PREFIX = 'volcsync_';
const SYNC_RESULT_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SOUND_PROMPT_CHARS = 3000;
const SPEECH_SUCCESS_CODE = 20_000_000;
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

export interface VolcengineGatewayOptions {
  /** Ark key for image/video. Optional when only speech is configured. */
  apiKey?: string;
  baseUrl?: string;
  /** Doubao speech key (`X-Api-Key`) for speech and Seed Audio. */
  speechApiKey?: string;
  speechBaseUrl?: string;
  imageModels?: readonly string[];
  videoModels?: readonly string[];
  /** JSON transport; defaults to the DNS-pinned public HTTPS fetcher. */
  fetcher?: Fetcher;
  /** Credential-free media download transport. */
  mediaStreamer?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
}

type ArkError = { code?: unknown; message?: unknown };

/** Split a comma/space separated env list into validated, de-duplicated model IDs. */
export function parseArkModelList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean))].filter((value) => {
    if (!MODEL_ID_PATTERN.test(value)) throw new Error(`INVALID_CONFIG: invalid Ark model ID '${value}'`);
    return true;
  });
}

function videoModel(modelId: string): Model {
  // Seedance 2.5 accepts 4–30 s, 2.0 models 4–15 s (Ark create-task docs, checked 2026-11-24).
  const maxDuration = modelId.includes('seedance-2-5') ? 30 : 15;
  const model: Model = {
    id: `opendesign:${modelId}`,
    provider: 'opendesign',
    modelId,
    label: `Volcengine ${modelId}`,
    modality: 'video',
    mode: 'text-to-video',
    source: 'builtin',
    description: 'Volcengine Ark Seedance video generation',
    supportsImageReference: true,
    maxInputImages: 1,
    nativeOptions: {
      max_input_images: 1,
      ratios: { values: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'], default: 'adaptive' },
      resolutions: { values: ['480p', '720p', '1080p'], default: '720p' },
      durations: { values: Array.from({ length: maxDuration - 3 }, (_, i) => i + 4), default: 5 },
      audio: { values: ['false', 'true'], default: 'false' },
    },
  };
  const options = generationOptions(model);
  if (options) model.generationOptions = options;
  return model;
}

function imageModel(modelId: string): Model {
  const model: Model = {
    id: `opendesign:${modelId}`,
    provider: 'opendesign',
    modelId,
    label: `Volcengine ${modelId}`,
    modality: 'image',
    mode: 'text-to-image',
    source: 'builtin',
    description: 'Volcengine Ark Seedream image generation',
    supportsImageReference: true,
    maxInputImages: 1,
    nativeOptions: { sizes: { values: ['1K', '2K'], default: '2K' } },
  };
  const options = generationOptions(model);
  if (options) model.generationOptions = options;
  return model;
}

function speechModel(): Model {
  const model: Model = {
    id: `opendesign:${VOLC_TTS_MODEL}`,
    provider: 'opendesign',
    modelId: VOLC_TTS_MODEL,
    label: 'Volcengine Doubao Speech 2.0',
    modality: 'audio',
    mode: 'text-to-speech',
    source: 'builtin',
    description: 'Doubao speech synthesis 2.0 (seed-tts-2.0 voices only)',
  };
  const options = generationOptions(model);
  if (options) model.generationOptions = options;
  return model;
}

function soundModel(): Model {
  return {
    id: `opendesign:${VOLC_SOUND_MODEL}`,
    provider: 'opendesign',
    modelId: VOLC_SOUND_MODEL,
    label: 'Volcengine Seed Audio 1.0',
    modality: 'audio',
    mode: 'text-to-audio',
    source: 'builtin',
    description: 'Seed Audio sound effects and ambience from a text prompt (up to 120 s billed)',
  };
}

function arkErrorCode(body: unknown): string | undefined {
  const error = (body as { error?: ArkError } | null)?.error;
  return typeof error?.code === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(error.code) ? error.code : undefined;
}

/** Map Ark HTTP/application errors onto the normalized gateway taxonomy without echoing provider text. */
function gatewayErrorFor(status: number, arkCode: string | undefined, outcomeUnknown = false): GatewayError {
  const suffix = arkCode ? ` (Volcengine ${arkCode})` : '';
  if (status === 401) return new GatewayError('unauthorized', `Volcengine Ark rejected the API key${suffix}.`, { status });
  if (status === 403) return new GatewayError('forbidden_api_key', `Volcengine Ark denied access to this model${suffix}. Check that the model is activated for the account.`, { status });
  if (status === 404) return new GatewayError('invalid_request', `Volcengine Ark could not find the model or task${suffix}.`, { status });
  if (status === 429) return new GatewayError('rate_limited', `Volcengine Ark rate or quota limit reached${suffix}.`, { status, retryable: true });
  if (status === 400 || status === 422) return new GatewayError('invalid_request', `Volcengine Ark rejected the request parameters${suffix}.`, { status });
  if (outcomeUnknown) {
    return new GatewayError('request_state_unknown', `Volcengine Ark did not confirm whether this request ran${suffix}; it was not resubmitted.`, { status, outcomeUnknown: true });
  }
  return new GatewayError('provider_error', `Volcengine Ark could not complete this request${suffix}.`, { status, retryable: status >= 500 });
}

function pick<T>(value: unknown, guard: (candidate: unknown) => candidate is T): T | undefined {
  return guard(value) ? value : undefined;
}
const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function httpsUrl(raw: unknown): string | undefined {
  if (!isString(raw)) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Parameters the worker may forward; everything else stays out of the paid request body. */
const VIDEO_PARAMETERS = ['ratio', 'resolution', 'duration', 'generate_audio', 'seed', 'watermark'] as const;
const IMAGE_PARAMETERS = ['size', 'watermark', 'output_format'] as const;
const SPEECH_AUDIO_PARAMETERS = ['speech_rate', 'loudness_rate', 'emotion', 'emotion_scale'] as const;
const SOUND_AUDIO_PARAMETERS = ['speech_rate', 'loudness_rate', 'pitch_rate'] as const;
const VOICE_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/** Parse an SSE body into its `data:` JSON payloads; malformed frames are skipped. */
export function parseSseFrames(text: string): Array<{ event?: string; data: Record<string, unknown> }> {
  const frames: Array<{ event?: string; data: Record<string, unknown> }> = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    try {
      const data = JSON.parse(dataLines.join('\n'));
      if (isRecord(data)) frames.push({ ...(event ? { event } : {}), data });
    } catch {
      // Skip non-JSON keep-alive or comment frames.
    }
  }
  return frames;
}

const numericCode = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** Speech/sound errors carry a numeric application code; never forward the message text. */
function speechError(code: number | undefined, status = 400): GatewayError {
  const suffix = code !== undefined ? ` (Volcengine speech ${code})` : '';
  if (code === 45000000) return new GatewayError('forbidden_api_key', `The voice is not authorized for this speech key or does not exist${suffix}.`, { status: 403 });
  if (code === 40402003) return new GatewayError('invalid_request', `The text exceeds the Volcengine speech length limit${suffix}.`, { status: 400 });
  if (code !== undefined && code >= 50000000) return new GatewayError('provider_error', `Volcengine speech service error${suffix}.`, { status: 502 });
  return new GatewayError('invalid_request', `Volcengine speech rejected the request${suffix}.`, { status });
}

function forwardParameters(parameters: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = parameters[key];
    if (value === undefined || value === null) continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) body[key] = value;
  }
  return body;
}

type HeldResult = { outputs: GatewayTaskOutput[]; metadata?: Record<string, unknown>; createdAt: number };

export class VolcengineModelGateway implements PlatformModelGateway {
  readonly providerId = 'opendesign' as const;
  readonly mode = 'volcengine' as const;
  readonly statusIdentity = {
    label: 'Volcengine',
    reason: 'Volcengine Ark and Doubao speech backend (service-held keys)',
    verification: 'unverified',
  } as const;

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly speechApiKey?: string;
  private readonly speechBaseUrl: string;
  private readonly fetcher: Fetcher;
  private readonly mediaStreamer: (url: string, init: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly catalog: Model[];
  private readonly references = new Map<string, string>();
  private readonly heldResults = new Map<string, HeldResult>();
  private readonly idempotentSubmissions = new Map<string, Promise<{ remoteTaskId: string }>>();

  constructor(options: VolcengineGatewayOptions) {
    if (!options.apiKey && !options.speechApiKey) {
      throw new GatewayError('unauthorized', 'MODEL_GATEWAY_MODE=volcengine requires ARK_API_KEY or VOLC_TTS_API_KEY', { status: 500 });
    }
    const base = new URL(options.baseUrl ?? DEFAULT_ARK_BASE_URL);
    if (base.protocol !== 'https:') throw new Error('INVALID_CONFIG: ARK_BASE_URL must use https');
    const speechBase = new URL(options.speechBaseUrl ?? DEFAULT_VOLC_SPEECH_BASE_URL);
    if (speechBase.protocol !== 'https:') throw new Error('INVALID_CONFIG: VOLC_TTS_BASE_URL must use https');
    this.apiKey = options.apiKey;
    this.baseUrl = base.href.replace(/\/+$/, '');
    this.speechApiKey = options.speechApiKey;
    this.speechBaseUrl = speechBase.origin;
    this.fetcher = options.fetcher ?? publicProviderFetch;
    this.mediaStreamer = options.mediaStreamer ?? streamMedia;
    this.now = options.now ?? Date.now;
    const videos = options.videoModels?.length ? options.videoModels : DEFAULT_ARK_VIDEO_MODELS;
    this.catalog = [
      ...(options.apiKey ? [...(options.imageModels ?? []).map(imageModel), ...videos.map(videoModel)] : []),
      ...(options.speechApiKey ? [speechModel(), soundModel()] : []),
    ];
  }

  async listMediaModels(_ctx: GatewayCallContext): Promise<Model[]> {
    return this.catalog.map((model) => ({ ...model }));
  }

  async getBillingSummary(_ctx: GatewayCallContext): Promise<GatewayBillingSummary> {
    // Ark publishes no balance endpoint usable with an API key; entitlement is checked when generating.
    return { plan: 'volcengine-ark', mediaEntitlement: 'unknown' };
  }

  /** Ark accepts inline base64 data URLs, so references never leave this process before submission. */
  async uploadReference(
    _ctx: GatewayCallContext,
    input: { bytes: Buffer; mimeType: string; idempotencyKey: string },
  ): Promise<{ remoteAssetId: string }> {
    if (!/^image\/(png|jpeg|webp)$/.test(input.mimeType)) {
      throw new GatewayError('unsupported_media_type', 'Volcengine Ark accepts PNG, JPEG or WebP reference images.', { status: 415 });
    }
    if (input.bytes.byteLength > MAX_REFERENCE_BYTES) {
      throw new GatewayError('asset_too_large', 'The reference image exceeds the 10 MB Volcengine Ark limit.', { status: 413 });
    }
    const remoteAssetId = 'arkref_' + createHash('sha256').update(input.idempotencyKey).update(input.bytes).digest('hex').slice(0, 24);
    this.references.set(remoteAssetId, `data:${input.mimeType};base64,${input.bytes.toString('base64')}`);
    return { remoteAssetId };
  }

  async submitTask(ctx: GatewayCallContext, input: GatewaySubmitInput): Promise<{ remoteTaskId: string }> {
    const model = this.catalog.find((entry) => entry.modelId === input.modelId && entry.modality === input.modality);
    if (!model) {
      throw new GatewayError('invalid_request', `Model '${input.modelId}' is not configured for Volcengine Ark ${input.modality}.`, { status: 400 });
    }
    // Ark has no idempotency header: deduplicate replays of the same local job inside this process.
    const key = `${ctx.workspaceId}:${ctx.idempotencyKey ?? input.jobId}`;
    const existing = this.idempotentSubmissions.get(key);
    if (existing) return existing;
    const submission = input.modality === 'video'
      ? this.submitVideo(ctx, input)
      : input.modality === 'image'
        ? this.submitImage(ctx, input)
        : input.mode === 'text-to-speech'
          ? this.submitSpeech(ctx, input)
          : this.submitSound(ctx, input);
    this.idempotentSubmissions.set(key, submission);
    submission.catch(() => this.idempotentSubmissions.delete(key));
    return submission;
  }

  async pollTask(ctx: GatewayCallContext, input: { modality: Modality; remoteTaskId: string }): Promise<GatewayTaskPollResult> {
    if (input.remoteTaskId.startsWith(SYNC_TASK_PREFIX)) {
      this.pruneHeldResults();
      const result = this.heldResults.get(input.remoteTaskId);
      if (!result) {
        return {
          remoteTaskId: input.remoteTaskId,
          status: 'failed',
          error: {
            code: 'media_execution_unknown',
            message: 'The Volcengine result is no longer held by this service (it may have restarted). It was not resubmitted.',
            outcomeUnknown: true,
          },
        };
      }
      return {
        remoteTaskId: input.remoteTaskId,
        status: 'succeeded',
        outputs: result.outputs,
        ...(result.metadata ? { metadata: result.metadata } : {}),
      };
    }
    if (!TASK_ID_PATTERN.test(input.remoteTaskId)) {
      throw new GatewayError('invalid_request', 'Invalid Volcengine task ID.', { status: 400 });
    }
    const body = await this.requestJson(ctx, 'GET', `/contents/generations/tasks/${encodeURIComponent(input.remoteTaskId)}`, undefined, false);
    const status = pick(body.status, isString);
    if (status === 'queued') return { remoteTaskId: input.remoteTaskId, status: 'pending' };
    if (status === 'running') return { remoteTaskId: input.remoteTaskId, status: 'running' };
    if (status === 'succeeded') {
      const content = isRecord(body.content) ? body.content : {};
      const videoUrl = httpsUrl(content.video_url);
      if (!videoUrl) {
        return {
          remoteTaskId: input.remoteTaskId,
          status: 'failed',
          error: { code: 'provider_error', message: 'Volcengine Ark reported success without a video URL.' },
        };
      }
      const metadata: Record<string, unknown> = {};
      if (typeof body.duration === 'number') metadata.durationSec = body.duration;
      if (isString(body.resolution)) metadata.resolution = body.resolution;
      if (isString(body.ratio)) metadata.ratio = body.ratio;
      return {
        remoteTaskId: input.remoteTaskId,
        status: 'succeeded',
        outputs: [{ downloadUrl: videoUrl, mimeType: 'video/mp4' }],
        ...(Object.keys(metadata).length ? { metadata } : {}),
      };
    }
    if (status === 'cancelled') {
      return {
        remoteTaskId: input.remoteTaskId,
        status: 'cancelled',
        error: { code: 'cancelled', message: 'The Volcengine Ark task was cancelled.' },
      };
    }
    if (status === 'failed' || status === 'expired') {
      const code = arkErrorCode(body);
      return {
        remoteTaskId: input.remoteTaskId,
        status: 'failed',
        error: {
          code: 'provider_error',
          message: `Volcengine Ark task ${status}${code ? ` (${code})` : ''}.`,
          retryable: false,
        },
      };
    }
    // Unknown status values keep polling rather than guessing a terminal outcome.
    return { remoteTaskId: input.remoteTaskId, status: 'running' };
  }

  async downloadOutput(ctx: GatewayCallContext, output: GatewayTaskOutput): Promise<ReadableStream<Uint8Array>> {
    if (output.inlineBytes) return Readable.toWeb(Readable.from([output.inlineBytes])) as ReadableStream<Uint8Array>;
    const url = httpsUrl(output.downloadUrl);
    if (!url) throw new GatewayError('provider_error', 'Volcengine Ark output has no HTTPS download URL.');
    // Signed object-storage URLs: never forward the Ark Authorization header.
    const response = await this.mediaStreamer(url, { method: 'GET', signal: ctx.signal });
    if (!response.ok || !response.body) {
      throw new GatewayError('provider_error', `Volcengine output download failed (HTTP ${response.status}).`, {
        status: response.status,
        retryable: response.status >= 500,
      });
    }
    return response.body;
  }

  private async submitVideo(ctx: GatewayCallContext, input: GatewaySubmitInput): Promise<{ remoteTaskId: string }> {
    const content: Record<string, unknown>[] = [{ type: 'text', text: input.prompt }];
    for (const [index, ref] of input.inputs.entries()) {
      const url = this.references.get(ref.remoteAssetId);
      if (!url) throw new GatewayError('invalid_request', 'Reference image was not prepared for Volcengine Ark.', { status: 400 });
      const role = ref.role ?? (index === 0 ? 'first_frame' : 'reference_image');
      content.push({ type: 'image_url', image_url: { url }, role });
    }
    // Ark defaults generate_audio to true; keep silent output unless the caller asks for audio.
    const body = {
      watermark: false,
      generate_audio: false,
      ...forwardParameters(input.parameters, VIDEO_PARAMETERS),
      model: input.modelId,
      content,
    };
    const response = await this.requestJson(ctx, 'POST', '/contents/generations/tasks', body, true);
    const remoteTaskId = pick(response.id, isString);
    if (!remoteTaskId || !TASK_ID_PATTERN.test(remoteTaskId)) {
      throw new GatewayError('request_state_unknown', 'Volcengine Ark accepted the request but returned no valid task ID; it was not resubmitted.', { outcomeUnknown: true });
    }
    this.releaseReferences(input);
    return { remoteTaskId };
  }

  private async submitImage(ctx: GatewayCallContext, input: GatewaySubmitInput): Promise<{ remoteTaskId: string }> {
    const images = input.inputs.map((ref) => {
      const url = this.references.get(ref.remoteAssetId);
      if (!url) throw new GatewayError('invalid_request', 'Reference image was not prepared for Volcengine Ark.', { status: 400 });
      return url;
    });
    const body = {
      watermark: false,
      ...forwardParameters(input.parameters, IMAGE_PARAMETERS),
      model: input.modelId,
      prompt: input.prompt,
      response_format: 'url',
      ...(images.length === 1 ? { image: images[0] } : images.length > 1 ? { image: images } : {}),
    };
    const response = await this.requestJson(ctx, 'POST', '/images/generations', body, true);
    const data = Array.isArray(response.data) ? response.data : [];
    const urls = data.map((entry) => (isRecord(entry) ? httpsUrl(entry.url) : undefined)).filter(isString);
    if (!urls.length) {
      const code = arkErrorCode(response);
      throw new GatewayError('provider_error', `Volcengine Ark returned no image${code ? ` (${code})` : ''}.`);
    }
    this.releaseReferences(input);
    return { remoteTaskId: this.hold(ctx, input, urls.map((downloadUrl) => ({ downloadUrl }))) };
  }

  private async submitSpeech(ctx: GatewayCallContext, input: GatewaySubmitInput): Promise<{ remoteTaskId: string }> {
    const voice = input.parameters.voice;
    if (typeof voice !== 'string' || !VOICE_PATTERN.test(voice)) {
      throw new GatewayError('invalid_request', 'A Doubao speech 2.0 voice ID (parameters.voice) is required.', { status: 400 });
    }
    const body = {
      user: { uid: this.uid(ctx) },
      req_params: {
        text: input.prompt,
        speaker: voice,
        audio_params: { format: 'mp3', sample_rate: 24000, ...forwardParameters(input.parameters, SPEECH_AUDIO_PARAMETERS) },
      },
    };
    const text = await this.speechRequest(ctx, '/api/v3/tts/unidirectional/sse', VOLC_TTS_MODEL, input.jobId, body, 'text/event-stream');
    const chunks: Buffer[] = [];
    const sentences: Array<{ text: string }> = [];
    let finished = false;
    for (const { data } of parseSseFrames(text)) {
      const code = numericCode(data.code);
      if (code === SPEECH_SUCCESS_CODE) { finished = true; continue; }
      if (code !== undefined && code !== 0) throw speechError(code);
      if (typeof data.data === 'string' && data.data) chunks.push(Buffer.from(data.data, 'base64'));
      const sentence = isRecord(data.sentence) ? data.sentence : undefined;
      if (sentence && isString(sentence.text)) sentences.push({ text: sentence.text });
    }
    const audio = Buffer.concat(chunks);
    if (!audio.byteLength) {
      throw new GatewayError('request_state_unknown', `Volcengine speech returned no audio${finished ? '' : ' and no completion frame'}; it was not resubmitted.`, { outcomeUnknown: true });
    }
    this.releaseReferences(input);
    return {
      remoteTaskId: this.hold(ctx, input, [{ inlineBytes: audio, mimeType: 'audio/mpeg', sizeBytes: audio.byteLength }],
        sentences.length ? { sentences } : undefined),
    };
  }

  private async submitSound(ctx: GatewayCallContext, input: GatewaySubmitInput): Promise<{ remoteTaskId: string }> {
    if (input.prompt.length > MAX_SOUND_PROMPT_CHARS) {
      throw new GatewayError('invalid_request', `Seed Audio prompts are limited to ${MAX_SOUND_PROMPT_CHARS} characters.`, { status: 400 });
    }
    const body = {
      model: VOLC_SOUND_MODEL,
      text_prompt: input.prompt,
      audio_config: { format: 'mp3', ...forwardParameters(input.parameters, SOUND_AUDIO_PARAMETERS) },
    };
    const text = await this.speechRequest(ctx, '/api/v3/tts/create', undefined, input.jobId, body, 'application/json');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (!isRecord(parsed)) {
      throw new GatewayError('request_state_unknown', 'Volcengine Seed Audio returned an unreadable response; it was not resubmitted.', { outcomeUnknown: true });
    }
    const code = numericCode(parsed.code);
    if (code !== undefined && code !== 0 && code !== SPEECH_SUCCESS_CODE) throw speechError(code);
    const audio = typeof parsed.audio === 'string' && parsed.audio ? Buffer.from(parsed.audio, 'base64') : undefined;
    const url = httpsUrl(parsed.url);
    const output: GatewayTaskOutput | undefined = audio?.byteLength
      ? { inlineBytes: audio, mimeType: 'audio/mpeg', sizeBytes: audio.byteLength }
      : url ? { downloadUrl: url } : undefined;
    if (!output) {
      throw new GatewayError('request_state_unknown', 'Volcengine Seed Audio returned no audio; it was not resubmitted.', { outcomeUnknown: true });
    }
    const metadata = typeof parsed.duration === 'number' ? { durationSec: parsed.duration } : undefined;
    return { remoteTaskId: this.hold(ctx, input, [output], metadata) };
  }

  private hold(ctx: GatewayCallContext, input: GatewaySubmitInput, outputs: GatewayTaskOutput[], metadata?: Record<string, unknown>): string {
    const remoteTaskId = SYNC_TASK_PREFIX + createHash('sha256').update(`${ctx.workspaceId}:${input.jobId}`).digest('hex').slice(0, 32);
    this.heldResults.set(remoteTaskId, { outputs, ...(metadata ? { metadata } : {}), createdAt: this.now() });
    return remoteTaskId;
  }

  /** Stable, non-identifying speech user ID derived from the workspace. */
  private uid(ctx: GatewayCallContext): string {
    return createHash('sha256').update(`openmotion:${ctx.workspaceId}`).digest('hex').slice(0, 32);
  }

  private releaseReferences(input: GatewaySubmitInput): void {
    for (const ref of input.inputs) this.references.delete(ref.remoteAssetId);
  }

  private pruneHeldResults(): void {
    const cutoff = this.now() - SYNC_RESULT_TTL_MS;
    for (const [id, result] of this.heldResults) if (result.createdAt < cutoff) this.heldResults.delete(id);
  }

  /** One paid speech POST, sent exactly once; returns the raw body text. */
  private async speechRequest(
    ctx: GatewayCallContext,
    path: string,
    resourceId: string | undefined,
    jobId: string,
    body: unknown,
    accept: string,
  ): Promise<string> {
    if (!this.speechApiKey) throw new GatewayError('unauthorized', 'Volcengine speech requires VOLC_TTS_API_KEY.', { status: 500 });
    const timeout = AbortSignal.timeout(600_000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(`${this.speechBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          'X-Api-Key': this.speechApiKey,
          ...(resourceId ? { 'X-Api-Resource-Id': resourceId } : {}),
          'X-Api-Request-Id': createHash('sha256').update(`${ctx.workspaceId}:${jobId}`).digest('hex').slice(0, 32),
          'Content-Type': 'application/json',
          Accept: accept,
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal,
      });
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      throw new GatewayError('request_state_unknown', 'Volcengine speech did not confirm whether this request ran; it was not resubmitted.', { outcomeUnknown: true });
    }
    let text = '';
    try { text = await readCappedText(response, MAX_JSON_BYTES * 4); } catch { text = ''; }
    if (!response.ok) {
      let code: number | undefined;
      try { const parsed = JSON.parse(text); code = isRecord(parsed) ? numericCode(parsed.code) : undefined; } catch { code = undefined; }
      if (response.status === 401) return Promise.reject(new GatewayError('unauthorized', 'Volcengine speech rejected the API key.', { status: 401 }));
      if (response.status === 429) return Promise.reject(new GatewayError('rate_limited', 'Volcengine speech rate or concurrency limit reached.', { status: 429, retryable: true }));
      if (response.status >= 500) {
        return Promise.reject(new GatewayError('request_state_unknown', `Volcengine speech did not confirm whether this request ran (HTTP ${response.status}); it was not resubmitted.`, { status: response.status, outcomeUnknown: true }));
      }
      return Promise.reject(speechError(code, response.status));
    }
    return text;
  }

  /**
   * One JSON request. Paid POSTs are sent exactly once: transport failures and 5xx after sending are reported as
   * outcome unknown instead of being retried. Provider error text is never forwarded (it may echo input).
   */
  private async requestJson(
    ctx: GatewayCallContext,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    paid: boolean,
  ): Promise<Record<string, unknown>> {
    if (!this.apiKey) throw new GatewayError('unauthorized', 'Volcengine Ark image/video requires ARK_API_KEY.', { status: 500 });
    const timeout = AbortSignal.timeout(paid ? 600_000 : 30_000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal,
      });
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      if (paid) throw gatewayErrorFor(0, undefined, true);
      throw Object.assign(new GatewayError('provider_error', 'Volcengine Ark could not be reached.', { retryable: true }), { cause: error });
    }
    let parsed: unknown = null;
    try {
      const text = await readCappedText(response, MAX_JSON_BYTES);
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) throw gatewayErrorFor(response.status, arkErrorCode(parsed), paid && response.status >= 500);
    if (!isRecord(parsed)) {
      if (paid) throw gatewayErrorFor(response.status, undefined, true);
      throw new GatewayError('provider_error', 'Volcengine Ark returned invalid JSON.', { retryable: true });
    }
    return parsed;
  }
}
