// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { validProperties, uuid } from '../../../tracking/core';
import { studioEvents } from '../../../tracking/events';
import { AccountSettings } from './AccountSettings';
import { mediaEditorDestination } from './creativeStudios';
import { createOfferVisit, type OfferKind } from './offerTracking';
import { gatewayRequest } from './gatewayClient';
import { GenerationSignInNotice, GenerationUpgradeNotice } from './ProviderSetupNotice';
import { loadReportingTransport } from './reporting';
import { trackMotion } from './tracking';

vi.mock('./gatewayClient', () => ({ gatewayRequest: vi.fn() }));
vi.mock('./tracking', () => ({ trackMotion: vi.fn(async () => 'queued') }));
vi.mock('../i18n/I18n', () => ({ useI18n: () => ({ t: (text: string) => text }) }));

it('qualifies each guide once per scene visit and links each real button click to its account request', async () => {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  let intersect: (ratio: number) => void;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {}
    observe(target: Element) { intersect = ratio => this.callback([{ target, isIntersecting: ratio > 0, intersectionRatio: ratio }]); }
    disconnect() {}
  });
  vi.useFakeTimers();
  let hidden = false;
  const visibility = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  const changeVisibility = (next: boolean) => { hidden = next; document.dispatchEvent(new Event('visibilitychange')); };
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  const packets = () => vi.mocked(trackMotion).mock.calls;
  const gateway = vi.mocked(gatewayRequest);
  gateway.mockImplementation(async path => path.endsWith('subscription') ? { opened: true } : { state: 'signed-out' });
  await loadReportingTransport();
  try {
    let previousVisit = '';
    for (const sceneId of ['remove-background', 'video-camera-control', 'video-multi-shot'] as const) {
      const destination = mediaEditorDestination(sceneId);
      const visit = createOfferVisit({ studio: destination.studio.id, scene: sceneId });
      expect(visit.fields.offer_visit_id).not.toBe(previousVisit);
      previousVisit = visit.fields.offer_visit_id;
      const renderCard = (kind: OfferKind) => act(async () => root.render(kind === 'sign_in'
        ? <GenerationSignInNotice destination={destination} visit={visit} onSignIn={() => {}} />
        : <GenerationUpgradeNotice destination={destination} visit={visit} onUpgrade={() => {}} onError={() => {}} />));
      for (const kind of ['sign_in', 'upgrade'] as const) {
        vi.mocked(trackMotion).mockClear();
        await renderCard(kind);
        intersect!(0.49); advance(1500);
        intersect!(1); advance(700); intersect!(0); advance(500);
        intersect!(0.5); advance(700); changeVisibility(true); advance(1200);
        changeVisibility(false); advance(600);
        const modal = document.createElement('dialog');
        modal.open = true;
        await act(async () => { document.body.append(modal); });
        advance(1500);
        await act(async () => { modal.remove(); });
        advance(999);
        expect(packets()).toHaveLength(0);
        advance(1);
        const fields = { page_name: 'creative_studio', area: 'asset_create', studio_id: destination.studio.id, scene_id: sceneId,
          offer_visit_id: visit.fields.offer_visit_id, offer_kind: kind };
        expect(packets()).toEqual([['surface_view', { ...fields, element: 'card' }]]);
        await act(async () => root.render(null));
        await renderCard(kind);
        advance(1200);
        expect(packets()).toHaveLength(1);
        const button = container.querySelector<HTMLButtonElement>('[data-generation-offer] button')!;
        await act(async () => button.click());
        const click = packets()[1];
        expect(packets()).toHaveLength(2);
        expect(click).toEqual(['ui_click', expect.objectContaining({ ...fields, element: kind === 'sign_in' ? 'sign_in' : 'view_plans', entry_id: expect.stringMatching(uuid) })]);
        const entryId = (click[1] as { entry_id: string }).entry_id;
        expect(gateway).toHaveBeenCalledWith('settings/account/' + (kind === 'sign_in' ? 'login' : 'subscription'), 'POST', { entryId, hookId: kind === 'sign_in' ? 'studio_generate' : 'studio_free_gate' });
        for (const [event, props] of packets()) expect(validProperties(studioEvents, event, props)).toBe(true);
        expect(validProperties(studioEvents, 'surface_view', { ...fields, element: 'card', offer_kind: 'private note' })).toBe(false);
        expect(validProperties(studioEvents, 'ui_click', { ...click[1], entry_id: 'private note' })).toBe(false);
      }
    }
  } finally {
    await act(async () => root.unmount()); container.remove();
    visibility.mockRestore(); vi.unstubAllGlobals(); vi.useRealTimers();
  }
});

it('attributes settings impressions and handoffs to the section and counts each card once per visit', async () => {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  const visits = new Set<string>();
  const entries = new Set<string>();
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {}
    observe(target: Element) { this.callback([{ target, isIntersecting: true, intersectionRatio: 0.5 }]); }
    disconnect() {}
  });
  const gateway = vi.mocked(gatewayRequest);
  let signedIn = false;
  gateway.mockImplementation(async path => path.endsWith('/subscription') ? { opened: true }
    : signedIn ? { state: 'signed-in', plan: 'free' } : { state: 'signed-out' });
  await loadReportingTransport();
  try {
    for (const section of ['account', 'subscription', 'account'] as const) {
      signedIn = false;
      const events = vi.mocked(trackMotion);
      events.mockClear();
      const render = () => act(async () => root.render(<AccountSettings key={section}
        subscription={section === 'subscription'} openProviders={() => {}} />));
      await render();
      let sectionVisit: string | undefined;
      for (const kind of ['sign_in', 'upgrade'] as const) {
        if (kind === 'upgrade') {
          signedIn = true;
          await act(async () => window.dispatchEvent(new Event('motion:account-changed')));
        }
        const button = container.querySelector<HTMLButtonElement>(`[data-generation-offer="${kind}"] button`)!;
        const fields = { page_name: 'settings', area: 'account', settings_section: section, offer_kind: kind };
        act(() => vi.advanceTimersByTime(999));
        expect(events.mock.calls).toEqual([]);
        act(() => vi.advanceTimersByTime(1));
        await render();
        act(() => vi.advanceTimersByTime(1000));
        expect(events.mock.calls).toEqual([['surface_view', { ...fields, element: 'card', offer_visit_id: expect.stringMatching(uuid) }]]);
        const visit = (events.mock.calls[0][1] as { offer_visit_id: string }).offer_visit_id;
        if (sectionVisit) expect(visit).toBe(sectionVisit);
        else { expect(visits.has(visit)).toBe(false); visits.add(visit); sectionVisit = visit; }
        for (let i = 0; i < 2; i++) {
          await act(async () => button.click());
          const [event, payload] = events.mock.calls[i + 1];
          expect(event).toBe('ui_click');
          expect(payload).toEqual({ ...fields, hook_id: kind === 'sign_in' ? 'settings_signin' : 'settings_subscription', element: kind === 'sign_in' ? 'sign_in' : 'view_plans', offer_visit_id: visit, entry_id: expect.stringMatching(uuid) });
          const entryId = (payload as { entry_id: string }).entry_id;
          expect(entries.has(entryId)).toBe(false);
          entries.add(entryId);
          expect(gateway).toHaveBeenCalledWith(kind === 'sign_in' ? 'settings/account/login' : 'settings/account/subscription', 'POST', { entryId, hookId: kind === 'sign_in' ? 'settings_signin' : 'settings_subscription' });
        }
        expect(events.mock.calls).toHaveLength(3);
        for (const [event, payload] of events.mock.calls) expect(validProperties(studioEvents, event, payload)).toBe(true);
        expect(validProperties(studioEvents, 'surface_view', { ...events.mock.calls[0][1], settings_section: 'private text' })).toBe(false);
        events.mockClear();
      }
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
