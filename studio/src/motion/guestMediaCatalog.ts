import type { Model } from '../../../shared/gateway';
import { generationOptions } from '../../../shared/generation-options';
import { openDesignImageReferenceCap, openDesignModels } from '../../../shared/opendesign-models';
import { openDesignVideoModels } from '../../../shared/video-features';
import type { loadGateway } from './gatewayClient';

/** Public model descriptions for the creation form. Account routes and entitlements come from the live gateway after login. */
export const guestMediaCatalog: Awaited<ReturnType<typeof loadGateway>> = {
  mode: 'opendesign',
  status: { providers: [], agents: [], routes: {}, capabilities: [] },
  models: openDesignModels.map(entry => {
    const video = openDesignVideoModels.find(model => model.modelId === entry.modelId);
    const imageLimit = openDesignImageReferenceCap(entry.modelId);
    const model: Model = {
      ...entry, id: `opendesign:${entry.modelId}`, provider: 'opendesign', source: 'builtin',
      ...(imageLimit && { supportsImageReference: true, maxInputImages: imageLimit }),
      ...(video && { maxInputImages: 1, nativeOptions: {
        resolutions: video.resolutions,
        ratios: entry.modelId === 'wan-2.7' ? ['16:9', '9:16', '1:1', '4:3', '3:4', 'adaptive'] : ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
        durations: { default: video.durations.default, values: Array.from({ length: video.durations.max - video.durations.min + 1 }, (_, i) => video.durations.min + i) },
      } }),
    };
    model.generationOptions = generationOptions(model);
    return model;
  }),
};
