import geminiPoster from './model-hubs/gemini-4.svg?url';
import { gemini4Videos, type HubVideo } from './gemini4Videos';
import { findMediaStudio } from '../../../shared/studio-catalog';
import { studioDestination, type StudioDestination } from './creativeStudios';
import seedanceHeroPoster from './model-hubs/seedance-2-5/hero.webp?no-inline';
import gptImageHeroPoster from './model-hubs/gpt-image-2-6/hero.webp?no-inline';
import { buildGptImageShowcaseCases, buildSeedanceShowcaseCases } from './model-hubs/curatedCases';

/** Local posters for posts whose X cover is a blank first frame; captured mid-video. */
const posterOverrides: Record<string, string> = Object.fromEntries(Object.entries(import.meta.glob('./model-hubs/gemini-4/posters/*.avif', { query: '?url', import: 'default', eager: true }) as Record<string, string>)
  .map(([path, url]) => [path.split('/').pop()!.replace(/\.avif$/, ''), url]));
const withPoster = (video: HubVideo): HubVideo => posterOverrides[video.id] ? { ...video, poster: posterOverrides[video.id] } : video;

export interface HubShowcaseCase {
  id: string;
  title: string;
  tag: string;
  poster: string;
  /** Optional preview video URL; plays strictly on hover/focus in the showcase grid and inside the lightbox. */
  video?: string;
  /** Optional higher-resolution video URL preferred in the full lightbox player, falling back to `video`. */
  videoHd?: string;
  /** Optional community author credit (shown only for attributed creator posts). */
  author?: string;
  /** Optional original post URL paired with `author`. */
  sourceUrl?: string;
  /** Natural width/height ratio used for staggered masonry layout (e.g. 9/16, 4/3, 16/9, 1). */
  aspectRatio: number;
  prompt: string;
  destination: StudioDestination;
}

/**
 * Model hubs are editorial landing pages for a model family. Facts come from the
 * vendor's own announcement; availability is always read from the live gateway
 * catalog, so a hub never claims a model is usable before a provider serves it.
 */
export interface ModelHub {
  id: string;
  title: string;
  /** Full name of the model people can use today, shown wherever access is explained. */
  modelName: string;
  /** Full name of the newest release, shown on the Explore banner. */
  latestModel: string;
  vendor: string;
  eyebrow: string;

  summary: string;

  poster: string;
  /** Matches gateway model ids or model ids served for this family. */
  modelPattern: RegExp;
  /** Matches companion media models from the same vendor already in the catalog. */
  companionPattern: RegExp;
  provider: string;
  /** Optional primary Studio destination when launching directly from the hub hero. */
  primaryDestination?: StudioDestination;
  primaryCta?: string;

  /** Optional Black Friday promo note / bundled models highlighted in the hero. */
  promoModels?: string[];
  promoBadge?: string;

  /** Curated 1-click remixable showcase cases for this model hub. */
  cases?: HubShowcaseCase[];
  casesHeading?: string;

  /** Community videos made with this family; media stays on the original posts. */
  videos: HubVideo[];
}

const cinema = findMediaStudio('cinema')!;
const design = findMediaStudio('design')!;
const cinemaTextToVideo = studioDestination(cinema, 'text-to-video');
const designTextToImage = studioDestination(design, 'text-to-image');

export const modelHubs: ModelHub[] = [
  {
    id: 'seedance-2-5',
    title: 'Seedance 2.5',
    modelName: 'Seedance 2.5',
    latestModel: 'Seedance 2.5',
    vendor: 'ByteDance',
    eyebrow: 'Black Friday 50% Off',

    summary: 'Multi-shot cinema video generation · Unlock with Plus or above.',

    poster: seedanceHeroPoster,
    provider: 'opendesign',
    modelPattern: /seedance[\s._/-]*v?2[.\s_-]5(?!\d|\.\d)/i,
    companionPattern: /seedream|kling|veo|wan/i,
    primaryDestination: cinemaTextToVideo,
    primaryCta: 'Start Creating',

    promoBadge: 'Black Friday 50% Off',

    casesHeading: '1-Click Cinema Templates',

    cases: buildSeedanceShowcaseCases(cinemaTextToVideo),
    videos: [],
  },
  {
    id: 'gpt-image-2-6',
    title: 'GPT Image 2.0',
    modelName: 'GPT Image 2.0',
    latestModel: 'GPT Image 2.0',
    vendor: 'OpenAI',
    eyebrow: 'Black Friday Unlimited',

    summary: 'Annual Pro & Max 7-day unlimited · Includes Nano Banana 2, Seedream 5.0 & 5.5 (API supported on first 3).',

    poster: gptImageHeroPoster,
    provider: 'opendesign',
    modelPattern: /gpt[\s._/-]*image[\s._/-]*v?2[.\s_-][06](?!\d|\.\d)/i,
    companionPattern: /seedream|nano-banana|flux|imagen/i,
    primaryDestination: designTextToImage,
    primaryCta: 'Create Image',

    promoModels: ['GPT Image 2.0', 'Nano Banana 2', 'Seedream 5.0', 'Seedream 5.5'],
    promoBadge: '7 Days Unlimited',

    casesHeading: 'Featured Image Recipes',

    cases: buildGptImageShowcaseCases(designTextToImage),
    videos: [],
  },
  {
    id: 'gemini-4',
    title: 'Gemini 4',
    modelName: 'Gemini 4 Argon',
    latestModel: 'Gemini 4 Neon',
    vendor: 'Google DeepMind',
    eyebrow: 'New model',
    summary: 'Google’s newest frontier model writes whole animations in code. The hottest Gemini 4 videos on X are all here.',
    poster: geminiPoster,
    provider: 'gemini',
    modelPattern: /gemini-4/i,
    companionPattern: /google\/|nano-banana|veo|imagen/i,
    videos: gemini4Videos.map(withPoster),
  },
];

export const findModelHub = (id: string | null | undefined) => modelHubs.find(hub => hub.id === id) ?? null;
