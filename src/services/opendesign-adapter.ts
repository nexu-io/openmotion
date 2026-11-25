import { Readable } from 'node:stream';
import {
  ProviderError,
  publicProviderFetch,
  readCappedText,
  retryRead,
  streamMedia,
  type Fetcher,
} from '../../gateway/network.ts';
import type { Modality, Model } from '../../shared/gateway.ts';
import {
  generationOptions,
  resolveGenerationParameters,
  validateGenerationOptions,
} from '../../shared/generation-options.ts';
import { featureDeferredP2 } from '../contracts/errors.ts';
import {
  GatewayError,
  OUTCOME_UNKNOWN_CODES,
  normalizeGatewayErrorMessage,
  type GatewayBillingSummary,
  type GatewayCallContext,
  type GatewaySubmitInput,
  type GatewayTaskOutput,
  type GatewayTaskPollResult,
  type LinkModelEntry,
  type PlatformModelGateway,
  type TranscriptSegment,
} from './model-gateway.ts';

const VALID_MODEL_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,179}$/;
const VALID_REMOTE_ID_REGEX = /^[a-zA-Z0-9_-]{1,180}$/;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 2_000_000;
const MODEL_CACHE_TTL_SEC = 300;
const DEFAULT_MAX_REF_IMAGE_BYTES = 20 * 1024 * 1024;

export interface ModelCatalogCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  del?(key: string): Promise<void>;
}

export function modelCatalogCacheKey(
  ctx: Pick<
    GatewayCallContext,
    'externalWorkspaceId' | 'appUserId' | 'amrWorkspaceMemberId' | 'externalUserId'
  >,
): string {
  const actorScope = ctx.appUserId || ctx.amrWorkspaceMemberId || ctx.externalUserId || 'anon';
  return `om:gateway:models:${ctx.externalWorkspaceId || 'global'}:${actorScope}`;
}

export interface OpenDesignGatewayOptions {
  apiUrl: string;
  linkUrl: string;
  /** AMR service-to-service internal token sent via `x-internal-token` (NEVER as Authorization: Bearer). */
  internalToken?: string;
  /** Legacy alias for `internalToken`; still sent via `x-internal-token`. */
  s2sApiKey?: string;
  asrUrl?: string;
  billingSyncEnabled?: boolean;
  maxRefImageBytes?: number;
  workspaceHeaderName?: string;
  userHeaderName?: string;
  /** Custom HTTP fetcher (defaults to SSRF-pinned `publicProviderFetch` for HTTPS URLs). */
  fetcher?: Fetcher;
  /** Custom streaming media fetcher for credential-free output downloads (tests/local HTTP). */
  mediaStreamer?: (url: string, init: RequestInit) => Promise<Response>;
  /** Optional Redis-backed model catalog cache. */
  cache?: ModelCatalogCache;
}

function normalizeCapabilities(row: Record<string, unknown>): Partial<Model> {
  const rawCaps = row.capabilities;
  const capabilities =
    rawCaps && typeof rawCaps === 'object' && !Array.isArray(rawCaps)
      ? (rawCaps as Record<string, unknown>)
      : undefined;
  if (!capabilities) return {};

  const max =
    typeof capabilities.max_input_images === 'number' &&
    Number.isInteger(capabilities.max_input_images) &&
    capabilities.max_input_images > 0
      ? capabilities.max_input_images
      : undefined;

  if (row.kind === 'image' && capabilities.edits === true) {
    return {
      nativeOptions: capabilities,
      supportsImageReference: true,
      maxInputImages: max ?? 1,
    };
  }
  if (row.kind === 'video' && max) {
    return { nativeOptions: capabilities, maxInputImages: max };
  }
  return {
    nativeOptions: capabilities,
    ...(row.kind === 'image' && capabilities.edits === false
      ? { supportsImageReference: false }
      : {}),
  };
}

function parseErrorBody(rawText: string): { code?: string; retryable?: boolean } {
  if (!rawText) return {};
  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const errObj =
      parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
        ? (parsed.error as Record<string, unknown>)
        : undefined;
    const rawCode =
      (typeof errObj?.code === 'string' && errObj.code) ||
      (typeof parsed.code === 'string' && parsed.code) ||
      (typeof parsed.error === 'string' && parsed.error) ||
      undefined;
    const code = rawCode && /^[a-zA-Z0-9_-]{1,100}$/.test(rawCode) ? rawCode : undefined;
    const retryable = typeof errObj?.retryable === 'boolean' ? errObj.retryable : undefined;
    return { code, retryable };
  } catch {
    return {};
  }
}

function normalizePlanTier(
  raw: unknown,
  options?: {
    hasKnownBalance?: boolean;
    subscriptionEntitlementStatus?: unknown;
  },
): {
  plan: string;
  mediaEntitlement: 'included' | 'not-included' | 'unknown';
} {
  const entitlementStatus =
    typeof options?.subscriptionEntitlementStatus === 'string'
      ? options.subscriptionEntitlementStatus.trim().toLowerCase()
      : null;
  if (entitlementStatus && entitlementStatus !== 'active') {
    return { plan: 'free', mediaEntitlement: 'not-included' };
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    // AMR `/api/internal/billing/summary/:appUserId` returns `membershipTier: null`
    // for accounts on the Free tier without an active paid subscription.
    if (options?.hasKnownBalance) {
      return { plan: 'free', mediaEntitlement: 'not-included' };
    }
    return { plan: 'unknown', mediaEntitlement: 'unknown' };
  }
  const tier = raw.trim().toLowerCase();
  if (
    ['plus', 'pro', 'max', 'team', 'enterprise'].includes(tier) ||
    tier.startsWith('team_')
  ) {
    return { plan: tier, mediaEntitlement: 'included' };
  }
  if (['free', 'go'].includes(tier)) {
    return { plan: tier, mediaEntitlement: 'not-included' };
  }
  return { plan: tier, mediaEntitlement: 'unknown' };
}

function bufferToStream(buf: Buffer): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from([buf])) as ReadableStream<Uint8Array>;
}

/**
 * Direct HTTP S2S adapter for the unified OpenDesign Model Gateway (`amr-api` + `amr-link`).
 * Uses ZERO `vela-cli` subprocess spawning and ZERO BYOK secret storage.
 */
export class OpenDesignModelGateway implements PlatformModelGateway {
  readonly providerId = 'opendesign' as const;
  readonly mode = 'opendesign' as const;

  private readonly apiUrl: string;
  private readonly linkUrl: string;
  private readonly internalToken: string;
  private readonly asrUrl?: string;
  private readonly billingSyncEnabled: boolean;
  private readonly maxRefImageBytes: number;
  private readonly workspaceHeaderName: string;
  private readonly userHeaderName: string;
  private readonly fetcher: Fetcher;
  private readonly mediaStreamer: (url: string, init: RequestInit) => Promise<Response>;
  private readonly cache?: ModelCatalogCache;
  private readonly allowHttpTargets: boolean;

  constructor(options: OpenDesignGatewayOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
    this.linkUrl = options.linkUrl.replace(/\/$/, '');
    this.internalToken = options.internalToken ?? options.s2sApiKey ?? '';
    this.asrUrl = options.asrUrl?.replace(/\/$/, '');
    this.billingSyncEnabled = options.billingSyncEnabled ?? false;
    this.maxRefImageBytes = options.maxRefImageBytes ?? DEFAULT_MAX_REF_IMAGE_BYTES;
    this.workspaceHeaderName = options.workspaceHeaderName ?? 'x-vela-workspace-id';
    this.userHeaderName = options.userHeaderName ?? 'X-OpenDesign-User-Id';
    this.allowHttpTargets = Boolean(options.fetcher) || this.apiUrl.startsWith('http://');
    this.fetcher =
      options.fetcher ??
      (this.apiUrl.startsWith('https://') ? publicProviderFetch : fetch);
    this.mediaStreamer =
      options.mediaStreamer ??
      (options.fetcher
        ? (url, init) => options.fetcher!(url, { ...init, redirect: 'follow' })
        : (url, init) => streamMedia(url, init));
    this.cache = options.cache;
  }

  /**
   * Builds AMR upstream-trust headers (`x-internal-token` + `x-workspace-*` 4-tuple).
   * CRITICAL: NEVER attach `Authorization: Bearer` — AMR's `createAuthenticateRequest`
   * prioritizes Bearer and routes it into the control-key branch instead of internal trust.
   */
  private buildHeaders(
    ctx: GatewayCallContext,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'x-internal-token': this.internalToken,
      Accept: 'application/json',
    };
    if (ctx.externalWorkspaceId) {
      headers['x-workspace-team-id'] = ctx.externalWorkspaceId;
      headers[this.workspaceHeaderName] = ctx.externalWorkspaceId;
    }
    if (ctx.amrWorkspaceMemberId) {
      headers['x-workspace-member-id'] = ctx.amrWorkspaceMemberId;
    }
    if (ctx.amrWorkspaceRole) {
      headers['x-workspace-role'] = ctx.amrWorkspaceRole;
    }
    if (ctx.amrWorkspaceLifecycleState) {
      headers['x-workspace-lifecycle-state'] = ctx.amrWorkspaceLifecycleState;
    }
    if (ctx.externalUserId) {
      headers[this.userHeaderName] = ctx.externalUserId;
    }
    return {
      ...headers,
      ...extra,
    };
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);

    const response = await this.fetcher(url, {
      ...init,
      redirect: 'error',
      signal,
    });

    const rawText = await readCappedText(response, MAX_JSON_BYTES);
    if (!response.ok) {
      const parsedErr = parseErrorBody(rawText);
      const code =
        parsedErr.code ??
        (response.status === 401
          ? 'unauthorized'
          : response.status === 403
            ? 'forbidden_api_key'
            : response.status === 429
              ? 'rate_limited'
              : response.status >= 500
                ? 'provider_error'
                : 'invalid_request');
      throw new GatewayError(code, normalizeGatewayErrorMessage(code, response.status), {
        status: response.status,
        retryable: parsedErr.retryable ?? (response.status === 429 || response.status >= 500),
      });
    }

    if (!rawText.trim()) return {};
    try {
      const parsed = JSON.parse(rawText) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Expected JSON object');
      }
      return parsed as Record<string, unknown>;
    } catch {
      throw new GatewayError('provider_error', 'OpenDesign gateway returned invalid JSON', {
        status: response.status,
      });
    }
  }

  async listMediaModels(
    ctx: GatewayCallContext,
    options: { refresh?: boolean } = {},
  ): Promise<Model[]> {
    const cacheKey = modelCatalogCacheKey(ctx);
    if (this.cache && !options.refresh) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as Model[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed;
          }
        } catch {
          // Cache corrupt; fall through to live fetch.
        }
      }
    }

    const signal = ctx.signal ?? new AbortController().signal;
    const body = await retryRead(
      () =>
        this.requestJson(`${this.apiUrl}/api/v1/media/models?include_audio=true`, {
          method: 'GET',
          headers: this.buildHeaders(ctx),
          signal,
        }),
      signal,
      3,
    );

    if (!Array.isArray(body.models)) {
      throw new GatewayError('provider_error', 'OpenDesign media catalogue format changed');
    }

    const liveModels: Model[] = [];
    const seen = new Set<string>();

    for (const raw of body.models) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      if (row.enabled === false) continue;
      if (typeof row.model !== 'string' || !VALID_MODEL_ID_REGEX.test(row.model)) continue;
      if (
        typeof row.kind !== 'string' ||
        !['image', 'video', 'audio', 'audio_speech', 'audio_music'].includes(row.kind)
      ) {
        continue;
      }

      const id = `opendesign:${row.model}`;
      if (seen.has(id)) continue;

      const modality: Modality = row.kind.startsWith('audio')
        ? 'audio'
        : (row.kind as 'image' | 'video');
      const mode =
        row.kind === 'audio_music'
          ? 'text-to-audio'
          : row.kind.startsWith('audio')
            ? 'text-to-speech'
            : `text-to-${row.kind}`;

      const model: Model = {
        id,
        provider: 'opendesign',
        modelId: row.model,
        label: typeof row.label === 'string' && row.label.trim() ? row.label.trim() : row.model,
        modality,
        mode,
        source: 'live',
        ...normalizeCapabilities(row),
      };
      const opts = generationOptions(model);
      if (opts) model.generationOptions = opts;

      seen.add(id);
      liveModels.push(model);
    }

    if (this.cache) {
      if (liveModels.length > 0) {
        await this.cache.set(cacheKey, JSON.stringify(liveModels), MODEL_CACHE_TTL_SEC);
      } else {
        await this.cache.del?.(cacheKey);
      }
    }

    return liveModels;
  }

  async listLinkModels(ctx: GatewayCallContext): Promise<LinkModelEntry[]> {
    const signal = ctx.signal ?? new AbortController().signal;
    const body = await retryRead(
      () =>
        this.requestJson(`${this.linkUrl}/v1/models`, {
          method: 'GET',
          headers: this.buildHeaders(ctx),
          signal,
        }),
      signal,
      3,
    );
    if (!Array.isArray(body.data)) return [];
    return body.data
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string',
      )
      .map((item) => ({
        id: String(item.id),
        label: typeof item.label === 'string' && item.label.trim() ? item.label : String(item.id),
        enabled: item.enabled !== false,
      }));
  }

  /**
   * 3-step OpenDesign reference upload:
   * 1. POST /api/v1/media/uploads (authenticated + Idempotency-Key)
   * 2. PUT <upload_url> (NO Authorization header, redirect: 'error')
   * 3. POST /api/v1/media/uploads/{asset_id}/commit (authenticated + Idempotency-Key)
   */
  async uploadReference(
    ctx: GatewayCallContext,
    input: { bytes: Buffer; mimeType: string; idempotencyKey: string },
  ): Promise<{ remoteAssetId: string }> {
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > this.maxRefImageBytes) {
      throw new GatewayError(
        'asset_too_large',
        `Reference upload must be between 1 and ${this.maxRefImageBytes} bytes`,
        { status: 400 },
      );
    }

    const mediaApi = `${this.apiUrl}/api/v1/media`;
    const created = await this.requestJson(`${mediaApi}/uploads`, {
      method: 'POST',
      headers: this.buildHeaders(ctx, {
        'Content-Type': 'application/json',
        'Idempotency-Key': `${input.idempotencyKey}-upload`,
      }),
      body: JSON.stringify({
        size_bytes: input.bytes.byteLength,
        mime_type: input.mimeType,
      }),
      signal: ctx.signal,
    });

    const assetId = created.asset_id;
    const uploadUrl = created.upload_url;
    if (
      typeof assetId !== 'string' ||
      !VALID_REMOTE_ID_REGEX.test(assetId) ||
      typeof uploadUrl !== 'string' ||
      (!uploadUrl.startsWith('https://') && !(this.allowHttpTargets && uploadUrl.startsWith('http://')))
    ) {
      throw new GatewayError('provider_error', 'OpenDesign did not return a valid upload target');
    }

    // Step 2: Presigned PUT MUST NOT carry Authorization header!
    const putResponse = await this.fetcher(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': input.mimeType,
        'Content-Length': String(input.bytes.byteLength),
      },
      body: new Uint8Array(input.bytes),
      redirect: 'error',
      signal: ctx.signal,
    });
    if (!putResponse.ok) {
      throw new GatewayError(
        'provider_error',
        `OpenDesign reference upload storage HTTP ${putResponse.status}; generation was not submitted`,
        { status: putResponse.status },
      );
    }

    // Step 3: Commit upload with Idempotency-Key.
    const committed = await this.requestJson(`${mediaApi}/uploads/${assetId}/commit`, {
      method: 'POST',
      headers: this.buildHeaders(ctx, {
        'Content-Type': 'application/json',
        'Idempotency-Key': `${input.idempotencyKey}-commit`,
      }),
      body: '{}',
      signal: ctx.signal,
    });
    if (committed.status !== 'ready') {
      throw new GatewayError('provider_error', 'OpenDesign did not accept the reference upload');
    }

    return { remoteAssetId: assetId };
  }

  /**
   * Submit a paid generation task with stable `Idempotency-Key`.
   * NEVER wrapped in automatic retry to prevent silent double-billing.
   */
  async submitTask(
    ctx: GatewayCallContext,
    input: GatewaySubmitInput,
  ): Promise<{ remoteTaskId: string }> {
    const modelForValidation: Model = input.model ?? {
      id: `opendesign:${input.modelId}`,
      provider: 'opendesign',
      modelId: input.modelId,
      label: input.modelId,
      modality: input.modality,
      mode: input.mode,
      source: 'live',
    };

    const hasInputs = input.inputs.length > 0;
    const resolved = resolveGenerationParameters(modelForValidation, input.parameters, hasInputs);
    validateGenerationOptions(modelForValidation, resolved, hasInputs);

    const mediaApi = `${this.apiUrl}/api/v1/media`;
    const isAudio = input.modality === 'audio';
    const isSpeech = isAudio && input.mode === 'text-to-speech';

    let endpoint: string;
    let payload: Record<string, unknown>;

    if (isAudio) {
      if (isSpeech) {
        const { voice, ...speechOptions } = resolved;
        if (typeof voice !== 'string' || !voice.trim()) {
          throw new GatewayError('invalid_request', 'Choose a provider voice ID in parameters.voice', {
            status: 400,
          });
        }
        endpoint = '/audio/speech';
        payload = {
          model: input.modelId,
          voice,
          parameters: { ...speechOptions, text: input.prompt },
        };
      } else {
        endpoint = '/audio/music';
        payload = {
          model: input.modelId,
          parameters: { ...resolved, prompt: input.prompt },
        };
      }
    } else if (input.modality === 'image') {
      const wireParams = this.buildImageWireParameters(resolved);
      const imageIds = input.inputs.map((entry) => entry.remoteAssetId);
      const isEdit =
        imageIds.length > 0 || (Array.isArray(resolved.images) && resolved.images.length > 0);
      endpoint = isEdit ? '/images/edits' : '/images/generations';
      payload = {
        ...wireParams,
        model: input.modelId,
        prompt: input.prompt,
        ...(imageIds.length > 0 ? { images: imageIds } : {}),
      };
    } else {
      endpoint = '/videos/tasks';
      const videoImages = input.inputs.map((entry) => ({
        asset_id: entry.remoteAssetId,
        role: entry.role ?? 'first_frame',
      }));
      payload = {
        ...resolved,
        model: input.modelId,
        prompt: input.prompt,
        ...(videoImages.length > 0 ? { images: videoImages } : {}),
      };
    }

    const submitted = await this.requestJson(`${mediaApi}${endpoint}`, {
      method: 'POST',
      headers: this.buildHeaders(ctx, {
        'Content-Type': 'application/json',
        'Idempotency-Key': ctx.idempotencyKey ?? input.jobId,
        ...(this.apiUrl === 'https://amr-api.open-design.ai' && {
          'X-Source-Product': 'openmotion',
          'X-OpenMotion-Job-Id': input.jobId,
        }),
      }),
      body: JSON.stringify(payload),
      signal: ctx.signal,
    });

    if (typeof submitted.task_id !== 'string' || !VALID_REMOTE_ID_REGEX.test(submitted.task_id)) {
      throw new GatewayError('provider_error', 'OpenDesign gateway did not return a valid task ID');
    }

    return { remoteTaskId: submitted.task_id };
  }

  private buildImageWireParameters(parameters: Record<string, unknown>): Record<string, unknown> {
    const hasRatio = parameters.aspect_ratio !== undefined;
    const hasResolution = parameters.resolution !== undefined;
    if (!hasRatio && !hasResolution) return parameters;
    if (parameters.size !== undefined) {
      throw new GatewayError('invalid_request', 'Cannot combine size with aspect_ratio or resolution.', {
        status: 400,
      });
    }
    if (parameters.output !== undefined) {
      throw new GatewayError('invalid_request', 'Cannot combine output with aspect_ratio or resolution.', {
        status: 400,
      });
    }
    if (
      typeof parameters.aspect_ratio !== 'string' ||
      !parameters.aspect_ratio.trim() ||
      typeof parameters.resolution !== 'string' ||
      !parameters.resolution.trim()
    ) {
      throw new GatewayError(
        'invalid_request',
        'OpenDesign Cloud image requests require both aspect_ratio and resolution together, or an explicit output object.',
        { status: 400 },
      );
    }
    const { aspect_ratio, resolution, ...rest } = parameters;
    return { ...rest, output: { aspect_ratio, resolution } };
  }

  async pollTask(
    ctx: GatewayCallContext,
    input: { modality: Modality; remoteTaskId: string },
  ): Promise<GatewayTaskPollResult> {
    if (!VALID_REMOTE_ID_REGEX.test(input.remoteTaskId)) {
      throw new GatewayError('invalid_request', 'Invalid OpenDesign task ID', { status: 400 });
    }

    const segment =
      input.modality === 'audio' ? 'audio' : input.modality === 'image' ? 'images' : 'videos';
    const taskUrl = `${this.apiUrl}/api/v1/media/${segment}/tasks/${input.remoteTaskId}`;
    const signal = ctx.signal ?? new AbortController().signal;

    const result = await retryRead(
      () =>
        this.requestJson(taskUrl, {
          method: 'GET',
          headers: this.buildHeaders(ctx),
          signal,
        }),
      signal,
      5,
    );

    const status = typeof result.status === 'string' ? result.status : '';
    if (['queued', 'pending', 'submitted'].includes(status)) {
      return { remoteTaskId: input.remoteTaskId, status: 'pending' };
    }
    if (['running', 'processing'].includes(status)) {
      return { remoteTaskId: input.remoteTaskId, status: 'running' };
    }

    if (status === 'succeeded') {
      let metadata: Record<string, unknown> | undefined;
      if (result.result && typeof result.result === 'object' && !Array.isArray(result.result)) {
        const serialized = JSON.stringify(result.result);
        if (serialized.length <= MAX_METADATA_BYTES) {
          metadata = result.result as Record<string, unknown>;
        }
      }

      if (input.modality === 'video') {
        return {
          remoteTaskId: input.remoteTaskId,
          status: 'succeeded',
          outputs: [{ contentPath: `/api/v1/media/videos/tasks/${input.remoteTaskId}/content` }],
          ...(metadata ? { metadata } : {}),
        };
      }

      const rawAssets = Array.isArray(result.assets) ? result.assets : [];
      const outputs: GatewayTaskOutput[] = [];
      for (const rawAsset of rawAssets) {
        if (!rawAsset || typeof rawAsset !== 'object') continue;
        const asset = rawAsset as Record<string, unknown>;
        if (typeof asset.url !== 'string') continue;
        outputs.push({
          remoteAssetId: typeof asset.asset_id === 'string' ? asset.asset_id : undefined,
          downloadUrl: asset.url,
          mimeType: typeof asset.mime_type === 'string' ? asset.mime_type : undefined,
          sizeBytes: typeof asset.size_bytes === 'number' ? asset.size_bytes : undefined,
        });
      }
      if (outputs.length === 0) {
        throw new GatewayError('provider_error', 'OpenDesign completed without media outputs');
      }
      return {
        remoteTaskId: input.remoteTaskId,
        status: 'succeeded',
        outputs,
        ...(metadata ? { metadata } : {}),
      };
    }

    if (status === 'failed' || status === 'cancelled' || status === 'canceled') {
      const errObj =
        result.error && typeof result.error === 'object' && !Array.isArray(result.error)
          ? (result.error as Record<string, unknown>)
          : undefined;
      const code =
        typeof errObj?.code === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(errObj.code)
          ? errObj.code
          : status === 'failed'
            ? 'provider_error'
            : 'cancelled';
      return {
        remoteTaskId: input.remoteTaskId,
        status: status === 'failed' ? 'failed' : 'cancelled',
        error: {
          code,
          message: normalizeGatewayErrorMessage(code),
          retryable: typeof errObj?.retryable === 'boolean' ? errObj.retryable : false,
          outcomeUnknown: OUTCOME_UNKNOWN_CODES.has(code),
        },
      };
    }

    throw new GatewayError('provider_error', `Unknown OpenDesign task status: ${status || '<empty>'}`);
  }

  /**
   * Streams generated media bytes from OpenDesign.
   * Video `/content` redirects are followed WITHOUT forwarding `Authorization`!
   */
  async downloadOutput(
    ctx: GatewayCallContext,
    output: GatewayTaskOutput,
  ): Promise<ReadableStream<Uint8Array>> {
    if (output.inlineBytes) {
      return bufferToStream(output.inlineBytes);
    }

    const signal = ctx.signal ?? new AbortController().signal;

    if (output.contentPath) {
      const contentUrl = `${this.apiUrl}${output.contentPath}`;
      const responseOrRedirect = await retryRead<
        { redirectUrl: string } | { stream: ReadableStream<Uint8Array> }
      >(async () => {
        const res = await this.fetcher(contentUrl, {
          method: 'GET',
          headers: this.buildHeaders(ctx),
          redirect: 'manual',
          signal,
        });
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const location = res.headers.get('location');
          if (!location) {
            throw new ProviderError('OpenDesign content redirect missing Location header', res.status);
          }
          return { redirectUrl: new URL(location, contentUrl).href };
        }
        if (!res.ok) {
          throw new ProviderError(`OpenDesign content HTTP ${res.status}`, res.status);
        }
        if (res.body) return { stream: res.body };
        return { stream: bufferToStream(Buffer.from(await res.arrayBuffer())) };
      }, signal, 5);

      if ('stream' in responseOrRedirect) {
        return responseOrRedirect.stream;
      }

      // Follow signed storage URL WITHOUT Authorization header.
      const mediaRes = await this.mediaStreamer(responseOrRedirect.redirectUrl, {
        method: 'GET',
        signal,
      });
      if (!mediaRes.ok || !mediaRes.body) {
        throw new GatewayError(
          'provider_error',
          `OpenDesign media download HTTP ${mediaRes.status}`,
          { status: mediaRes.status },
        );
      }
      return mediaRes.body;
    }

    if (output.downloadUrl) {
      const mediaRes = await this.mediaStreamer(output.downloadUrl, {
        method: 'GET',
        signal,
      });
      if (!mediaRes.ok || !mediaRes.body) {
        throw new GatewayError(
          'provider_error',
          `OpenDesign media download HTTP ${mediaRes.status}`,
          { status: mediaRes.status },
        );
      }
      return mediaRes.body;
    }

    throw new GatewayError('provider_error', 'Output contains no downloadable source');
  }

  async getBillingSummary(
    ctx: GatewayCallContext,
    _options?: { refresh?: boolean },
  ): Promise<GatewayBillingSummary> {
    if (!this.billingSyncEnabled) {
      return {
        plan: 'cloud',
        mediaEntitlement: 'unknown',
        unavailable: true,
      };
    }

    const signal = ctx.signal ?? new AbortController().signal;
    const path = ctx.appUserId
      ? `/api/internal/billing/summary/${encodeURIComponent(ctx.appUserId)}`
      : ctx.externalWorkspaceId
        ? `/api/v1/workspaces/${encodeURIComponent(ctx.externalWorkspaceId)}/billing/snapshot`
        : '/api/v1/billing/summary';
    try {
      const body = await this.requestJson(`${this.apiUrl}${path}`, {
        method: 'GET',
        headers: this.buildHeaders(ctx),
        signal,
      });
      const rawBalance =
        body.totalAvailableCreditsUsd ??
        body.balanceUsd ??
        (body.wallet && typeof body.wallet === 'object'
          ? (body.wallet as Record<string, unknown>).balanceUsd
          : undefined);
      const balanceStr =
        typeof rawBalance === 'number' || typeof rawBalance === 'string'
          ? String(rawBalance)
          : null;
      const numericBalance = balanceStr !== null ? Number(balanceStr) : NaN;
      const tier = normalizePlanTier(body.membershipTier ?? body.plan, {
        hasKnownBalance: balanceStr !== null,
        subscriptionEntitlementStatus: body.subscriptionEntitlementStatus,
      });
      return {
        plan: tier.plan,
        mediaEntitlement: tier.mediaEntitlement,
        hasBalance: Number.isFinite(numericBalance) ? numericBalance > 0 : undefined,
        balanceUsd: balanceStr,
      };
    } catch (error) {
      const errorStatus = error instanceof GatewayError ? error.status : undefined;
      return {
        plan: 'unknown',
        mediaEntitlement: 'unknown',
        unavailable: true,
        ...(errorStatus ? { errorStatus } : {}),
      };
    }
  }

  async transcribeAudio(
    ctx: GatewayCallContext,
    input: {
      audioWav: Buffer;
      modelId?: string;
      language?: string;
      parameters?: Record<string, unknown>;
    },
  ): Promise<TranscriptSegment[]> {
    if (!this.asrUrl) {
      throw featureDeferredP2('transcript.submit');
    }
    const form = new FormData();
    form.set(
      'file',
      new Blob([new Uint8Array(input.audioWav)], { type: 'audio/wav' }),
      'audio.wav',
    );
    if (input.modelId) form.set('model', input.modelId);
    if (input.language) form.set('language', input.language);
    form.set('response_format', 'verbose_json');

    const response = await this.fetcher(this.asrUrl, {
      method: 'POST',
      headers: this.buildHeaders(ctx),
      body: form,
      redirect: 'error',
      signal: ctx.signal,
    });
    if (!response.ok) {
      throw new GatewayError('provider_error', `OpenDesign ASR HTTP ${response.status}`, {
        status: response.status,
      });
    }
    const json = (await response.json()) as {
      segments?: Array<{ start?: number; end?: number; text?: string }>;
      text?: string;
    };
    if (Array.isArray(json.segments)) {
      return json.segments
        .filter((s) => typeof s.text === 'string')
        .map((s) => ({
          start: Number(s.start ?? 0),
          end: Number(s.end ?? 0),
          text: String(s.text ?? '').trim(),
        }));
    }
    return json.text ? [{ start: 0, end: 0, text: json.text.trim() }] : [];
  }
}
