import { modelReferenceLimit, type GatewayStatus, type Modality, type Model } from '../../../shared/gateway';
import { providerRank } from '../motion/imageMenuModels';
import {
  classifyParameterTier,
  compatibleImageResolutions,
  enrichGenerationOptionsWithSSOT,
  generationOptions,
  knownSpeechVoiceName,
  mapWireKeyToStandard,
  resolveGenerationParameters,
  usesInputImageRatio,
  videoAudioAlwaysOn,
  type GenerationOption,
  type GenerationOptions,
  type ParameterTier,
  type StandardParameterKey,
} from '../../../shared/generation-options';

export type ResolvedSuperAgentSchema = {
  fromModel: boolean;
  delivery: GenerationOptions['delivery'];
  fields: GenerationOption[];
  primaryFields: GenerationOption[];
  advancedFields: GenerationOption[];
  inputImageRatioLocked: boolean;
  alwaysOnAudio: boolean;
};

export type MediaParamSummaryEntry = {
  key: string;
  standardKey?: StandardParameterKey;
  label: string;
  tier: ParameterTier;
  value: unknown;
  displayValue: string;
  isOverride: boolean;
};

export type ModelFilter = (model: Model) => boolean;

function isProviderReady(
  providers: readonly GatewayStatus['providers'][number][] | undefined,
  providerId: string,
): boolean {
  if (!providers?.length) return true;
  return providers.some(provider =>
    provider.id === providerId
    && provider.available
    && provider.mediaEntitlement !== 'not-included',
  );
}

export function preferredAudioModelFilters(audioType: 'music' | 'voiceover' | 'sfx'): readonly ModelFilter[] {
  if (audioType === 'voiceover') {
    return [
      model =>
        model.modality === 'audio'
        && (model.mode === 'text-to-speech' || /speech|voice|tts|kokoro/i.test(`${model.id} ${model.label}`)),
    ];
  }
  if (audioType === 'sfx') {
    return [
      model =>
        model.modality === 'audio'
        && /sound-effect|sfx|foley/i.test(`${model.id} ${model.label} ${model.mode}`),
      model => model.modality === 'audio' && model.mode !== 'text-to-speech',
    ];
  }
  return [
    model =>
      model.modality === 'audio'
      && model.mode !== 'text-to-speech'
      && !/sound-effect|sfx|foley/i.test(`${model.id} ${model.label}`),
    model => model.modality === 'audio' && model.mode !== 'text-to-speech',
  ];
}

export function preferredAudioModelFilter(audioType: 'music' | 'voiceover' | 'sfx'): ModelFilter {
  return preferredAudioModelFilters(audioType)[0]!;
}

function supportsTransparentBackground(model: Model): boolean {
  return Boolean(
    model.generationOptions?.fields.some(
      field =>
        field.key === 'background'
        && field.choices?.some(choice => String(choice.value).toLowerCase() === 'transparent'),
    ),
  );
}

export function preferredImageModelFilters(scene: string, hasInputImage = false): readonly ModelFilter[] {
  if (scene === 'remove-background') {
    return [
      model => model.modality === 'image' && Boolean(model.supportsImageReference) && supportsTransparentBackground(model),
      model => model.modality === 'image' && Boolean(model.supportsImageReference),
    ];
  }
  if (hasInputImage || scene === 'image-edit' || scene === 'relight' || scene === 'image-blend' || scene === 'character') {
    return [model => model.modality === 'image' && Boolean(model.supportsImageReference)];
  }
  return [];
}

export function preferredImageModelFilter(scene: string, hasInputImage = false): ModelFilter | undefined {
  return preferredImageModelFilters(scene, hasInputImage)[0];
}

export function preferredVideoModelFilter(hasInputImage = false): ModelFilter | undefined {
  if (hasInputImage) {
    return model => model.modality === 'video' && (model.maxInputImages ?? 0) > 0;
  }
  return undefined;
}

/**
 * Resolve which concrete Model is active for a Super Agent modality pill
 * (`selectedId === 'auto'` follows the gateway's default route or best matching ready model for the active sub-scene).
 */
export function resolveEffectiveMediaModel(
  models: readonly Model[],
  routes: GatewayStatus['routes'] | undefined,
  modality: Modality,
  selectedId: string,
  preferredFilter?: ModelFilter | readonly ModelFilter[],
  providers?: readonly GatewayStatus['providers'][number][],
): Model | undefined {
  const candidates = models.filter(item => item.modality === modality);
  if (!candidates.length) return undefined;
  if (selectedId && selectedId !== 'auto') {
    const explicit = candidates.find(item => item.id === selectedId);
    if (explicit) return explicit;
  }
  const readyCandidates = providers?.length
    ? candidates.filter(item => isProviderReady(providers, item.provider))
    : candidates;
  const unsortedPool = readyCandidates.length ? readyCandidates : candidates;
  const pool = [...unsortedPool].sort(
    (a, b) => providerRank(a.provider) - providerRank(b.provider) || a.label.localeCompare(b.label),
  );
  const routeId = routes?.[modality];
  const routeModel = routeId ? pool.find(item => item.id === routeId) : undefined;
  const filters = typeof preferredFilter === 'function'
    ? [preferredFilter]
    : preferredFilter
      ? [...preferredFilter]
      : [];
  for (const filter of filters) {
    if (routeModel && filter(routeModel)) return routeModel;
    const preferred = pool.find(filter);
    if (preferred) return preferred;
  }
  return routeModel ?? pool[0];
}

function buildCanonicalFallbackOptions(
  modality: Modality,
  audioType?: 'music' | 'voiceover' | 'sfx',
): GenerationOptions {
  if (modality === 'image') {
    return enrichGenerationOptionsWithSSOT('image', {
      delivery: 'provider',
      fields: [
        {
          key: 'aspect_ratio',
          label: 'Aspect ratio',
          kind: 'choice',
          presentation: 'ratio',
          choices: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2'].map(v => ({ value: v, label: v })),
        },
        {
          key: 'quality',
          label: 'Quality',
          kind: 'choice',
          choices: [
            { value: 'standard', label: 'Standard' },
            { value: 'high', label: 'High' },
          ],
          default: 'standard',
        },
        {
          key: 'num_images',
          label: 'Output count',
          kind: 'choice',
          presentation: 'count',
          choices: [1, 2, 4].map(n => ({ value: n, label: `${n}` })),
          default: 1,
        },
        { key: 'negative_prompt', label: 'Negative prompt', kind: 'text' },
        { key: 'seed', label: 'Seed', kind: 'number', step: 1 },
      ],
    });
  }
  if (modality === 'video') {
    return enrichGenerationOptionsWithSSOT('video', {
      delivery: 'provider',
      fields: [
        {
          key: 'aspect_ratio',
          label: 'Aspect ratio',
          kind: 'choice',
          presentation: 'ratio',
          choices: ['16:9', '9:16', '1:1', '21:9'].map(v => ({ value: v, label: v })),
          default: '16:9',
        },
        {
          key: 'duration',
          label: 'Duration (seconds)',
          kind: 'choice',
          choices: [5, 8, 10, 15].map(s => ({ value: s, label: `${s}s` })),
          default: 5,
        },
        { key: 'generate_audio', label: 'Generate audio', kind: 'boolean', default: true },
        { key: 'negative_prompt', label: 'Negative prompt', kind: 'text' },
        { key: 'seed', label: 'Seed', kind: 'number', step: 1 },
      ],
    });
  }
  if (audioType === 'voiceover') {
    return enrichGenerationOptionsWithSSOT('audio', {
      delivery: 'provider',
      fields: [
        { key: 'voice', label: 'Voice ID', kind: 'text' },
        { key: 'speed', label: 'Speech speed', kind: 'number', min: 0.5, max: 2, step: 0.1, default: 1 },
      ],
    });
  }
  return enrichGenerationOptionsWithSSOT('audio', {
    delivery: 'provider',
    fields: [
      { key: 'duration', label: 'Duration (seconds)', kind: 'number', min: 5, max: 60, step: 5, default: 30 },
      ...(audioType === 'music' ? [{ key: 'instrumental', label: 'Instrumental only', kind: 'boolean' as const, default: false }] : []),
      ...(audioType === 'sfx' ? [{ key: 'loop', label: 'Seamless loop', kind: 'boolean' as const, default: false }] : []),
      { key: 'seed', label: 'Seed', kind: 'number', step: 1 },
    ],
  });
}

/**
 * Derive the SSOT UI schema (`primaryFields` + collapsible `advancedFields`) for a model,
 * inheriting provider types, constraints, and tiers from `shared/generation-options` and `@openmotion/multimodal-models`.
 */
export function resolveSuperAgentModelSchema(
  model: Model | undefined,
  modality: Modality,
  hasInputImage = false,
  currentValues: Record<string, unknown> = {},
  audioType?: 'music' | 'voiceover' | 'sfx',
): ResolvedSuperAgentSchema {
  const fromModelOptions = model
    ? (hasInputImage ? generationOptions(model, true) : undefined) ?? model.generationOptions ?? generationOptions(model, false)
    : undefined;
  const fromModel = Boolean(fromModelOptions && fromModelOptions.fields.length > 0);
  const rawOptions = fromModel
    ? enrichGenerationOptionsWithSSOT(modality, fromModelOptions!)
    : buildCanonicalFallbackOptions(modality, audioType);

  const inputImageRatioLocked = Boolean(
    model && hasInputImage && usesInputImageRatio(model, true, currentValues),
  );
  const alwaysOnAudio = Boolean(model && modality === 'video' && videoAudioAlwaysOn(model));
  const fields = rawOptions.fields.filter(field => !(inputImageRatioLocked && field.key === 'ratio'));

  return {
    fromModel,
    delivery: rawOptions.delivery,
    fields,
    primaryFields: fields.filter(field => (field.tier ?? classifyParameterTier(modality, field.key, field.standardKey)) === 'primary'),
    advancedFields: fields.filter(field => (field.tier ?? classifyParameterTier(modality, field.key, field.standardKey)) !== 'primary'),
    inputImageRatioLocked,
    alwaysOnAudio,
  };
}

export function applyModelParamChange(
  model: Model | undefined,
  currentValues: Record<string, unknown>,
  field: GenerationOption,
  nextValue: unknown,
  hasInputImage = false,
): Record<string, unknown> {
  const next = { ...currentValues };
  if (nextValue === undefined || nextValue === '') {
    delete next[field.key];
  } else {
    next[field.key] = nextValue;
    const chosen = field.choices?.find(choice => choice.value === nextValue);
    if (chosen?.requires) {
      Object.assign(next, chosen.requires);
    }
  }
  if (field.key === 'aspect_ratio' && model) {
    const allowed = compatibleImageResolutions(model, nextValue ?? model.defaults?.aspect_ratio, hasInputImage);
    if (allowed && typeof next.resolution === 'string' && !allowed.includes(next.resolution)) {
      delete next.resolution;
    }
  }
  return next;
}

function coerceValueForField(
  field: GenerationOption,
  rawValue: unknown,
  prevField?: GenerationOption,
): unknown | undefined {
  if (rawValue === undefined || rawValue === null) return undefined;
  if (field.kind === 'choice') {
    const choices = field.choices ?? [];
    const exact = choices.find(choice => choice.value === rawValue);
    if (exact) return exact.value;
    const stringMatch = choices.find(choice => String(choice.value) === String(rawValue));
    if (stringMatch) return stringMatch.value;
    if (prevField?.presentation === 'ratio' || field.presentation === 'ratio') {
      const sourceChoice = prevField?.choices?.find(
        choice => choice.value === rawValue || String(choice.value) === String(rawValue),
      );
      const sourceLabel = (sourceChoice?.label ?? String(rawValue)).trim().toLowerCase();
      const labelMatch = choices.find(choice => choice.label.trim().toLowerCase() === sourceLabel);
      if (labelMatch) return labelMatch.value;
      const normalizeRatio = (text: string) => text.replace(/\s+hd$/i, '').trim();
      const normalizedSource = normalizeRatio(sourceLabel);
      const ratioMatch = choices.find(choice => normalizeRatio(choice.label.trim().toLowerCase()) === normalizedSource);
      if (ratioMatch) return ratioMatch.value;
    }
    if (field.allowCustom && typeof rawValue === 'string' && rawValue.trim()) {
      return rawValue.trim();
    }
    return undefined;
  }
  if (field.kind === 'boolean') {
    return typeof rawValue === 'boolean' ? rawValue : undefined;
  }
  if (field.kind === 'number') {
    const num = typeof rawValue === 'number'
      ? rawValue
      : typeof rawValue === 'string' && rawValue.trim() && Number.isFinite(Number(rawValue))
        ? Number(rawValue)
        : undefined;
    if (num === undefined || !Number.isFinite(num)) return undefined;
    if ((field.step === undefined || field.step === 1) && !Number.isInteger(num)) return undefined;
    if (field.min !== undefined && num < field.min) return undefined;
    if (field.max !== undefined && num > field.max) return undefined;
    return num;
  }
  if (field.kind === 'text') {
    return typeof rawValue === 'string' && rawValue.trim() ? rawValue : undefined;
  }
  return undefined;
}

/**
 * Migrate user-configured parameter overrides when switching between models (using wire key or shared SSOT `standardKey`),
 * discarding fields or values incompatible with the newly selected model.
 */
export function migrateModelParameters(
  prevModel: Model | undefined,
  nextModel: Model | undefined,
  prevValues: Record<string, unknown>,
  modality: Modality,
  hasInputImage = false,
  audioType?: 'music' | 'voiceover' | 'sfx',
): Record<string, unknown> {
  const entries = Object.entries(prevValues).filter(([, value]) => value !== undefined && value !== '');
  if (!entries.length) return {};

  const prevSchema = resolveSuperAgentModelSchema(prevModel, modality, hasInputImage, prevValues, audioType);
  const nextSchema = resolveSuperAgentModelSchema(nextModel, modality, hasInputImage, {}, audioType);
  const migrated: Record<string, unknown> = {};

  for (const [wireKey, rawValue] of entries) {
    const prevField = prevSchema.fields.find(f => f.key === wireKey);
    const stdKey = prevField?.standardKey ?? mapWireKeyToStandard(wireKey, modality);
    const targetField = nextSchema.fields.find(f => f.key === wireKey)
      ?? (stdKey ? nextSchema.fields.find(f => f.standardKey === stdKey) : undefined)
      ?? (prevField?.presentation === 'ratio' ? nextSchema.fields.find(f => f.presentation === 'ratio') : undefined);
    if (!targetField) continue;
    const coerced = coerceValueForField(targetField, rawValue, prevField);
    if (coerced === undefined) continue;
    migrated[targetField.key] = coerced;
    const chosen = targetField.choices?.find(choice => choice.value === coerced);
    if (chosen?.requires) {
      Object.assign(migrated, chosen.requires);
    }
  }

  if (nextModel && typeof migrated.aspect_ratio === 'string' && typeof migrated.resolution === 'string') {
    const allowed = compatibleImageResolutions(nextModel, migrated.aspect_ratio, hasInputImage);
    if (allowed && !allowed.includes(migrated.resolution)) {
      delete migrated.resolution;
    }
  }

  return migrated;
}

export function effectiveFieldValue(
  model: Model | undefined,
  field: GenerationOption,
  values: Record<string, unknown>,
  hasInputImage = false,
): unknown {
  if (values[field.key] !== undefined && values[field.key] !== '') {
    return values[field.key];
  }
  if (model?.defaults && model.defaults[field.key] !== undefined) {
    return model.defaults[field.key];
  }
  if (field.key === 'resolution' && model) {
    const activeRatio = values.aspect_ratio ?? model.defaults?.aspect_ratio;
    const allowed = compatibleImageResolutions(model, activeRatio, hasInputImage);
    if (allowed?.length) {
      return typeof field.default === 'string' && allowed.includes(field.default) ? field.default : allowed[0];
    }
  }
  return field.default;
}

export function formatParamDisplayValue(
  field: GenerationOption,
  value: unknown,
  t: (text: string) => string = text => text,
): string {
  if (value === undefined || value === '') return t('Auto');
  if (typeof value === 'boolean') return t(value ? 'On' : 'Off');
  if (typeof value === 'object') return t('Custom');
  if ((field.standardKey === 'duration' || field.key === 'duration' || field.key === 'duration_seconds') && typeof value === 'number') {
    return value === -1 ? t('Auto') : `${value}s`;
  }
  if (field.standardKey === 'voice' || field.key === 'voice') {
    const choiceLabel = field.choices?.find(c => c.value === value)?.label;
    return knownSpeechVoiceName(value) ?? choiceLabel?.split('·')[0].trim() ?? String(value);
  }
  const matched = field.choices?.find(c => c.value === value);
  const rawLabel = matched?.label ?? String(value);
  if (/^\d+(?:[:×x.]\d+)?(?:s|k|K|p|fps|ms)?$/.test(rawLabel) || rawLabel.includes(':')) {
    return rawLabel;
  }
  return t(rawLabel);
}

/**
 * Compute clean wire-key parameters and human-readable summaries ready for Super Agent submission.
 */
export function resolveSubmittedMediaParameters(
  model: Model | undefined,
  rawValues: Record<string, unknown>,
  modality: Modality,
  hasInputImage = false,
  audioType?: 'music' | 'voiceover' | 'sfx',
): {
  schema: ResolvedSuperAgentSchema;
  wireParameters: Record<string, unknown>;
  entries: MediaParamSummaryEntry[];
  activeAdvancedCount: number;
} {
  const schema = resolveSuperAgentModelSchema(model, modality, hasInputImage, rawValues, audioType);
  const cleanedRaw: Record<string, unknown> = {};

  for (const field of schema.fields) {
    const val = rawValues[field.key];
    if (val === undefined || val === '') continue;
    const coerced = coerceValueForField(field, val);
    if (coerced === undefined) continue;
    cleanedRaw[field.key] = coerced;
    const chosen = field.choices?.find(c => c.value === coerced);
    if (chosen?.requires) {
      Object.assign(cleanedRaw, chosen.requires);
    }
  }

  let wireParameters: Record<string, unknown> = cleanedRaw;
  if (model && schema.fromModel) {
    try {
      const resolved = resolveGenerationParameters(model, cleanedRaw, hasInputImage);
      wireParameters = {};
      for (const [k, v] of Object.entries(resolved)) {
        if (cleanedRaw[k] !== undefined || (model.defaults?.[k] === undefined && v !== undefined)) {
          wireParameters[k] = v;
        }
      }
      // Preserve explicit overrides plus any profile-paired resolution/aspect_ratio completed by resolveGenerationParameters.
      if (cleanedRaw.aspect_ratio !== undefined && resolved.aspect_ratio !== undefined) {
        wireParameters.aspect_ratio = resolved.aspect_ratio;
      }
      if (cleanedRaw.resolution !== undefined || (cleanedRaw.aspect_ratio !== undefined && resolved.resolution !== undefined)) {
        if (resolved.resolution !== undefined) wireParameters.resolution = resolved.resolution;
      }
    } catch {
      wireParameters = cleanedRaw;
    }
  }

  const entries: MediaParamSummaryEntry[] = [];
  let activeAdvancedCount = 0;

  for (const field of schema.fields) {
    const tier = field.tier ?? classifyParameterTier(modality, field.key, field.standardKey);
    const hasOverride = wireParameters[field.key] !== undefined;
    const val = effectiveFieldValue(model, field, wireParameters, hasInputImage);
    if (hasOverride && tier === 'advanced') {
      activeAdvancedCount += 1;
    }
    if (val === undefined) continue;
    entries.push({
      key: field.key,
      standardKey: field.standardKey,
      label: field.label,
      tier,
      value: val,
      displayValue: formatParamDisplayValue(field, val),
      isOverride: hasOverride,
    });
  }

  return { schema, wireParameters, entries, activeAdvancedCount };
}

export function buildMediaHiddenDirective({
  modality,
  effectiveModel,
  selectedModelId,
  wireParameters,
  hasInputImage,
  attachedImageReferences,
  inputImageRatioLocked,
  alwaysOnAudio,
  sceneNote,
  styleNotes = [],
}: {
  modality: Modality;
  effectiveModel?: Model;
  selectedModelId: string;
  wireParameters: Record<string, unknown>;
  hasInputImage?: boolean;
  attachedImageReferences?: readonly { assetId: string; versionId: string }[];
  inputImageRatioLocked?: boolean;
  alwaysOnAudio?: boolean;
  sceneNote?: string;
  styleNotes?: string[];
}): string {
  const modelId = selectedModelId !== 'auto'
    ? selectedModelId
    : effectiveModel?.id;
  const isPromptDelivery = effectiveModel?.generationOptions?.delivery === 'prompt'
    || effectiveModel?.provider === 'codex';
  const refLimit = effectiveModel ? modelReferenceLimit(effectiveModel) : (modality === 'video' ? 1 : undefined);
  const resolvedRefs = attachedImageReferences?.length
    ? (refLimit === undefined ? [...attachedImageReferences] : attachedImageReferences.slice(0, Math.max(0, refLimit)))
    : [];
  const referenceArg = resolvedRefs.length > 0
    ? `references=${JSON.stringify(resolvedRefs)}`
    : hasInputImage && refLimit !== 0
      ? 'references=[<attached image assetId/versionId>]'
      : null;

  const toolArgs: string[] = [
    'action="generate"',
    `modality="${modality}"`,
    ...(effectiveModel?.mode && modality === 'audio' ? [`mode="${effectiveModel.mode}"`] : []),
    ...(modelId ? [`model="${modelId}"`] : []),
    ...(referenceArg ? [referenceArg] : []),
    ...(Object.keys(wireParameters).length > 0 ? [`parameters=${JSON.stringify(wireParameters)}`] : []),
  ];

  const constraints: string[] = [];
  if (sceneNote) constraints.push(sceneNote);
  if (styleNotes.length > 0) constraints.push(styleNotes.join(', '));
  if (inputImageRatioLocked) constraints.push('aspect ratio follows attached first-frame image');
  if (alwaysOnAudio) constraints.push('selected video model generates native audio automatically');
  if (modality === 'audio' && effectiveModel?.mode === 'text-to-speech') {
    constraints.push('for text-to-speech, pass only the exact spoken narration words as prompt (no meta-instructions)');
  }
  if (hasInputImage && refLimit === 0) {
    constraints.push(`selected model ${modelId ?? ''} does not accept input image references; omit references or switch to a reference-capable model`);
  }
  if (!modelId) constraints.push('inspect configured providers via openmotion_media_use first');

  const prefix = modality === 'image'
    ? 'Design Studio Image mode'
    : modality === 'video'
      ? 'Super Agent AI Video mode'
      : 'Super Agent Audio mode';
  const pollInstruction = 'keep calling openmotion_assets_use(action="status", jobId=...) sequentially until job.state reaches "completed" or "failed" (each status call automatically waits up to ~55s; NEVER call schedule, timers, or shell sleep, and NEVER end your turn while queued or running; video jobs can take 60-180s)';

  if (isPromptDelivery && modelId) {
    return `${prefix} (model="${modelId}"): generate or refine the ${modality} asset via openmotion_assets_use(${toolArgs.join(', ')}) (honor parameters in the generation prompt when using prompt-delivery model ${modelId})${constraints.length ? ` (${constraints.join('; ')})` : ''}, ${pollInstruction}, inspect with read to iterate/optimize if needed, and present it in the Artifact Viewer via openmotion_present_artifact(kind="asset", assetId=..., versionId=...).`;
  }

  return `${prefix}: generate and optimize the ${modality} asset via openmotion_assets_use(${toolArgs.join(', ')})${constraints.length ? ` (${constraints.join('; ')})` : ''}, ${pollInstruction}, inspect the result with openmotion_assets_use(action="read", assetId=..., versionId=...) so you can refine parameters/prompt if needed, and present the completed output in the Artifact Viewer via openmotion_present_artifact(kind="asset", assetId=..., versionId=...).`;
}
