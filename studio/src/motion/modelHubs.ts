import geminiPoster from './model-hubs/gemini-4.svg?url';
import { gemini4Videos, type HubVideo } from './gemini4Videos';

/** Local posters for posts whose X cover is a blank first frame; captured mid-video. */
const posterOverrides: Record<string, string> = Object.fromEntries(Object.entries(import.meta.glob('./model-hubs/gemini-4/posters/*.jpg', { query: '?url', import: 'default', eager: true }) as Record<string, string>)
  .map(([path, url]) => [path.split('/').pop()!.replace(/\.jpg$/, ''), url]));
const withPoster = (video: HubVideo): HubVideo => posterOverrides[video.id] ? { ...video, poster: posterOverrides[video.id] } : video;

/**
 * Model hubs are editorial landing pages for a model family. Facts come from the
 * vendor's own announcement; availability is always read from the live gateway
 * catalog, so a hub never claims a model is usable before a provider serves it.
 */
export interface ModelHubFact { value: string; label: string }
export interface ModelHubUse { id: string; title: string; hint: string; icon: string; target: { kind: 'motion' } | { kind: 'studio'; id: string } }
export interface ModelHub {
  id: string; title: string;
  /** Full name of the model people can use today, shown wherever access is explained. */
  modelName: string;
  /** Full name of the newest release, shown on the Explore banner. */
  latestModel: string; vendor: string; eyebrow: string; summary: string; poster: string;
  /** Matches gateway model ids or model ids served for this family. */
  modelPattern: RegExp;
  /** Matches companion media models from the same vendor already in the catalog. */
  companionPattern: RegExp;
  provider: string; facts: ModelHubFact[]; uses: ModelHubUse[];
  sources: { label: string; href: string }[];
  /** Community videos made with this family; media stays on the original posts. */
  videos: HubVideo[];
}

export const modelHubs: ModelHub[] = [{
  id: 'gemini-4', title: 'Gemini 4', modelName: 'Gemini 4 Argon', latestModel: 'Gemini 4 Neon', vendor: 'Google DeepMind', eyebrow: 'New model',
  summary: 'Writes animation, 3D and data visuals directly in code.',
  poster: geminiPoster, provider: 'gemini',
  modelPattern: /gemini-4/i, companionPattern: /google\/|nano-banana|veo|imagen/i,
  facts: [
    { value: '1M', label: 'Argon: output tokens in one run' },
    { value: '91.7%', label: 'Argon: LVBench long-video understanding' },
    { value: '77.9%', label: 'Argon: DeepSWE v1.1 software engineering' },
    { value: '$2 / $10', label: 'Argon: per 1M input / output tokens, introductory price' },
  ],
  uses: [
    { id: 'motion', title: 'Script and animate a motion piece', hint: 'Describe the story; the Agent writes editable motion you can retime on the timeline.', icon: 'movie-line', target: { kind: 'motion' } },
    { id: 'shorts', title: 'Cut a long recording into shorts', hint: 'Long-video understanding finds the moments worth keeping.', icon: 'scissors-cut-line', target: { kind: 'studio', id: 'shorts' } },
    { id: 'explainer', title: 'Explain a topic with data', hint: 'Turn a document or a chart into a visual explanation.', icon: 'film-line', target: { kind: 'studio', id: 'explainer' } },
    { id: 'marketing', title: 'Plan a launch film', hint: 'Draft the script and shots, then generate each frame.', icon: 'clapperboard-line', target: { kind: 'studio', id: 'marketing' } },
  ],
  sources: [
    { label: 'Google: Gemini 4 Argon announcement (Sep 30, 2026)', href: 'https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-argon/' },
    { label: 'Gemini API documentation', href: 'https://ai.google.dev/gemini-api/docs' },
  ],
  videos: gemini4Videos.map(withPoster),
}];

export const findModelHub = (id: string | null | undefined) => modelHubs.find(hub => hub.id === id) ?? null;
