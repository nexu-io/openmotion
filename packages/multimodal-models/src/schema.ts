/**
 * Canonical TypeScript schema for @openmotion/multimodal-models.
 *
 * Unifies:
 * - Registry-level metadata & modalities (models.dev style)
 * - Closed-vocabulary standard parameter taxonomy across Image, Video, Audio/TTS/Music (LobeHub model-bank + OpenMotion generation-options style)
 * - Exact provider-native OpenAPI 3.0 parameter schemas (fal.ai, Atlas Cloud, Replicate Cog, ComfyUI partner nodes)
 */

export const REGISTRY_SCHEMA_VERSION = '1.0.0' as const;

export const MULTIMODAL_MODALITIES = [
  'image',
  'video',
  'audio',
  '3d',
] as const;
export type MultimodalModality = (typeof MULTIMODAL_MODALITIES)[number];

export const IO_MODALITIES = [
  'text',
  'image',
  'video',
  'audio',
  '3d',
  'pdf',
] as const;
export type IoModality = (typeof IO_MODALITIES)[number];

export const MULTIMODAL_TASKS = [
  // Image
  'text-to-image',
  'image-to-image',
  'image-edit',
  'inpainting',
  'outpainting',
  'upscale',
  'remove-background',
  'relight',
  'layerize',
  // Video
  'text-to-video',
  'image-to-video',
  'first-last-frame-to-video',
  'reference-to-video',
  'video-to-video',
  'video-edit',
  'video-extend',
  'lip-sync',
  // Audio / Speech / Music / SFX
  'text-to-speech',
  'speech-to-text',
  'voice-clone',
  'voice-changer',
  'text-to-music',
  'text-to-sfx',
  'audio-to-audio',
  'stem-separation',
  // 3D
  'text-to-3d',
  'image-to-3d',
] as const;
export type MultimodalTask = (typeof MULTIMODAL_TASKS)[number];

export const PARAMETER_VALUE_TYPES = [
  'string',
  'integer',
  'number',
  'boolean',
  'array',
  'object',
  'enum',
] as const;
export type ParameterValueType = (typeof PARAMETER_VALUE_TYPES)[number];

/**
 * Closed-vocabulary canonical parameter keys shared across Image, Video, Audio, Speech, Music, and 3D models.
 * Provider-native wire keys (e.g. `ratio`, `aspect_ratio`, `image_size`, `generate_audio`, `end_image_url`)
 * map onto these keys so consumers can query, compare, and render controls consistently across providers.
 */
export const STANDARD_PARAMETER_KEYS = [
  // Common text / guidance
  'prompt',
  'negativePrompt',
  'systemPrompt',
  'promptExtend',
  'thinkingLevel',
  'reasoningEffort',
  'webSearch',
  'seed',
  'count',
  'outputFormat',
  'outputCompression',
  'safetyChecker',
  'safetyTolerance',
  'moderation',
  'watermark',
  'syncMode',
  // Geometry & resolution (image / video)
  'aspectRatio',
  'resolution',
  'size',
  'width',
  'height',
  'quality',
  'background',
  'style',
  'renderingSpeed',
  'colorPalette',
  // Diffusion / sampling
  'steps',
  'cfg',
  'strength',
  'sampler',
  'scheduler',
  'acceleration',
  // Reference & multimodal inputs
  'inputImage',
  'referenceImages',
  'endImage',
  'middleImages',
  'maskImage',
  'inputVideo',
  'referenceVideos',
  'inputAudio',
  'referenceAudios',
  'inputFidelity',
  // Video-specific controls
  'duration',
  'fps',
  'numFrames',
  'generateAudio',
  'cameraFixed',
  'cameraControl',
  'bitrateMode',
  'codec',
  'hdr',
  'returnLastFrame',
  'multiPrompt',
  'draftMode',
  // Animated image / layer controls
  'frameCount',
  'frameDurationMs',
  'maxLayers',
  // Audio / Speech / Music / SFX controls
  'voice',
  'language',
  'speed',
  'pitch',
  'volume',
  'stability',
  'similarityBoost',
  'emotion',
  'sampleRate',
  'timestamps',
  'instrumental',
  'lyrics',
  'musicStyle',
  'vocalGender',
  'loop',
] as const;
export type StandardParameterKey = (typeof STANDARD_PARAMETER_KEYS)[number];

export type ParameterPrimitive = string | number | boolean | null;

export const PARAMETER_TIERS = [
  'primary',
  'advanced',
] as const;
export type ParameterTier = (typeof PARAMETER_TIERS)[number];

export interface ParameterRequirement {
  /** Sibling wire parameter name and required value(s) when this choice or field is used. */
  field: string;
  values: readonly (string | number | boolean)[];
}

export interface ParameterChoiceOption {
  value: string | number | boolean;
  label?: string;
  requires?: readonly ParameterRequirement[];
}

export interface ParameterFieldSchema {
  /** Provider-native wire key (e.g. `aspect_ratio`, `ratio`, `image_size`, `generate_audio`). */
  key: string;
  /** Canonical cross-provider parameter key when mappable. */
  standardKey?: StandardParameterKey;
  /** Display tier (`primary` quick controls vs collapsible `advanced` parameters). */
  tier?: ParameterTier;
  /** Human-readable display label (e.g. `Aspect Ratio`). */
  label: string;
  /** Normalized data type. */
  type: ParameterValueType;
  /** Whether the provider marks this field required. */
  required: boolean;
  /** Default value declared by provider schema or verified adapter. */
  default?: ParameterPrimitive | readonly unknown[] | Record<string, unknown>;
  /** Enumerated allowed values when constrained. */
  enum?: readonly (string | number | boolean)[];
  /** Rich choice metadata with optional labels or cross-field requirements. */
  choices?: readonly ParameterChoiceOption[];
  /** Numeric bounds. */
  min?: number;
  max?: number;
  step?: number;
  /** Array/string bounds. */
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  /** Array element type when `type === 'array'`. */
  itemType?: ParameterValueType;
  /** Explicit UI display ordering (from `x-fal-order-properties`, Replicate `x-order`, or curated order). */
  uiOrder?: number;
  /** Whether unknown custom values are accepted beyond suggested `enum`/`choices`. */
  allowCustom?: boolean;
  /** Provider description text (trimmed). */
  description?: string;
}

export interface ModelPricing {
  currency: 'USD';
  /** Unit of billing (e.g. `per_image`, `per_second`, `per_video`, `per_megapixel`, `per_1k_chars`, `per_request`). */
  unit: string;
  /** Effective current price in USD for one unit. */
  price?: number;
  /** List/origin price before provider discount if available. */
  originPrice?: number;
  /** Additional human-readable pricing note (e.g. resolution/audio multipliers). */
  notes?: string;
}

export interface DurationCapability {
  min?: number;
  max?: number;
  default?: number;
  values?: readonly number[];
  supportsAuto?: boolean;
}

export interface ModelCapabilities {
  inputModalities: readonly IoModality[];
  outputModalities: readonly IoModality[];
  tasks: readonly MultimodalTask[];
  maxReferenceImages?: number;
  maxReferenceVideos?: number;
  maxReferenceAudios?: number;
  supportsImageInput?: boolean;
  supportsFirstLastFrame?: boolean;
  supportsMask?: boolean;
  supportsNativeAudio?: boolean;
  nativeAudioAlwaysOn?: boolean;
  supportsTransparentBackground?: boolean;
  supportsLayerDecomposition?: boolean;
  supportsPromptExpansion?: boolean;
  supportsSeed?: boolean;
  supportsMultiPrompt?: boolean;
  supportsCameraControl?: boolean;
  supportsStreaming?: boolean;
  aspectRatios?: readonly string[];
  resolutions?: readonly string[];
  sizes?: readonly string[];
  outputFormats?: readonly string[];
  qualities?: readonly string[];
  duration?: DurationCapability;
  /** Extra model-specific flags/tags (e.g. `svg`, `gif`, `4k`, `hdr`, `web-search`). */
  features?: readonly string[];
}

export type SourceKind =
  | 'curated'
  | 'fal'
  | 'atlascloud'
  | 'models-dev'
  | 'openrouter'
  | 'replicate';

export type ProviderProtocol =
  | 'fal-queue'
  | 'atlascloud'
  | 'opendesign'
  | 'openai'
  | 'google-genai'
  | 'bytedance-ark'
  | 'kling'
  | 'alibaba-dashscope'
  | 'bfl'
  | 'ideogram'
  | 'recraft'
  | 'elevenlabs'
  | 'suno'
  | 'replicate'
  | 'openrouter'
  | 'openai-compatible'
  | 'custom';

export interface ProviderInfo {
  id: string;
  name: string;
  website?: string;
  docsUrl?: string;
  catalogUrl?: string;
  protocol: ProviderProtocol;
  source: SourceKind;
  authEnv?: string;
  supportsLiveSchema: boolean;
}

export interface ModelEndpointEntry {
  /** Globally unique key `<provider>:<endpointId>` (e.g. `fal:bytedance/seedance-2.5/us/text-to-video`). */
  id: string;
  /** Canonical family/model slug this endpoint maps to (e.g. `bytedance/seedance-2.5`). */
  canonicalId: string;
  /** Model family grouping (e.g. `seedance`, `seedream`, `gpt-image`, `kling`, `veo`, `wan`, `flux`, `nano-banana`, `elevenlabs`). */
  family: string;
  /** Original creator / research lab (e.g. `ByteDance`, `OpenAI`, `Google`, `Kuaishou`, `Alibaba`, `Black Forest Labs`). */
  creator: string;
  /** Serving provider ID (e.g. `fal`, `atlascloud`, `opendesign`, `openai`, `google`, `bytedance`). */
  provider: string;
  /** Provider-specific model or endpoint ID. */
  endpointId: string;
  /** Display name. */
  displayName: string;
  /** Primary output modality. */
  modality: MultimodalModality;
  /** Primary task (e.g. `text-to-video`, `image-edit`). */
  primaryTask: MultimodalTask;
  /** All supported tasks on this endpoint. */
  tasks: readonly MultimodalTask[];
  /** Short model description. */
  description?: string;
  /** Data source that populated this entry. */
  source: SourceKind;
  /** Direct OpenAPI schema or documentation URL when known. */
  schemaUrl?: string;
  docsUrl?: string;
  /** Whether full parameter-level schema has been verified/synced (vs metadata-only listing). */
  schemaQuality: 'openapi-live' | 'verified-curated' | 'catalog-metadata';
  status: 'active' | 'preview' | 'deprecated';
  pricing?: ModelPricing;
  capabilities: ModelCapabilities;
  /** Ordered list of provider-native wire parameters. */
  parameters: readonly ParameterFieldSchema[];
  /** Lookup map from canonical `StandardParameterKey` to provider-native wire parameter key. */
  standardParameterMap: Partial<Record<StandardParameterKey, string>>;
  /** Required wire parameter keys. */
  requiredParameters: readonly string[];
  tags?: readonly string[];
  syncedAt: string;
}

export interface CanonicalModelRecord {
  /** Canonical model ID (e.g. `bytedance/seedance-2.5`, `openai/gpt-image-2.6-sunburst`). */
  id: string;
  family: string;
  creator: string;
  displayName: string;
  modality: MultimodalModality;
  tasks: readonly MultimodalTask[];
  description?: string;
  /** Aggregated union of capabilities across verified endpoints. */
  capabilities: ModelCapabilities;
  /** Canonical standard parameters merged across the highest-quality endpoints. */
  standardParameters: Partial<Record<StandardParameterKey, ParameterFieldSchema>>;
  /** All provider endpoints serving this canonical model (`<provider>:<endpointId>`). */
  endpointIds: readonly string[];
  providers: readonly string[];
  sources: readonly SourceKind[];
  tags?: readonly string[];
  lastSyncedAt: string;
}

export interface ProviderCatalogShard {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  shardId: string;
  source: SourceKind;
  generatedAt: string;
  providers: readonly ProviderInfo[];
  endpoints: readonly ModelEndpointEntry[];
}

export interface RegistrySourceReport {
  source: SourceKind;
  url?: string;
  status: 'ok' | 'partial' | 'skipped' | 'error';
  fetchedAt: string;
  durationMs: number;
  endpointCount: number;
  withDetailedSchema: number;
  note?: string;
}

export interface RegistryStats {
  totalEndpoints: number;
  totalCanonicalModels: number;
  withDetailedSchema: number;
  byModality: Record<MultimodalModality, number>;
  byProvider: Record<string, number>;
  byFamily: Record<string, number>;
  bySchemaQuality: Record<ModelEndpointEntry['schemaQuality'], number>;
}

export interface RegistryIndexManifest {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  generatedAt: string;
  syncScope: 'flagship' | 'full';
  shards: readonly string[];
  providers: readonly ProviderInfo[];
  sources: readonly RegistrySourceReport[];
  stats: RegistryStats;
}

export interface MultimodalRegistry {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  generatedAt: string;
  syncScope: 'flagship' | 'full';
  providers: Record<string, ProviderInfo>;
  endpoints: Record<string, ModelEndpointEntry>;
  canonicalModels: Record<string, CanonicalModelRecord>;
  sources: readonly RegistrySourceReport[];
  stats: RegistryStats;
}

export interface ParameterValidationIssue {
  key: string;
  standardKey?: StandardParameterKey;
  code:
    | 'missing_required'
    | 'unknown_parameter'
    | 'invalid_type'
    | 'invalid_enum'
    | 'out_of_range'
    | 'invalid_length'
    | 'dependency_mismatch';
  message: string;
}

export interface ParameterValidationResult {
  valid: boolean;
  issues: ParameterValidationIssue[];
  /** Defaults extracted from the model's parameter schema. */
  defaults: Record<string, unknown>;
  /** Provider-native payload resolved from either standard keys or wire keys. */
  resolvedPayload: Record<string, unknown>;
}

export interface ModelComparisonRow {
  attribute: string;
  category: 'meta' | 'capability' | 'parameter';
  values: Record<string, string>;
}

export interface ModelComparisonResult {
  models: readonly (ModelEndpointEntry | CanonicalModelRecord)[];
  rows: readonly ModelComparisonRow[];
  sharedStandardParameters: readonly StandardParameterKey[];
  uniqueStandardParameters: Record<string, readonly StandardParameterKey[]>;
}

export function isMultimodalModality(value: unknown): value is MultimodalModality {
  return typeof value === 'string' && (MULTIMODAL_MODALITIES as readonly string[]).includes(value);
}

export function isStandardParameterKey(value: unknown): value is StandardParameterKey {
  return typeof value === 'string' && (STANDARD_PARAMETER_KEYS as readonly string[]).includes(value);
}

/**
 * Runtime structural assertion for a loaded ProviderCatalogShard or MultimodalRegistry.
 */
export function assertValidShard(shard: ProviderCatalogShard): void {
  if (shard.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new Error(`Unsupported shard schemaVersion: ${String(shard.schemaVersion)}`);
  }
  const seen = new Set<string>();
  for (const endpoint of shard.endpoints) {
    if (!endpoint.id || !endpoint.id.includes(':')) {
      throw new Error(`Invalid endpoint id: ${endpoint.id}`);
    }
    if (seen.has(endpoint.id)) {
      throw new Error(`Duplicate endpoint id in shard ${shard.shardId}: ${endpoint.id}`);
    }
    seen.add(endpoint.id);
    if (!isMultimodalModality(endpoint.modality)) {
      throw new Error(`Invalid modality "${endpoint.modality}" on ${endpoint.id}`);
    }
    if (!endpoint.canonicalId || !endpoint.family || !endpoint.creator) {
      throw new Error(`Missing canonical metadata on ${endpoint.id}`);
    }
    for (const param of endpoint.parameters) {
      if (!param.key || !param.label) {
        throw new Error(`Invalid parameter definition on ${endpoint.id}`);
      }
      if (param.standardKey && !isStandardParameterKey(param.standardKey)) {
        throw new Error(`Invalid standardKey "${param.standardKey}" on ${endpoint.id}.${param.key}`);
      }
    }
  }
}
