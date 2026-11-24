/**
 * Playable-ad network rules used by the "Playable ad" publish target (export a package the user
 * uploads). Source: outputs/2026-11-23/higgsfield-playable-chain/research.md, section "9 家网络规格",
 * which cites each network's official spec page. The package is built in the browser by
 * gamePackage.ts (inline local files, route the store button to `ctaCode`, add network files) and
 * every check is measured on the downloaded file.
 */

export type PlayableNetworkId = 'mraid' | 'applovin' | 'google' | 'unity' | 'meta' | 'tiktok' | 'mintegral' | 'moloco' | 'liftoff';

export interface PlayableNetwork {
  id: PlayableNetworkId;
  /** Display name (brand names stay untranslated). */
  name: string;
  /** Package form, English source key. */
  format: string;
  limitMb: number;
  /** CTA call the store button must use (shown to the user). */
  cta: string;
  /** Code the rewritten store button runs; `url` is the store link for the player's device. */
  ctaCode: string;
  /** mraid.js handling, English source key. */
  mraid: string;
  /** Extra assets the network asks for, English source key, or empty. */
  extra?: string;
  console: { label: string; href?: string };
}

export const PLAYABLE_NETWORKS: readonly PlayableNetwork[] = [
  { id: 'mraid', name: 'MRAID', format: 'Single HTML', limitMb: 5, cta: 'mraid.open(url)', ctaCode: 'mraid.open(url)', mraid: 'Add mraid.js in <head>', console: { label: 'Your MRAID network console (InMobi, Chartboost…)' } },
  { id: 'applovin', name: 'AppLovin', format: 'Single HTML', limitMb: 5, cta: 'mraid.open(url)', ctaCode: 'mraid.open(url)', mraid: 'Add mraid.js as the first script', console: { label: 'AppLovin dashboard', href: 'https://dash.applovin.com/' } },
  { id: 'google', name: 'Google Ads', format: 'Zip', limitMb: 5, cta: 'ExitApi.exit()', ctaCode: 'ExitApi.exit()', mraid: 'No mraid.js; add exitapi.js and the ad.orientation tag', console: { label: 'Google Ads', href: 'https://ads.google.com/' } },
  { id: 'unity', name: 'Unity', format: 'Single HTML', limitMb: 5, cta: 'mraid.open(url)', ctaCode: 'mraid.open(url)', mraid: 'Injected by the container; do not add it', console: { label: 'Unity Grow dashboard', href: 'https://cloud.unity.com/' } },
  { id: 'meta', name: 'Meta (≤2 MB)', format: 'Single HTML (zip above 2 MB)', limitMb: 2, cta: 'FbPlayableAd.onCTAClick()', ctaCode: 'FbPlayableAd.onCTAClick()', mraid: 'mraid.js must not appear', extra: 'Lead-in video required', console: { label: 'Meta Ads Manager', href: 'https://adsmanager.facebook.com/' } },
  { id: 'tiktok', name: 'TikTok / Pangle', format: 'Zip with config.json', limitMb: 5, cta: 'window.openAppStore()', ctaCode: 'window.openAppStore()', mraid: 'mraid.js must not appear; add the TikTok SDK', extra: 'Also needs a video or image', console: { label: 'TikTok Ads Manager', href: 'https://ads.tiktok.com/' } },
  { id: 'mintegral', name: 'Mintegral', format: 'Single HTML', limitMb: 5, cta: 'window.install()', ctaCode: 'window.install()', mraid: 'No mraid.js; call gameReady / gameEnd / gameRetry', extra: '1200×627 image and 512 px icon', console: { label: 'Mintegral advertiser console', href: 'https://adv.mintegral.com/' } },
  { id: 'moloco', name: 'Moloco', format: 'Single HTML, assets as data URIs', limitMb: 5, cta: 'FbPlayableAd.onCTAClick()', ctaCode: 'FbPlayableAd.onCTAClick()', mraid: 'mraid.js and XMLHttpRequest must not appear', console: { label: 'Moloco Ads console', href: 'https://www.moloco.com/' } },
  { id: 'liftoff', name: 'Liftoff', format: 'Single HTML', limitMb: 5, cta: 'mraid.open(url)', ctaCode: 'mraid.open(url)', mraid: 'Wait for mraid ready and visible', console: { label: 'Liftoff dashboard', href: 'https://liftoff.io/' } },
];


export function playableNetwork(nameOrId: string | undefined): PlayableNetwork | undefined {
  return PLAYABLE_NETWORKS.find(network => network.name === nameOrId || network.id === nameOrId);
}
