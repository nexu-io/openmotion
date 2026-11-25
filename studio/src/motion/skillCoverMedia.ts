import repositoryMedia from '../../../repository-media.json';
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

const previewDirectory = 'studio/src/motion/skill-covers/';
const hostedPreviews = new Map(repositoryMedia.files.filter(file => file.path.startsWith(previewDirectory)).map(file => [file.path, file.url]));
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
  return bundledPosters[name] ?? hostedPreviews.get(`${previewDirectory}${name}.webp`);
}

export function archivedSkillCover(name: string, format: 'mp4' | 'webm' | 'gif' = 'mp4') {
  const animation = hostedPreviews.get(`${previewDirectory}${name}.${format}`);
  const poster = archivedSkillPoster(name);
  return format === 'gif' ? { gif: animation, poster } : { video: animation, poster };
}
