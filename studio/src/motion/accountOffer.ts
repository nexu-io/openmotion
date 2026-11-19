/** What the account page promises about multimodal generation, and the optional campaign shown beside it. */
export const MULTIMODAL_CAPABILITIES = [
  { icon: 'image-line', label: 'Images' },
  { icon: 'film-line', label: 'Video' },
  { icon: 'voiceprint-line', label: 'Voiceover' },
  { icon: 'music-2-line', label: 'Music' },
] as const;

export type AccountOffer = { title: string; detail: string; startsAt: string; endsAt: string };

/**
 * Campaign copy beside the sign-in and upgrade guides. Name the discount and end date once the commercial team
 * freezes the Black Friday price table; until then it states no percentage or deadline. Keep every message in
 * settings-ui.json for each locale.
 */
export const ACCOUNT_OFFER: AccountOffer | null = {
  title: 'Annual offer',
  detail: 'Save when you pay yearly for Plus, Pro or Max.',
  startsAt: '2026-11-19T00:00:00Z',
  endsAt: '2026-12-04T23:59:59Z',
};

export function activeAccountOffer(now = Date.now(), offer = ACCOUNT_OFFER) {
  return offer && Date.parse(offer.startsAt) <= now && now <= Date.parse(offer.endsAt) ? offer : null;
}
