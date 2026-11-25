import { consumePendingAttribution } from './entitlementAttribution';
import { useRef } from 'react';
import { settingsEntryFrom } from './pageTracking';
import { modelFields, newTrackingId, send, slugField, type Fields } from './reporting';
import { useCardImpressions } from './useTemplateImpressions';

export type OfferKind = NonNullable<Fields<'ui_click'>['offer_kind']>;
type OfferSource = { studio: string; scene: string } | { settingsSection: 'account' | 'subscription' };

export function createOfferVisit(source: OfferSource) {
  const location = 'settingsSection' in source
    ? { page_name: 'settings', area: 'account', settings_section: source.settingsSection } as const
    : { page_name: 'creative_studio', area: 'asset_create', ...slugField('studio_id', source.studio), ...slugField('scene_id', source.scene) } as const;
  return { fields: { ...location, offer_visit_id: newTrackingId() }, seen: new Set<OfferKind>() };
}
export type OfferVisit = ReturnType<typeof createOfferVisit>;

export function useOfferImpression(visit: OfferVisit | undefined, kind: OfferKind) {
  const card = useRef<HTMLElement>(null);
  useCardImpressions(card, kind, Boolean(visit && !visit.seen.has(kind)), visit?.fields.offer_visit_id ?? '', () => {
    if (visit && !visit.seen.has(kind)) {
      visit.seen.add(kind);
      send('surface_view', { ...visit.fields, element: 'card', offer_kind: kind });
    }
    return true;
  }, 'data-generation-offer');
  return card;
}

export function reportOfferClick(visit: OfferVisit, kind: OfferKind, model?: string | null) {
  const settings = visit.fields.page_name === 'settings';
  const signingIn = kind === 'sign_in';
  const attribution = settings
    ? consumePendingAttribution(signingIn ? 'sign_in' : 'subscription', signingIn ? 'settings_signin' : 'settings_subscription')
    : { hookId: signingIn ? 'studio_generate' as const : 'studio_free_gate' as const, entryId: newTrackingId() };
  const entryFrom = visit.fields.page_name === 'settings' ? settingsEntryFrom() : undefined;
  send('ui_click', { ...visit.fields, element: kind === 'sign_in' ? 'sign_in' : 'view_plans', offer_kind: kind,
    entry_id: attribution.entryId, hook_id: attribution.hookId, ...modelFields(model), ...(entryFrom ? { entry_from: entryFrom } : {}) });
  return attribution;
}
