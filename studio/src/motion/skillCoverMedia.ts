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
// first-screen discovery art serves from the CDN origin instead of raw.githubusercontent.com.
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

// Existing preview bytes remain available at this public source snapshot.
export const skillPreviewSnapshot = 'https://raw.githubusercontent.com/nexu-io/openmotion/242dbd99d41e349ea43c3d8d48a1e06f6cece81a/' + previewDirectory;
// Existing WebP posters remain available at this public source snapshot.
export const skillPosterSnapshot = 'https://raw.githubusercontent.com/nexu-io/openmotion/008e46e896a72f4e5bd743fe1c4a5752240d2e8f/' + previewDirectory;

export function archivedSkillPoster(name: string) {
  const filename = name + '.webp';
  return hostedPreviews.get(previewDirectory + filename) ?? bundledPosters[name] ?? skillPosterSnapshot + filename;
}

export function skillCover(name: string, format: 'mp4' | 'webm' | 'gif' = 'mp4', snapshot = false) {
  const filename = name + '.' + format;
  const posterFilename = name + '.webp';
  const animation = hostedPreviews.get(previewDirectory + filename)
    ?? (snapshot ? skillPreviewSnapshot + filename : import.meta.env.DEV ? '/src/motion/skill-covers/' + filename : undefined);
  const poster = hostedPreviews.get(previewDirectory + posterFilename)
    ?? bundledPosters[name]
    ?? (snapshot ? skillPosterSnapshot + posterFilename : import.meta.env.DEV ? '/src/motion/skill-covers/' + posterFilename : undefined);
  return format === 'gif' ? { gif: animation, poster } : { video: animation, poster };
}

export const archivedSkillCover = (name: string, format?: 'gif') => skillCover(name, format, true);
