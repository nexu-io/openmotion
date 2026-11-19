/** What the account page promises about multimodal generation, and the optional campaign shown beside it. */
export const MULTIMODAL_CAPABILITIES = [
  { icon: 'image-line', label: 'Images' },
  { icon: 'film-line', label: 'Video' },
  { icon: 'voiceprint-line', label: 'Voiceover' },
  { icon: 'music-2-line', label: 'Music' },
] as const;

export type AccountOffer = { title: string; detail: string; startsAt: string; endsAt?: string };

/**
 * The note beside the sign-in and upgrade guides. The standing annual price is 30% below twelve monthly list
 * prices for Plus, Pro and Max (AMR public pricing: $168 / $840 / $1,680 a year against $20 / $100 / $200 a
 * month), so it has no end date. A time-limited campaign sets `endsAt`; keep every message in settings-ui.json
 * for each locale.
 */
export const ACCOUNT_OFFER: AccountOffer | null = {
  title: 'Annual offer',
  detail: 'Plus, Pro and Max cost 30% less when billed yearly.',
  startsAt: '2026-11-19T00:00:00Z',
};

export function activeAccountOffer(now = Date.now(), offer = ACCOUNT_OFFER) {
  if (!offer || now < Date.parse(offer.startsAt)) return null;
  return offer.endsAt === undefined || now <= Date.parse(offer.endsAt) ? offer : null;
}
