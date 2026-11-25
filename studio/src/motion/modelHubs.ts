import geminiPoster from './model-hubs/gemini-4.svg?url';
import { gemini4Videos, type HubVideo } from './gemini4Videos';
import { findMediaStudio } from '../../../shared/studio-catalog';
import { studioDestination, type StudioDestination } from './creativeStudios';
import cover04 from './corridor-covers/cover-04.avif?no-inline';
import cover06 from './corridor-covers/cover-06.avif?no-inline';
import cover08 from './corridor-covers/cover-08.avif?no-inline';
import cover10 from './corridor-covers/cover-10.avif?no-inline';
import cover11 from './corridor-covers/cover-11.avif?no-inline';
import cover12 from './corridor-covers/cover-12.avif?no-inline';
import cover14 from './corridor-covers/cover-14.avif?no-inline';
import cover15 from './corridor-covers/cover-15.avif?no-inline';
import cover17 from './corridor-covers/cover-17.avif?no-inline';
import cover18 from './corridor-covers/cover-18.avif?no-inline';
import cover20 from './corridor-covers/cover-20.avif?no-inline';
import cover22 from './corridor-covers/cover-22.avif?no-inline';
import cover23 from './corridor-covers/cover-23.avif?no-inline';
import cover24 from './corridor-covers/cover-24.avif?no-inline';
import cover25 from './corridor-covers/cover-25.avif?no-inline';
import cover26 from './corridor-covers/cover-26.avif?no-inline';
import cover27 from './corridor-covers/cover-27.avif?no-inline';
import cover28 from './corridor-covers/cover-28.avif?no-inline';
import cover29 from './corridor-covers/cover-29.avif?no-inline';
import cover30 from './corridor-covers/cover-30.avif?no-inline';
import cover35 from './corridor-covers/cover-35.avif?no-inline';
import glassSculpture from './scene-art/studio-glass-sculpture.avif';
import retroPoster from './model-hubs/gpt-image-2-6/retro-print-poster.avif?no-inline';
import lightShadowProduct from './model-hubs/gpt-image-2-6/light-shadow-product.avif?no-inline';
import surreal3dPoster from './model-hubs/gpt-image-2-6/surreal-3d-poster.avif?no-inline';

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

    summary: 'Multi-shot cinema video generation · Unlock with Go Plus or above.',

    poster: cover26,
    provider: 'opendesign',
    modelPattern: /seedance[\s._/-]*v?2[.\s_-]5(?!\d|\.\d)/i,
    companionPattern: /seedream|kling|veo|wan/i,
    primaryDestination: cinemaTextToVideo,
    primaryCta: 'Start Creating',

    promoBadge: 'Black Friday 50% Off',

    casesHeading: '1-Click Cinema Templates',

    cases: [
      {
        id: 'sd-pink-horizon',
        title: 'Pastel Horizon Walk',
        tag: 'Fashion & Visual',
        poster: cover25,
        aspectRatio: 9 / 16,
        prompt: 'Ultra-wide low-angle fashion film of a model in tailored ivory flared trousers framed against a soft rose-pink dusk sky over dark asphalt, gentle camera push-in, dreamy halation glow.',
        destination: cinemaTextToVideo,
      },
      {
        id: 'sd-cloud-giant',
        title: 'Runway Giant Track',
        tag: 'Fashion & Visual',
        poster: cover26,
        aspectRatio: 4 / 3,
        prompt: 'Low-angle cinema dolly shot looking up at a model in an oversized powder-blue sculptural feather coat standing over a miniature red sports car racing on a curved track, misty cyan cyclorama studio lighting, 35mm anamorphic lens.',
        destination: cinemaTextToVideo,
      },
      {
        id: 'sd-teardrop-closeup',
        title: 'Teardrop Cinema Close-Up',
        tag: 'Creative Ads',
        poster: cover27,
        aspectRatio: 16 / 9,
        prompt: 'Intimate 85mm anamorphic close-up portrait of a curly-haired woman with a single glistening tear sliding down her cheek, warm tungsten key light, subtle breathing camera drift, raw 35mm film grain.',
        destination: cinemaTextToVideo,
      },
      {
        id: 'sd-camp-heroine',
        title: 'Field Tent Dialogue',
        tag: 'Creative Ads',
        poster: cover28,
        aspectRatio: 16 / 9,
        prompt: 'Cinematic tracking medium shot inside a sunlit canvas field tent, determined woman wearing a red patterned neckerchief speaking with raw emotion, dusty golden backlighting, shallow depth of field.',
        destination: cinemaTextToVideo,
      },
      {
        id: 'sd-shibuya-walk',
        title: 'Tokyo Crossing Street',
        tag: 'Fashion & Visual',
        poster: cover30,
        aspectRatio: 16 / 9,
        prompt: '35mm street documentary tracking shot of a stylish youth holding a soft-serve cone walking through a bustling Tokyo crosswalk at dusk, neon signs softening into creamy bokeh.',
        destination: cinemaTextToVideo,
      },
      {
        id: 'sd-sushi-bar',
        title: 'Omakase Counter Wide',
        tag: 'Creative Ads',
        poster: cover23,
        aspectRatio: 16 / 9,
        prompt: 'Stylized wide-angle cinema shot at a serene Kyoto sushi counter: model in sheer emerald mesh top lifting nigiri with wooden chopsticks while the chef works softly in the warm background.',
        destination: cinemaTextToVideo,
      },
      {
        id: 'sd-night-drive',
        title: 'Midnight Car Interior',
        tag: 'Motion & Speed',
        poster: cover24,
        aspectRatio: 16 / 9,
        prompt: 'Intimate cinematic medium shot inside a car driving through quiet city streets at night, woman in camel wool coat illuminated by passing cool-cyan and amber streetlights, contemplative cinema pacing.',
        destination: cinemaTextToVideo,
      },
      {
        id: 'sd-cherry-soda',
        title: 'Retro Cherry Sip',
        tag: 'Creative Ads',
        poster: cover22,
        aspectRatio: 16 / 9,
        prompt: 'Symmetrical Wes Anderson style commercial shot of a chic bob-hair model sipping from a pastel pink cherry juice carton inside a glossy crimson-panelled retro diner booth, warm tungsten key lights.',
        destination: cinemaTextToVideo,
      },
      {
        id: 'sd-crimson-f1',
        title: 'Crimson Silhouette F1',
        tag: 'Motion & Speed',
        poster: cover10,
        aspectRatio: 16 / 9,
        prompt: 'Side-tracking high-speed shot of a Formula 1 race car silhouette blazing across a molten vermilion-red studio horizon, dramatic light streaks reflecting off wet tarmac, shallow depth of field, commercial film grain.',
        destination: cinemaTextToVideo,
      },
      {
        id: 'sd-subway-commute',
        title: 'Metro Morning Stillness',
        tag: 'Fashion & Visual',
        poster: cover29,
        aspectRatio: 16 / 9,
        prompt: 'Poetic slow-motion subway car shot: ginger-haired woman in narrow oval glasses holding a paper coffee cup stands still in the center as commuters gently sway in cool fluorescent train light.',
        destination: cinemaTextToVideo,
      },
      {
        id: 'sd-ny-coffee',
        title: 'Soho Corner Breakfast',
        tag: 'Fashion & Visual',
        poster: cover35,
        aspectRatio: 3 / 4,
        prompt: 'Candid 35mm vertical film clip of a stylish young woman in tortoiseshell glasses and knitted arm warmers enjoying a morning bagel at a quiet Soho sidewalk cafe, foreground coffee cup bokeh.',
        destination: cinemaTextToVideo,
      },
      {
        id: 'sd-stadium-purple',
        title: 'Arena Lightstick Drone',
        tag: 'Motion & Speed',
        poster: cover11,
        aspectRatio: 9 / 16,
        prompt: 'Sweeping vertical FPV cinema drone gliding beneath the twilight stadium roof over an ocean of glowing violet concert lightsticks pulsing toward a luminous live stage.',
        destination: cinemaTextToVideo,
      },
      {
        id: 'sd-jetpack-cat',
        title: 'Jetpack Cat Overpass',
        tag: 'Creative Ads',
        poster: cover17,
        aspectRatio: 16 / 9,
        prompt: 'Dynamic handheld tracking shot following a chubby white cat wearing a sleek red mini jetpack soaring mid-air above a sunlit metropolitan highway overpass, motion blur cityscape background, blockbuster VFX realism.',
        destination: cinemaTextToVideo,
      },
      {
        id: 'sd-night-drift',
        title: 'Midnight Smoke Drift',
        tag: 'Motion & Speed',
        poster: cover18,
        aspectRatio: 16 / 9,
        prompt: 'Cinematic music video shot at night: performer in a matte black hoodie stands calm at center while a black coupe drifts in a tight circle behind them, warm headlights cutting through billowing tire smoke.',
        destination: cinemaTextToVideo,
      },
      {
        id: 'sd-wasabi-omakase',
        title: 'Hinoki Counter Still Life',
        tag: 'Creative Ads',
        poster: cover06,
        aspectRatio: 1,
        prompt: 'Quiet square-frame culinary cinema shot of fresh mountain wasabi root resting beside a hand-forged yanagiba knife on warm hinoki cypress wood, subtle steam and razor-sharp blade glint.',
        destination: cinemaTextToVideo,
      },
      {
        id: 'sd-street-drift',
        title: 'Wet Asphalt Night Drift',
        tag: 'Motion & Speed',
        poster: cover15,
        aspectRatio: 16 / 9,
        prompt: 'Ultra-low bumper-mounted camera tracking a white race car drifting across wet midnight asphalt, crisp reflections of city streetlamps streaking across the ground, raw cinema motion blur.',
        destination: cinemaTextToVideo,
      },
    ],
    videos: [],
  },
  {
    id: 'gpt-image-2-6',
    title: 'GPT Image 2.6',
    modelName: 'GPT Image 2.6',
    latestModel: 'GPT Image 2.6',
    vendor: 'OpenAI',
    eyebrow: 'Black Friday Unlimited',

    summary: 'Annual Pro & Max 7-day unlimited · Includes Seedream 5.5 / 5.0 & Nano Banana 2 (API supported).',

    poster: glassSculpture,
    provider: 'opendesign',
    modelPattern: /gpt[\s._/-]*image[\s._/-]*v?2[.\s_-]6(?!\d|\.\d)/i,
    companionPattern: /seedream|nano-banana|flux|imagen/i,
    primaryDestination: designTextToImage,
    primaryCta: 'Create Image',

    promoModels: ['GPT Image 2.6', 'Seedream 5.5', 'Seedream 5.0', 'Nano Banana 2'],
    promoBadge: '7 Days Unlimited',

    casesHeading: 'Featured Image Recipes',

    cases: [
      {
        id: 'gi-street-portrait',
        title: 'Soho Film Editorial',
        tag: 'Fashion & Portrait',
        poster: cover35,
        aspectRatio: 3 / 4,
        prompt: 'Candid 35mm editorial street portrait of a young woman in tortoiseshell glasses and knitted arm warmers outside a downtown cafe, natural overcast light, subtle film grain.',
        destination: designTextToImage,
      },
      {
        id: 'gi-glass-ribbon',
        title: 'Iridescent Glass Sculpture',
        tag: 'Product & 3D',
        poster: glassSculpture,
        aspectRatio: 4 / 3,
        prompt: 'Minimalist sculptural ribbon of blown dichroic glass floating in soft lavender-pearl studio light, delicate violet and cyan caustics, ultra-clean architectural product render, 8k octane clarity.',
        destination: designTextToImage,
      },
      {
        id: 'gi-visor-editorial',
        title: 'Chrome Visor Editorial',
        tag: 'Fashion & Portrait',
        poster: cover04,
        aspectRatio: 16 / 9,
        prompt: 'High-fashion futuristic portrait of a platinum-blonde model in sleek metallic chrome wraparound visor sunglasses and cutout black turtleneck, windblown hair, high-key white motion-blur runway backdrop.',
        destination: designTextToImage,
      },
      {
        id: 'gi-stamp-portrait',
        title: 'Crimson Stamp Close-Up',
        tag: 'Fashion & Portrait',
        poster: cover12,
        aspectRatio: 5 / 4,
        prompt: 'Avant-garde macro fashion beauty portrait of an East Asian model with sharp jet-black bob haircut, three vintage pastel postage stamps delicately placed across the bridge of her nose, vibrant crimson studio backdrop, flash photography.',
        destination: designTextToImage,
      },
      {
        id: 'gi-skincare-lineup',
        title: 'Minimalist Skincare Trio',
        tag: 'Product & 3D',
        poster: cover14,
        aspectRatio: 16 / 9,
        prompt: 'Architectural studio product lineup of minimalist clear glass and matte charcoal skincare bottles on a warm walnut tabletop, clean serif bottle typography, diffused warm cream cyclorama backlight.',
        destination: designTextToImage,
      },
      {
        id: 'gi-sunglass-triptych',
        title: 'Floating Portrait Triptych',
        tag: 'Fashion & Portrait',
        poster: cover20,
        aspectRatio: 3 / 2,
        prompt: 'Minimalist luxury fashion campaign composition: blonde model in dark wrap sunglasses wearing pastel pink silk top and sage parachute pants centered between two angled floating close-up portrait panels on clean white-to-grey studio gradient.',
        destination: designTextToImage,
      },
      {
        id: 'gi-wasabi-minimal',
        title: 'Hinoki Culinary Still Life',
        tag: 'Product & 3D',
        poster: cover06,
        aspectRatio: 1,
        prompt: 'Editorial minimalist food still life: fresh wasabi root and hand-forged steel blade arranged on warm hinoki wood counter, refined chiaroscuro lighting, medium-format photography.',
        destination: designTextToImage,
      },
      {
        id: 'gi-street-billboard',
        title: 'Downtown Beverage Lightbox',
        tag: 'Poster & KV',
        poster: cover08,
        aspectRatio: 16 / 9,
        prompt: 'Photorealistic street-level photograph of a sleek black backlit sidewalk advertising kiosk displaying a vivid cyan-and-yellow minimalist beverage can poster on a sunlit downtown boulevard, crisp architectural shadows.',
        destination: designTextToImage,
      },
      {
        id: 'gi-light-shadow',
        title: 'Botanical Shadow Fragrance',
        tag: 'Product & 3D',
        poster: lightShadowProduct,
        aspectRatio: 16 / 9,
        prompt: 'Luxury amber glass dropper bottle resting on raw travertine stone plinth with crisp afternoon botanical leaf shadows cast across warm plaster wall, editorial stillness.',
        destination: designTextToImage,
      },
      {
        id: 'gi-retro-print',
        title: 'Two-Ink Risograph Poster',
        tag: 'Poster & KV',
        poster: retroPoster,
        aspectRatio: 4 / 3,
        prompt: 'Bold two-ink risograph graphic poster on textured uncoated paper stock, tall condensed display typography paired with halftone geometric illustration, tactile print grain.',
        destination: designTextToImage,
      },
      {
        id: 'gi-surreal-3d',
        title: 'Surreal 3D Art Direction',
        tag: 'Poster & KV',
        poster: surreal3dPoster,
        aspectRatio: 16 / 9,
        prompt: 'Surreal minimalist 3D art direction key visual with sculptural glossy forms, dramatic studio rim light, rich atmospheric contrast, museum exhibition poster composition.',
        destination: designTextToImage,
      },
      {
        id: 'gi-pink-fashion-tall',
        title: 'Rose Dusk Low-Angle',
        tag: 'Poster & KV',
        poster: cover25,
        aspectRatio: 9 / 16,
        prompt: 'Ultra-wide vertical fashion editorial poster of tailored ivory wide-leg trousers silhouetted against a dreamy rose-pink twilight sky and dark tarmac, minimalist typography space.',
        destination: designTextToImage,
      },
    ],
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
