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
  const featureScene = isFeatureScene(scene);
  const restrictToOpenDesign = openDesignOnly || featureScene;
  // Non-feature Studio scenes follow the navigation menu model set; feature scenes accept any capability-matched OpenDesign model.
  const listed = (gateway ? (scene ? withOpenDesignModels(gateway.models, providers) : gateway.models).filter(model => model.modality === modality
    && (!scene || featureScene || menuRank(model) >= 0 || model.id === modelId)
    && (!scene || supportsScene(model, scene))
    && (!restrictToOpenDesign || isOpenDesignProvider(model.provider))) : [])
    .sort((a, b) => providerRank(a.provider) - providerRank(b.provider) || (scene ? studioSortRank(a) - studioSortRank(b) : 0));
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
