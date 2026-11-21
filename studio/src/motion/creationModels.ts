import { findCapability } from '../../../shared/capability-registry';
import { modelReferenceLimit, type Modality } from '../../../shared/gateway';
import { imageFeatures } from '../../../shared/image-features';
import { videoFeatures } from '../../../shared/video-features';
import { sceneFeature, sceneVideoFeature, supportsScene, type StudioScene } from './creativeStudios';
import type { loadGateway } from './gatewayClient';
import { isOpenDesignProvider, menuRank, providerRank, providerReady, withOpenDesignModels } from './imageMenuModels';

/** `openDesignOnly` serves feature entries: only OpenDesign models, with any other pinned model ignored.
 * With two or more references, models that accept fewer drop out (Seedream 5.5 rejects them with HTTP 400). */
export function creationModels(gateway: Awaited<ReturnType<typeof loadGateway>> | undefined, modality: Modality, modelId?: string | null, scene?: StudioScene, openDesignOnly = false, referenceCount = 0, templateModelId?: string) {
  const providers = gateway?.status.providers ?? [];
  // Studios offer the same fixed list as the navigation menus; ordinary Assets library creation retains every configured provider.
  const listed = (gateway ? (scene ? withOpenDesignModels(gateway.models, providers) : gateway.models).filter(model => model.modality === modality
    && (!scene || menuRank(model) >= 0 || model.id === modelId)
    && (!scene || supportsScene(model, scene))
    && (!openDesignOnly || isOpenDesignProvider(model.provider))) : [])
    .sort((a, b) => providerRank(a.provider) - providerRank(b.provider) || (scene ? menuRank(a) - menuRank(b) : 0));
  // When nothing takes every reference, keep the list so the page can explain the limit instead of offering setup.
  const fitting = referenceCount >= 2 && modality === 'image' ? listed.filter(model => modelReferenceLimit(model) >= referenceCount) : listed;
  const compatible = fitting.length ? fitting : listed;
  const available = compatible.filter(model => providerReady(providers, model.provider));
  const pinned = modelId ? compatible.find(model => model.id === modelId) : undefined;
  const feature = scene && sceneFeature(scene);
  const videoFeature = scene && sceneVideoFeature(scene);
  const activeCap = scene ? findCapability(feature ?? videoFeature ?? scene.id, gateway?.capabilities) : undefined;
  const capRecommended = activeCap && (activeCap.executor.kind === 'prompt-preset' || activeCap.executor.kind === 'dedicated-model')
    ? activeCap.executor.recommendedModel
    : undefined;
  const recommendedId = capRecommended ?? (feature ? imageFeatures[feature].recommended : videoFeature ? videoFeatures[videoFeature].recommended : undefined);
  const recommended = (models: typeof listed) => recommendedId ? models.find(model => model.modelId === recommendedId) : undefined;
  const preferred = pinned ?? (modelId && !openDesignOnly ? undefined
    : available.find(model => model.modelId === templateModelId) ?? recommended(available)
      ?? available.find(model => model.id === gateway?.status.routes[modality]) ?? available[0]
      ?? (scene ? recommended(compatible) ?? compatible[0] : undefined));
  const selected = available.find(model => model.id === preferred?.id);
  const choices = scene ? compatible : available;
  return { available, selected, choices, compatible, preferred };
}
