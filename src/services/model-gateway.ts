import type { GatewayStatus, Modality, Model } from '../../shared/gateway.ts';
import type { AuthContext } from '../contracts/auth.ts';
import type { WorkspaceDefaultModels } from '../db/schema/auth.ts';
import type { AppConfig } from '../infra/config.ts';
import { MockModelGateway, type MockModelGatewayOptions } from './mock-model-adapter.ts';
import { OpenDesignModelGateway, type OpenDesignGatewayOptions } from './opendesign-adapter.ts';
import { VolcengineModelGateway, parseArkModelList, type VolcengineGatewayOptions } from './volcengine-adapter.ts';

export interface GatewayCallContext {
  readonly workspaceId: string;
  readonly externalWorkspaceId?: string | null;
  readonly externalUserId?: string | null;
  readonly appUserId?: string | null;
  readonly amrWorkspaceMemberId?: string | null;
  readonly amrWorkspaceRole?: 'owner' | 'admin' | 'member' | null;
  readonly amrWorkspaceLifecycleState?: string | null;
  readonly signal?: AbortSignal;
  readonly idempotencyKey?: string;
}

export function gatewayCallContextFromAuth(
  auth: Pick<
    AuthContext,
    | 'workspaceId'
    | 'externalWorkspaceId'
    | 'authUserId'
    | 'appUserId'
    | 'amrWorkspaceMemberId'
    | 'amrWorkspaceRole'
    | 'amrWorkspaceLifecycleState'
  >,
  extra: Pick<GatewayCallContext, 'signal' | 'idempotencyKey'> = {},
): GatewayCallContext {
  return {
    workspaceId: auth.workspaceId,
    externalWorkspaceId: auth.externalWorkspaceId,
    externalUserId: auth.authUserId ?? null,
    appUserId: auth.appUserId ?? null,
    amrWorkspaceMemberId: auth.amrWorkspaceMemberId ?? null,
    amrWorkspaceRole: auth.amrWorkspaceRole ?? null,
    amrWorkspaceLifecycleState: auth.amrWorkspaceLifecycleState ?? null,
    ...extra,
  };
}

export interface GatewayUploadedInput {
  readonly remoteAssetId: string;
  readonly role?: 'first_frame' | 'last_frame' | 'reference';
}

export interface GatewaySubmitInput {
  readonly jobId: string;
  readonly modality: Modality;
  readonly mode: 'text-to-image' | 'text-to-video' | 'text-to-audio' | 'text-to-speech';
  readonly modelId: string; // Unprefixed OpenDesign model ID, e.g. 'wan-2.7'
  readonly prompt: string;
  readonly parameters: Record<string, unknown>;
  readonly inputs: readonly GatewayUploadedInput[];
  readonly model?: Model;
}

export interface GatewayTaskOutput {
  readonly remoteAssetId?: string;
  readonly downloadUrl?: string;
  readonly contentPath?: string;
  readonly inlineBytes?: Buffer;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
}

export interface GatewayTaskError {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly outcomeUnknown?: boolean;
}

export interface GatewayTaskPollResult {
  readonly remoteTaskId: string;
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly outputs?: readonly GatewayTaskOutput[];
  readonly metadata?: Record<string, unknown>;
  readonly error?: GatewayTaskError;
}

export interface GatewayBillingSummary {
  readonly plan: string;
  readonly mediaEntitlement: 'included' | 'not-included' | 'unknown';
  readonly hasBalance?: boolean;
  readonly balanceUsd?: string | null;
  readonly unavailable?: boolean;
}

export interface LinkModelEntry {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
}

export interface TranscriptSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface PlatformModelGateway {
  readonly providerId: 'opendesign';
  readonly mode: 'opendesign' | 'mock' | 'volcengine';
  /** Overrides the provider label/reason/verification shown by status for non-OpenDesign backends. */
  readonly statusIdentity?: GatewayStatusIdentity;
  listMediaModels(ctx: GatewayCallContext, options?: { refresh?: boolean }): Promise<Model[]>;
  listLinkModels?(ctx: GatewayCallContext): Promise<LinkModelEntry[]>;
  uploadReference(
    ctx: GatewayCallContext,
    input: { bytes: Buffer; mimeType: string; idempotencyKey: string },
  ): Promise<{ remoteAssetId: string }>;
  submitTask(ctx: GatewayCallContext, input: GatewaySubmitInput): Promise<{ remoteTaskId: string }>;
  pollTask(
    ctx: GatewayCallContext,
    input: { modality: Modality; remoteTaskId: string },
  ): Promise<GatewayTaskPollResult>;
  downloadOutput(
    ctx: GatewayCallContext,
    output: GatewayTaskOutput,
  ): Promise<ReadableStream<Uint8Array>>;
  getBillingSummary?(ctx: GatewayCallContext): Promise<GatewayBillingSummary>;
  transcribeAudio?(
    ctx: GatewayCallContext,
    input: {
      audioWav: Buffer;
      modelId?: string;
      language?: string;
      parameters?: Record<string, unknown>;
    },
  ): Promise<TranscriptSegment[]>;
}

// ---------------------------------------------------------------------------
// Normalized Gateway Error Taxonomy (Aligned with OpenDesign Media API)
// ---------------------------------------------------------------------------

export const GATEWAY_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  unauthorized:
    'OpenDesign platform credentials were rejected. Contact your workspace administrator.',
  forbidden_api_key:
    'The OpenDesign platform API key is suspended or forbidden. Contact support@open-design.ai.',
  tier_model_not_entitled:
    'Your OpenDesign plan does not include this model. Choose another model or upgrade your plan.',
  tier_request_kind_not_entitled:
    'Your OpenDesign plan does not include this model. Choose another model or upgrade your plan.',
  model_access_denied:
    'Your OpenDesign plan does not include this model. Choose another model or upgrade your plan.',
  insufficient_balance:
    'Your OpenDesign balance is too low for this request. Top up in OpenDesign Console, then try again.',
  tier_limit_exceeded:
    'OpenDesign media rate or concurrency limit reached. Wait for running tasks to finish, then try again.',
  rate_limited:
    'OpenDesign media rate or concurrency limit reached. Wait for running tasks to finish, then try again.',
  invalid_request:
    'OpenDesign rejected this request for the selected model. Choose another model or adjust parameters.',
  asset_too_large:
    'The reference image exceeds the OpenDesign upload size limit.',
  unsupported_media_type:
    'OpenDesign does not accept this reference media format.',
  request_state_unknown:
    'OpenDesign could not confirm whether this request ran, so it was not resubmitted. Inspect the original task before retrying.',
  media_execution_unknown:
    'OpenDesign could not confirm whether this request ran, so it was not resubmitted. Inspect the original task before retrying.',
  audio_outcome_unknown:
    'OpenDesign could not confirm the audio task outcome, so it was not resubmitted. Inspect the original task before retrying.',
  provider_error:
    'The model provider could not complete this request. Try again later or choose another model.',
  asr_provider_unconfigured:
    'Cloud ASR transcription is not configured (OPENDESIGN_ASR_URL is unset). Manual captions and SRT/VTT import remain available.',
};

export const OUTCOME_UNKNOWN_CODES: ReadonlySet<string> = new Set([
  'request_state_unknown',
  'media_execution_unknown',
  'audio_outcome_unknown',
]);

export class GatewayError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;

  constructor(
    code: string,
    message?: string,
    options: { status?: number; retryable?: boolean; outcomeUnknown?: boolean } = {},
  ) {
    super(message ?? GATEWAY_ERROR_MESSAGES[code] ?? 'OpenDesign model gateway request failed');
    this.name = 'GatewayError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.outcomeUnknown = options.outcomeUnknown ?? OUTCOME_UNKNOWN_CODES.has(code);
  }
}

export function normalizeGatewayErrorMessage(code?: string, status?: number): string {
  if (code && Object.hasOwn(GATEWAY_ERROR_MESSAGES, code)) {
    return GATEWAY_ERROR_MESSAGES[code];
  }
  if (status === 401) return GATEWAY_ERROR_MESSAGES.unauthorized;
  if (status === 403) return GATEWAY_ERROR_MESSAGES.forbidden_api_key;
  if (status === 429) return GATEWAY_ERROR_MESSAGES.rate_limited;
  return GATEWAY_ERROR_MESSAGES.provider_error;
}

// ---------------------------------------------------------------------------
// Gateway Factory & Unified Single-Provider Status Builder
// ---------------------------------------------------------------------------

export interface CreateGatewayOptions {
  opendesign?: Partial<OpenDesignGatewayOptions>;
  mock?: MockModelGatewayOptions;
  volcengine?: Partial<VolcengineGatewayOptions>;
}

export function createPlatformModelGateway(
  config: Pick<
    AppConfig,
    | 'MODEL_GATEWAY_MODE'
    | 'OPENDESIGN_API_URL'
    | 'OPENDESIGN_LINK_URL'
    | 'OPENDESIGN_S2S_API_KEY'
    | 'OPENDESIGN_ASR_URL'
    | 'OPENDESIGN_BILLING_SYNC_ENABLED'
  > &
    Partial<Pick<AppConfig, 'OPENDESIGN_INTERNAL_API_TOKEN' | 'ARK_API_KEY' | 'ARK_BASE_URL' | 'ARK_IMAGE_MODELS' | 'ARK_VIDEO_MODELS' | 'VOLC_TTS_API_KEY' | 'VOLC_TTS_BASE_URL'>>,
  options: CreateGatewayOptions = {},
): PlatformModelGateway {
  if (config.MODEL_GATEWAY_MODE === 'mock') {
    return new MockModelGateway(options.mock);
  }
  if (config.MODEL_GATEWAY_MODE === 'volcengine') {
    return new VolcengineModelGateway({
      apiKey: config.ARK_API_KEY,
      baseUrl: config.ARK_BASE_URL,
      speechApiKey: config.VOLC_TTS_API_KEY,
      speechBaseUrl: config.VOLC_TTS_BASE_URL,
      imageModels: parseArkModelList(config.ARK_IMAGE_MODELS),
      videoModels: parseArkModelList(config.ARK_VIDEO_MODELS),
      ...options.volcengine,
    });
  }
  const internalToken = config.OPENDESIGN_INTERNAL_API_TOKEN ?? config.OPENDESIGN_S2S_API_KEY;
  if (!internalToken) {
    throw new GatewayError(
      'unauthorized',
      'MODEL_GATEWAY_MODE=opendesign requires OPENDESIGN_INTERNAL_API_TOKEN (or OPENDESIGN_S2S_API_KEY)',
      { status: 500 },
    );
  }
  return new OpenDesignModelGateway({
    apiUrl: config.OPENDESIGN_API_URL,
    linkUrl: config.OPENDESIGN_LINK_URL,
    internalToken,
    s2sApiKey: internalToken,
    asrUrl: config.OPENDESIGN_ASR_URL,
    billingSyncEnabled: config.OPENDESIGN_BILLING_SYNC_ENABLED,
    ...options.opendesign,
  });
}

export interface GatewayStatusIdentity {
  readonly label: string;
  readonly reason: string;
  readonly verification: 'unverified' | 'verified' | 'rejected';
}

export function buildGatewayStatus(
  models: readonly Model[],
  defaultModels: WorkspaceDefaultModels,
  billing?: GatewayBillingSummary | null,
  identity?: GatewayStatusIdentity,
): GatewayStatus {
  const modalities: readonly Modality[] = ['image', 'video', 'audio'];
  const capabilities = modalities.map((modality) => {
    const matching = models.filter((model) => model.modality === modality);
    const preferred = defaultModels[modality];
    const selectedModelId =
      preferred && matching.some((m) => m.id === preferred || m.modelId === preferred)
        ? preferred
        : matching[0]?.id;
    return {
      modality,
      available: matching.length > 0,
      modelIds: matching.map((m) => m.id),
      ...(selectedModelId ? { selectedModelId } : {}),
    };
  });

  const routes: Partial<Record<Modality, string>> = {};
  for (const cap of capabilities) {
    if (cap.selectedModelId) routes[cap.modality] = cap.selectedModelId;
  }

  return {
    providers: [
      {
        id: 'opendesign',
        label: identity?.label ?? 'OpenDesign',
        enabled: true,
        configured: true,
        available: models.length > 0,
        credentialSource: 'environment',
        verification: identity?.verification ?? 'verified',
        reason: identity?.reason ?? 'Unified OpenDesign platform gateway',
        ...(billing
          ? {
              mediaEntitlement: billing.mediaEntitlement,
              plan: billing.plan,
              ...(billing.hasBalance !== undefined ? { hasBalance: billing.hasBalance } : {}),
            }
          : { mediaEntitlement: 'unknown' as const }),
      },
    ],
    agents: [],
    routes,
    capabilities,
  };
}
