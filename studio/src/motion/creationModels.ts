import { capabilitySupportsModel, findCapability, type CapabilityDefinition } from '../../../shared/capability-registry';
import { modelReferenceLimit, type Modality, type Model } from '../../../shared/gateway';
import { imageFeatures } from '../../../shared/image-features';
import { videoFeatures } from '../../../shared/video-features';
import { isFeatureScene, sceneFeature, sceneVideoFeature, supportsScene, type StudioScene } from './creativeStudios';
import type { loadGateway } from './gatewayClient';
import { isOpenDesignProvider, menuRank, providerRank, providerReady, withOpenDesignModels } from './imageMenuModels';

const studioSortRank = (model: Model) => {
  const rank = menuRank(model);
  return rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
};

/**
 * Resolves eligible models for Studio scenes and ordinary Assets library generation.
 * Feature scenes match OpenDesign models dynamically by declared capabilities (`supportsScene`)
 * rather than restricting to static menu IDs, so newly published OpenDesign models appear automatically.
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
  const feature = scene && sceneFeature(scene);
  const videoFeature = scene && sceneVideoFeature(scene);
  const activeCap = scene ? findCapability(feature ?? videoFeature ?? scene.id, gateway?.capabilities) : undefined;
  const strictCapabilityFilter = Boolean(activeCap && (activeCap.executor.kind === 'dedicated-model' || (scene && 'capabilityId' in scene)));
  const featureScene = isFeatureScene(scene);
  const restrictToOpenDesign = openDesignOnly || featureScene;
  // Non-feature Studio scenes follow the navigation menu model set; feature scenes accept any capability-matched OpenDesign model.
  const listed = (gateway ? (scene ? withOpenDesignModels(gateway.models, providers) : gateway.models).filter(model => model.modality === modality
    && (!scene || featureScene || strictCapabilityFilter || menuRank(model) >= 0 || model.id === modelId)
    && (!scene || supportsScene(model, scene))
    && (!strictCapabilityFilter || !activeCap || capabilitySupportsModel(activeCap, model))
    && (!restrictToOpenDesign || isOpenDesignProvider(model.provider))) : [])
    .sort((a, b) => providerRank(a.provider) - providerRank(b.provider) || (scene ? studioSortRank(a) - studioSortRank(b) : 0));
  // When nothing takes every reference, keep the list so the page can explain the limit instead of offering setup.
  const fitting = referenceCount >= 2 && modality === 'image' ? listed.filter(model => modelReferenceLimit(model) >= referenceCount) : listed;
  const compatible = fitting.length ? fitting : listed;
  const available = compatible.filter(model => providerReady(providers, model.provider));
  const pinned = modelId ? compatible.find(model => model.id === modelId) : undefined;
  const capRecommended = activeCap && (activeCap.executor.kind === 'prompt-preset' || activeCap.executor.kind === 'dedicated-model')
    ? activeCap.executor.recommendedModel
    : undefined;
  const recommendedId = capRecommended ?? (feature ? imageFeatures[feature].recommended : videoFeature ? videoFeatures[videoFeature].recommended : undefined);
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
 * Feature scenes (e.g. Image blend, 2 to 5 references) cap attachments to the best available
 * (or compatible) model's limit clamped by the feature/capability rule — even before provider setup.
 */
export function attachableReferenceLimit(
  resolved: ReturnType<typeof creationModels>,
  scene?: StudioScene,
  capabilities?: readonly CapabilityDefinition[],
): number {
  const feature = scene && sceneFeature(scene);
  const videoFeature = scene && sceneVideoFeature(scene);
  const activeCap = scene ? findCapability(feature ?? videoFeature ?? scene.id, capabilities) : undefined;
  const featureMax = feature ? imageFeatures[feature].maxReferences : undefined;
  const capMax = activeCap?.input.maxReferences;
  const ceiling = Math.min(
    featureMax ?? Infinity,
    capMax ?? Infinity,
    scene?.modality === 'video' ? 1 : Infinity,
  );
  if (isFeatureScene(scene)) {
    const pool = resolved.available.length ? resolved.available : resolved.compatible;
    if (!pool.length) return Number.isFinite(ceiling) ? ceiling : 1;
    const best = pool.reduce((max, model) => Math.max(max, modelReferenceLimit(model)), 0);
    return Math.min(best, ceiling);
  }
  const activeModel = resolved.selected ?? resolved.preferred;
  const limit = activeModel ? modelReferenceLimit(activeModel) : 1;
  return Math.min(limit, ceiling);
}
