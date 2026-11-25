import babylonJsPoster from './scene-art/babylon-js.webp';
import bubbleFieldPoster from './scene-art/bubble-field.webp';
import chalkBlueprintPoster from './scene-art/chalk-blueprint.webp';
import colorPopPoster from './scene-art/color-pop-poster.webp';
import footageToHandpaintedPoster from './scene-art/footage-to-handpainted.webp';
import lightShadowProductPoster from './scene-art/light-shadow-product.webp';
import multiClipsToReelsPoster from './scene-art/multi-clips-to-reels.webp';
import premiumHaloPoster from './scene-art/premium-halo.webp';
import retroPrintPoster from './scene-art/retro-print-poster.webp';
import saleCarouselPoster from './scene-art/sale-carousel.webp';
import saleCountdownPoster from './scene-art/sale-countdown.webp';
import splashFloatProductPoster from './scene-art/splash-float-product.webp';
import talkingHeadRecreationPoster from './scene-art/talking-head-recreation.webp';

declare const __STUDIO_PREVIEW_BASE__: string;
declare const __STUDIO_PREVIEW_HASHES__: Record<string, string>;
const hostedPreviews = new Map(Object.entries(__STUDIO_PREVIEW_HASHES__).map(([name, hash]) =>
  [name, __STUDIO_PREVIEW_BASE__ + hash + name.slice(name.lastIndexOf('.'))] as const));
// Explore and showcase posters are bundled via Vite into /editor-assets/*.webp so
// first-screen discovery art loads alongside the application.
const bundledPosters: Record<string, string> = {
  'babylon-js': babylonJsPoster,
  'bubble-field': bubbleFieldPoster,
  'chalk-blueprint': chalkBlueprintPoster,
  'color-pop-poster': colorPopPoster,
  'footage-to-handpainted': footageToHandpaintedPoster,
  'light-shadow-product': lightShadowProductPoster,
  'multi-clips-to-reels': multiClipsToReelsPoster,
  'premium-halo': premiumHaloPoster,
  'retro-print-poster': retroPrintPoster,
  'sale-carousel': saleCarouselPoster,
  'sale-countdown': saleCountdownPoster,
  'splash-float-product': splashFloatProductPoster,
  'talking-head-recreation': talkingHeadRecreationPoster,
};

const hostedClips = new Set(hostedPreviews.values());
export const isHostedSkillMedia = (url?: string) => Boolean(url && hostedClips.has(url));

export function archivedSkillPoster(name: string) {
  return hostedPreviews.get(`${name}.webp`) ?? bundledPosters[name];
}

export function archivedSkillCover(name: string, format: 'mp4' | 'webm' | 'gif' = 'mp4') {
  const animation = hostedPreviews.get(`${name}.${format}`);
  const poster = archivedSkillPoster(name);
  return format === 'gif' ? { gif: animation, poster } : { video: animation, poster };
}
