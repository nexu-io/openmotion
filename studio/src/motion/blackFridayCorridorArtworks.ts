import gptHeroHd from './model-hubs/gpt-image-2-6/hero.webp';
import seedanceHeroHd from './model-hubs/seedance-2-5/hero.webp?no-inline';
import glassSculptureHd from './scene-art/studio-glass-sculpture.avif';
import lightShadowProductHd from './model-hubs/gpt-image-2-6/light-shadow-product.avif';
import retroPrintPosterHd from './model-hubs/gpt-image-2-6/retro-print-poster.avif';
import surreal3dPosterHd from './model-hubs/gpt-image-2-6/surreal-3d-poster.avif';

declare const __STUDIO_PREVIEW_BASE__: string;
declare const __MODEL_HUB_PREVIEW_HASHES__: Record<string, string>;

const hubPosterUrl = (hash: string | undefined): string =>
  hash ? `${__STUDIO_PREVIEW_BASE__}${hash}.webp` : '';

/**
 * Compact curated pool of 24 lightweight AVIF/WebP artworks sourced strictly from
 * the GPT Image 2.0 (`gpt-image-2-6`) and Seedance 2.5 (`seedance-2-5`) multimodal
 * hubs (bundled local hub covers + OpenMotion CDN showcase posters under
 * `releases.open-design.ai`). Bundled hub covers sit first so foreground rings
 * paint immediately while keeping `ExploreStudios` decoupled from `curatedCases.ts`.
 */
export const BLACK_FRIDAY_CORRIDOR_ARTWORKS: readonly string[] = [
  gptHeroHd,
  seedanceHeroHd,
  glassSculptureHd,
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-sd-1.webp']),
  lightShadowProductHd,
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-sd-2.webp']),
  surreal3dPosterHd,
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-sd-3.webp']),
  retroPrintPosterHd,
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-sd-6.webp']),
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-gi-2.webp']),
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-sd-7.webp']),
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-gi-3.webp']),
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-sd-10.webp']),
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-gi-4.webp']),
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-sd-14.webp']),
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-gi-5.webp']),
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-sd-17.webp']),
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-gi-8.webp']),
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-sd-20.webp']),
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-gi-11.webp']),
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-sd-22.webp']),
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-gi-15.webp']),
  hubPosterUrl(__MODEL_HUB_PREVIEW_HASHES__['hub-sd-23.webp']),
].filter(Boolean);
