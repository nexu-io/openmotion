import type { Model } from './gateway.ts';
import { generationOptions } from './generation-options.ts';
import { openDesignImageReferenceCap, openDesignModels } from './opendesign-models.ts';
import { openDesignVideoModels } from './video-features.ts';

let cachedPreviewModels: Model[] | null = null;

/**
 * Built-in read-only OpenDesign preview catalogue derived directly from the maintained
 * `openDesignModels`, `openDesignVideoModels`, and `openDesignImageReferenceCap` tables.
 * Shared by Studio guest preview and the Cloud `/motion-api/models/catalog` fallback for
 * guests and non-entitled (Free/Go) workspaces so labels, caps, and native options stay in sync.
 */
export function buildOpenDesignPreviewModels(): Model[] {
  if (!cachedPreviewModels) {
    cachedPreviewModels = openDesignModels.map(entry => {
      const video = openDesignVideoModels.find(model => model.modelId === entry.modelId);
      const imageLimit = openDesignImageReferenceCap(entry.modelId);
      const model: Model = {
        ...entry,
        id: `opendesign:${entry.modelId}`,
        provider: 'opendesign',
        source: 'builtin',
        ...(imageLimit ? { supportsImageReference: true, maxInputImages: imageLimit } : {}),
        ...(video
          ? {
              maxInputImages: 1,
              nativeOptions: {
                resolutions: video.resolutions,
                ratios:
                  entry.modelId === 'wan-2.7'
                    ? ['16:9', '9:16', '1:1', '4:3', '3:4', 'adaptive']
                    : ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
                durations: {
                  default: video.durations.default,
                  values: Array.from(
                    { length: video.durations.max - video.durations.min + 1 },
                    (_, i) => video.durations.min + i,
                  ),
                },
              },
            }
          : {}),
      };
      const opts = generationOptions(model);
      if (opts) model.generationOptions = opts;
      return model;
    });
  }
  return cachedPreviewModels;
}
