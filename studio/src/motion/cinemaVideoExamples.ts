import { archivedSkillCover, archivedSkillPoster } from './skillCoverMedia';

function videoExample(name: string, title: string, prompt: string) {
  return { title, prompt, poster: archivedSkillPoster(name), clip: archivedSkillCover(name).video, posterAspect: 16 / 9 };
}

export const drinkSplash = videoExample(
  'splash-float-product', 'Slow motion detail',
  'Film a slow-motion close-up of an orange soda bottle with citrus slices, mint and splashing water.',
);

export const productPushIn = videoExample(
  'light-shadow-product', 'A cinematic opening',
  'Start on the supplied frame. Push in slowly as a band of sunlight moves across the product.',
);
