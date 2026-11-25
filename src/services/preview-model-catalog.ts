import type { Model } from '../../shared/gateway.ts';
import { generationOptions } from '../../shared/generation-options.ts';

type PreviewModelSeed = Omit<Model, 'generationOptions'>;

const OPENDESIGN_PREVIEW_SEEDS: readonly PreviewModelSeed[] = [
  {
    id: 'opendesign:seedream-5.5',
    provider: 'opendesign',
    modelId: 'seedream-5.5',
    label: 'Seedream 5.5',
    modality: 'image',
    mode: 'text-to-image',
    source: 'builtin',
    supportsImageReference: true,
    maxInputImages: 4,
    nativeOptions: {
      aspect_ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
      resolutions: ['1K', '2K', '4K'],
    },
  },
  {
    id: 'opendesign:gpt-image-2.6-pro',
    provider: 'opendesign',
    modelId: 'gpt-image-2.6-pro',
    label: 'GPT Image 2.6 Pro',
    modality: 'image',
    mode: 'text-to-image',
    source: 'builtin',
    supportsImageReference: true,
    maxInputImages: 5,
    nativeOptions: {
      aspect_ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
      resolutions: ['1K', '2K', '4K'],
    },
  },
  {
    id: 'opendesign:doubao-seedance-2-5-260628',
    provider: 'opendesign',
    modelId: 'doubao-seedance-2-5-260628',
    label: 'Seedance 2.5',
    modality: 'video',
    mode: 'text-to-video',
    source: 'builtin',
    supportsImageReference: true,
    maxInputImages: 1,
    nativeOptions: {
      aspect_ratios: ['16:9', '9:16', '1:1'],
      resolutions: ['720p', '1080p'],
      durations: [5, 10],
    },
  },
  {
    id: 'opendesign:wan-2.7',
    provider: 'opendesign',
    modelId: 'wan-2.7',
    label: 'Wan 2.7',
    modality: 'video',
    mode: 'text-to-video',
    source: 'builtin',
    supportsImageReference: true,
    maxInputImages: 1,
    nativeOptions: {
      aspect_ratios: ['16:9', '9:16', '1:1'],
      resolutions: ['720p', '1080p'],
      durations: [5, 10],
    },
  },
  {
    id: 'opendesign:elevenlabs-music-v2',
    provider: 'opendesign',
    modelId: 'elevenlabs-music-v2',
    label: 'ElevenLabs Music v2',
    modality: 'audio',
    mode: 'text-to-audio',
    source: 'builtin',
    nativeOptions: {
      durations: [15, 30, 60],
    },
  },
  {
    id: 'opendesign:elevenlabs-v3',
    provider: 'opendesign',
    modelId: 'elevenlabs-v3',
    label: 'ElevenLabs Speech v3',
    modality: 'audio',
    mode: 'text-to-speech',
    source: 'builtin',
  },
];

let cachedPreviewModels: Model[] | null = null;

/**
 * Built-in read-only OpenDesign preview catalogue used by `/motion-api/models/catalog`
 * when guests or Free/Go workspaces receive an empty live catalogue from upstream,
 * so Studio can still render native model pickers and parameter controls while
 * generation remains gated by login / plan entitlement.
 */
export function buildOpenDesignPreviewModels(): Model[] {
  if (!cachedPreviewModels) {
    cachedPreviewModels = OPENDESIGN_PREVIEW_SEEDS.map((seed) => {
      const model: Model = { ...seed };
      const opts = generationOptions(model);
      if (opts) model.generationOptions = opts;
      return model;
    });
  }
  return cachedPreviewModels;
}
