import { modelReferenceLimit, type Modality, type Model } from '../../../shared/gateway';
import { imageFeatures } from '../../../shared/image-features';
import { videoFeatures } from '../../../shared/video-features';
import { isFeatureScene, sceneFeature, sceneVideoFeature, supportsScene, type StudioScene } from './creativeStudios';
import type { loadGateway } from './gatewayClient';
import { isOpenDesignProvider, modelFamilyLabel, providerRank, providerReady, studioModelRank } from './imageMenuModels';

/**
 * Resolves eligible models for Studio scenes and ordinary Assets library generation
 * from the single live gateway catalog (`gateway.models`).
 * Every scene matches models dynamically by modality and declared capabilities (`supportsScene`)
 * without static model-ID allowlists, so newly published OpenDesign models appear automatically.
 * Feature scenes still scope to OpenDesign routes (`restrictToOpenDesign`).
 * With two or more image references, models that accept fewer drop out (e.g. Seedream 5.5 accepts 1).
 */
export function creationModels(
  gateway: Awaited<ReturnType<typeof loadGateway>> | undefined,
  modality: Modality,
  modelId?: string | null,
  scene?: StudioScene,
  openDesignOnly = false,
  referenceCount = 0,
  templateModelId?: string,
) {
  const providers = gateway?.status.providers ?? [];
  const featureScene = isFeatureScene(scene);
  const restrictToOpenDesign = openDesignOnly || featureScene;
  // Single source of truth: follow the live gateway catalog for every Studio scene, using flagship rank only for display order.
  // Never synthesize placeholder models when the live catalog is empty so creation pickers stay truthful to the gateway.
  const listed = (gateway ? gateway.models.filter(model => model.modality === modality
    && (!scene || supportsScene(model, scene))
    && (!restrictToOpenDesign || isOpenDesignProvider(model.provider))) : [])
    .sort((a, b) =>
      providerRank(a.provider) - providerRank(b.provider)
      || (scene ? studioModelRank(a) - studioModelRank(b) || modelFamilyLabel(a).localeCompare(modelFamilyLabel(b)) : 0));
  // When nothing takes every reference, keep the list so the page can explain the limit instead of offering setup.
  const fitting = referenceCount >= 2 && modality === 'image' ? listed.filter(model => modelReferenceLimit(model) >= referenceCount) : listed;
  const compatible = fitting.length ? fitting : listed;
  const available = compatible.filter(model => providerReady(providers, model.provider));
  const pinned = modelId ? compatible.find(model => model.id === modelId) : undefined;
  const feature = scene && sceneFeature(scene);
  const videoFeature = scene && sceneVideoFeature(scene);
  const recommendedId = feature ? imageFeatures[feature].recommended : videoFeature ? videoFeatures[videoFeature].recommended : undefined;
  const recommended = (models: typeof listed) => recommendedId ? models.find(model => model.modelId === recommendedId) : undefined;
  const preferred = pinned ?? (modelId && !restrictToOpenDesign ? undefined
    : available.find(model => model.modelId === templateModelId) ?? recommended(available)
      ?? available.find(model => model.id === gateway?.status.routes[modality]) ?? available[0]
      ?? (scene ? recommended(compatible) ?? compatible[0] : undefined));
  const selected = available.find(model => model.id === preferred?.id);
  const choices = scene ? compatible : available;
  return { available, selected, choices, compatible, preferred };
}

/**
 * Maximum number of reference images the user can attach in a Studio scene.
 * Feature scenes (e.g. Character reference, up to 5) auto-switch away from 1-ref models once >= 2
 * references are attached, so attaching stays open up to the best available (or compatible) model's
 * cap clamped by the feature rule — even while a 1-ref model is selected or before provider setup.
 */
export function attachableReferenceLimit(
  resolved: ReturnType<typeof creationModels>,
  scene?: StudioScene,
): number {
  const feature = scene && sceneFeature(scene);
  const featureMax = feature ? imageFeatures[feature].maxReferences : undefined;
  const ceiling = featureMax ?? (scene?.modality === 'video' ? 1 : Infinity);
  if (isFeatureScene(scene)) {
    const pool = resolved.available.length ? resolved.available : resolved.compatible;
    if (!pool.length) return featureMax ?? 1;
    const best = pool.reduce((max, model) => Math.max(max, modelReferenceLimit(model)), 0);
    return Math.min(best, ceiling);
  }
  const activeModel = resolved.selected ?? resolved.preferred;
  const limit = activeModel ? modelReferenceLimit(activeModel) : 1;
  return Math.min(limit, ceiling);
}
