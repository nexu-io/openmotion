import gptHeroHd from './model-hubs/gpt-image-2-6/hero.webp';
import glassSculptureHd from './scene-art/studio-glass-sculpture.avif';
import lightShadowProductHd from './model-hubs/gpt-image-2-6/light-shadow-product.avif';
import retroPrintPosterHd from './model-hubs/gpt-image-2-6/retro-print-poster.avif';
import surreal3dPosterHd from './model-hubs/gpt-image-2-6/surreal-3d-poster.avif';

const CDN = 'https://cdn.higgsfield.ai/';
const STATIC = 'https://static.higgsfield.ai/';
const KATANA = 'https://static-public-media.higgsfield.ai/katana-presets/';

/**
 * Compact curated pool of 24 lightweight AVIF/WebP artworks for the Explore
 * Black Friday 3D corridor. Bundled local assets sit first so foreground rings
 * paint immediately, and reusing a bounded WebP/AVIF set across deeper rings
 * avoids firing 70+ simultaneous external image downloads and GPU decodes on
 * Explore first load.
 */
export const BLACK_FRIDAY_CORRIDOR_ARTWORKS: readonly string[] = [
  gptHeroHd,
  `${CDN}user_3DM3djpjYDVEDT5wTH9U4EZR2R3/hf_20260623_191601_6a124dce-97fb-4709-b78b-7e9daffb2a06_thumbnail.webp`,
  glassSculptureHd,
  `${KATANA}743ea835-6137-4c3a-a372-d031a9ba54f4.webp`,
  lightShadowProductHd,
  `${CDN}d87b5ac1-2a02-457c-840b-ab412e30254b.webp`,
  retroPrintPosterHd,
  `${CDN}8a939ef5-e085-4678-aac3-d1688a9810c8.webp`,
  surreal3dPosterHd,
  `${CDN}card/80ab567c-104c-4724-99aa-3cea5114e64c.webp`,
  `${KATANA}a5e1517d-1a96-4750-b104-815abaa53b67.webp`,
  `${STATIC}ai-image-v2/one-ai-image/soul-2-0-i2.webp`,
  `${CDN}f440ef76-ca3c-421b-960e-fd424380ecc1.webp`,
  `${STATIC}public/image/empty-state/soul-cinematic-1.webp`,
  `${CDN}user_3F618kxxnh0N3gYgUuqNnkKCcN5/hf_20260623_140111_fe2726bd-7e63-4fa6-87fa-98692219e0c7_thumbnail.webp`,
  `${CDN}card/c0649640-6780-4c73-bd3c-89174cb43f1a.webp`,
  `${KATANA}671d23d1-edeb-456f-bc67-b86cac3c4d44.webp`,
  `${STATIC}ai-image/features/grid-cards-5.webp`,
  `${CDN}user_3BtgqLKXbGTRO6kN2doujsOccrj/hf_20260623_164618_3815ba7d-b6c5-444f-9574-205b270d97d1_thumbnail.webp`,
  `${STATIC}ideogram-4-5-intro/showcases/item-3.webp`,
  `${CDN}user_3ExccpH2bttaKi3Jpo6XEvKpfOG/hf_20261122_152236_44baf732-bd7b-40e6-bbf8-e0fc7b85dc64_thumbnail.webp`,
  `${CDN}83f6a5aa-5cc8-423e-843d-ad81201cbbc3.webp`,
  `${CDN}b8d9005c-fc39-48a7-b00f-a56059979095.webp`,
  `${STATIC}seedance-2.5/v2/showcase/showcase-1-thumbnail.webp`,
];
