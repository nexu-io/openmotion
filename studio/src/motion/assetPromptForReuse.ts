import type { Modality } from '../../../shared/gateway';
import { imageFeaturePromptPrefix, relightControls } from '../../../shared/image-features';
import { videoFeaturePromptPrefix, videoFeatures } from '../../../shared/video-features';

function controlCombinations(controls: readonly { key: string; choices: readonly { value: string }[] }[]) {
  return controls.reduce<Record<string, string>[]>((combinations, { key, choices }) =>
    combinations.flatMap(previous => choices.map(({ value }) => ({ ...previous, [key]: value }))), [{}]);
}

const prefixesByModality = {
  image: [
    imageFeaturePromptPrefix('remove-background'),
    imageFeaturePromptPrefix('character'),
    ...controlCombinations(relightControls).map(choices => imageFeaturePromptPrefix('relight', choices)),
  ],
  video: Object.values(videoFeatures).flatMap(feature =>
    controlCombinations(feature.controls).map(choices => videoFeaturePromptPrefix(feature.id, choices))),
  audio: [],
};

/** History keeps the model prompt. Unwrap full known prefixes, including previously stacked ones. */
export function assetPromptForReuse(prompt: string, modality: Modality): string {
  const prefixes = prefixesByModality[modality];
  let text = prompt;
  for (;;) {
    const prefix = prefixes.find(value => text.startsWith(value) || text === value.trimEnd());
    if (!prefix) return text;
    text = text.slice(prefix.length).trimStart();
  }
}
