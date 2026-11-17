// Curated reference pool shared by every onboarding host. Select once per preparation.
export const onboardingTemplateIds = [
  'motion-664184d9-593e-4984-b473-701248b69cfe',
  'motion-b31d078a-4e5e-461e-8b43-3101ee0a2f93',
  'motion-1e48dea5-903d-48f6-b10e-99a70f1c183d',
  'motion-f6f244d1-c549-4081-8a5d-f0e1e3660044',
  'motion-d8eea6d9-b25b-4727-823d-d102070ea694',
  'motion-5eb6929e-d9f3-4a49-a69e-0363e45884dc',
  'motion-dac924da-010f-4445-baf3-a39cb033e48f',
  'motion-0ad92fd0-b2fb-4885-957c-b71152df15fd',
  'motion-a28f0e5d-aa8b-45a7-87f9-9afcac65a09b',
] as const;

export function selectOnboardingTemplateIds(random: () => number = Math.random): string[] {
  const pool: string[] = [...onboardingTemplateIds];
  for (let index = 0; index < 3; index++) {
    const selected = index + Math.floor(random() * (pool.length - index));
    [pool[index], pool[selected]] = [pool[selected], pool[index]];
  }
  return pool.slice(0, 3);
}

// Existing clients can still explicitly request the original bundled examples.
export const builtinRecommendationIds = ['product-promo', 'nyt-graph', 'decision-tree'] as const;
export const recommendationTemplateIds = [...builtinRecommendationIds, ...onboardingTemplateIds] as const;

// These small records pin the presentation to its actual catalog/source identity.
// Original reference videos remain at their content-addressed public media URLs.
export const onboardingSourceFiles = onboardingTemplateIds.flatMap(id =>
  ['template.json', 'TEMPLATE.md', 'source/motion.md', 'source/preview.html', 'source/manifest.json']
    .map(file => `library/templates/catalog/${id}/${file}`));
