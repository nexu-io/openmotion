import type { ScenarioId } from '../../../shared/scenarios';
import aiInfluencerMarketing from '../motion/scene-art/ai-influencer-marketing.webp';
import { motionSkills, motionStudioCover, archivedSkillPoster } from '../motion/skillCatalog';
import { gemini4Spotlight } from '../motion/gemini4Spotlight';

const covers: Record<ScenarioId, string> = {
  'motion-full-chain': motionStudioCover?.poster ?? '',
  'gemini-4-neon': gemini4Spotlight.poster,
  'design-full-chain': archivedSkillPoster('color-pop-poster'),
  'black-friday': motionSkills.find(s => s.id === 'openmotion-sale-carousel')?.cover?.poster ?? archivedSkillPoster('sale-countdown'),
  'ai-influencer': aiInfluencerMarketing,
};

export const scenarioCover = (id: ScenarioId) => covers[id];
