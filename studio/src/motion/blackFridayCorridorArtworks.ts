import gptHeroHd from './model-hubs/gpt-image-2-6/hero.webp';
import seedanceHeroHd from './model-hubs/seedance-2-5/hero.webp';
import lightShadowProductHd from './model-hubs/gpt-image-2-6/light-shadow-product.avif';
import retroPrintPosterHd from './model-hubs/gpt-image-2-6/retro-print-poster.avif';
import surreal3dPosterHd from './model-hubs/gpt-image-2-6/surreal-3d-poster.avif';
import glassSculptureHd from './scene-art/studio-glass-sculpture.avif';
import aiInfluencerArt from './scene-art/ai-influencer-marketing.webp';
import ambientPianoArt from './scene-art/ambient-piano.webp';
import babylonJsArt from './scene-art/babylon-js.webp';
import bubbleFieldArt from './scene-art/bubble-field.webp';
import colorPopPosterArt from './scene-art/color-pop-poster.webp';
import footageToHandpaintedArt from './scene-art/footage-to-handpainted.webp';
import komonaSunsetArt from './scene-art/komona-sunset.webp';
import lunarShotStillArt from './scene-art/lunar-shot-still.webp';
import premiumHaloArt from './scene-art/premium-halo.webp';
import sofaRelightArt from './scene-art/sofa-relight.webp';
import splashFloatProductArt from './scene-art/splash-float-product.webp';
import talkingHeadArt from './scene-art/talking-head-recreation.webp';
import { archivedSkillPoster } from './skillCoverMedia';

const cdnSkillArtworks = [
  'dark-premium-poster',
  'aurora-gradient',
  'liquid-glass-logo',
  'quantum-particles',
  'felt-stop-motion',
  'relight-reveal',
]
  .map(name => archivedSkillPoster(name))
  .filter((url): url is string => Boolean(url));

/**
 * Compact curated pool of 24 lightweight AVIF/WebP artworks owned by OpenMotion
 * (same-origin bundled Studio posters + OpenMotion CDN skill covers under
 * `releases.open-design.ai`). Bundled assets sit first so foreground rings
 * paint immediately with zero third-party requests.
 */
export const BLACK_FRIDAY_CORRIDOR_ARTWORKS: readonly string[] = [
  gptHeroHd,
  seedanceHeroHd,
  glassSculptureHd,
  komonaSunsetArt,
  lightShadowProductHd,
  aiInfluencerArt,
  retroPrintPosterHd,
  lunarShotStillArt,
  surreal3dPosterHd,
  babylonJsArt,
  bubbleFieldArt,
  colorPopPosterArt,
  footageToHandpaintedArt,
  premiumHaloArt,
  sofaRelightArt,
  splashFloatProductArt,
  talkingHeadArt,
  ambientPianoArt,
  ...cdnSkillArtworks,
];
