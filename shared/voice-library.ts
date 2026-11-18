import type { AssetReference } from './asset-library.ts';

export const voiceProviders = ['fishaudio', 'minimax-speech-cn', 'minimax-speech'] as const;
export type VoiceProvider = typeof voiceProviders[number];
export function isVoiceProvider(value: unknown): value is VoiceProvider { return voiceProviders.some(provider => provider === value); }
export const voiceKinds = ['cloned', 'designed', 'system', 'unknown'] as const;
export type VoiceReference = { voiceId: string; revision: number };
export type VoiceAsset = {
  id: string; name: string; provider: VoiceProvider; externalId: string; kind: typeof voiceKinds[number];
  description: string; revision: number; createdAt: number; updatedAt: number; trashedAt?: number;
  preview?: AssetReference; checkedAt?: number; access: 'unchecked' | 'listed' | 'not_listed';
  connection: 'ready' | 'required' | 'changed';
};
export const voicePrompt = 'Use openmotion_media_use to inspect my speech providers, then openmotion_assets_use with action=voice to choose or save an existing voice. Ask for my voice and script, check the provider connection, generate an audio asset with its voiceRef, then import the selected audio version into my video. If the connection changed, recheck the voice; a missing list entry does not prove deletion. Keep API keys in Model providers. Do not substitute another voice or place the voice record itself on the timeline.';
