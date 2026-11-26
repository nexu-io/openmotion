// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const click = { page_name: 'home', area: 'workspace', element: 'new_creation' } as const;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); Reflect.deleteProperty(navigator, 'doNotTrack');
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules();
});

it('keeps the project token out of browser packets and sends only explicitly invoked events', async () => {
  const requests: Array<{ url: string; body?: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, body: init?.body as string | undefined });
    return new Response(JSON.stringify({ enabled: true }));
  }));
  const tracking = await import('./tracking');
  await tracking.initializeTracking();
  expect(requests).toHaveLength(1);
  document.body.click(); await tracking.flushMotionTracking(); expect(requests).toHaveLength(1);
  expect(await tracking.trackMotion('ui_click', click)).toBe('queued');
  expect(tracking.getMotionTrackingStatus()).toEqual({ configuration: 'ready', enabled: true, pending: 1, retryAfterMs: 0 });
  await tracking.flushMotionTracking();
  expect(requests).toHaveLength(2);
  const payload = JSON.parse(requests[1].body!);
  expect(payload.events[0].entrypoint).toBe('studio');
  expect(JSON.stringify(payload)).not.toMatch(/api_key|installation_id|distinct_id|utm_source|phc_/);
});

it('honors both local disablement and browser Do Not Track', async () => {
  for (const [enabled, dnt] of [[false, '0'], [true, '1']] as const) {
    vi.resetModules();
    Object.defineProperty(navigator, 'doNotTrack', { value: dnt, configurable: true });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ enabled })));
    vi.stubGlobal('fetch', fetcher);
    const tracking = await import('./tracking');
    await tracking.trackMotion('ui_click', { page_name: 'home', area: 'workspace', element: 'new_creation' });
    await tracking.flushMotionTracking();
    expect(fetcher).toHaveBeenCalledTimes(dnt === '1' ? 0 : 1);
  }
  Reflect.deleteProperty(navigator, 'doNotTrack');
});

it('does not let a stale configuration response undo a user opt-out', async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal('fetch', fetcher);
  const tracking = await import('./tracking'), pending = tracking.initializeTracking();
  tracking.setMotionTrackingEnabled(false); resolve(Response.json({ enabled: true })); await pending;
  await tracking.trackMotion('ui_click', { page_name: 'home', area: 'workspace', element: 'new_creation' });
  await tracking.flushMotionTracking(); expect(fetcher).toHaveBeenCalledTimes(1);
});

it('shares initialization and recovers the original calls after a transient configuration failure', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('PRIVATE_FAILURE'))
    .mockImplementation(async () => Response.json({ enabled: true }));
  vi.stubGlobal('fetch', fetcher);
  const tracking = await import('./tracking');
  const first = tracking.trackMotion('ui_click', click), second = tracking.trackMotion('ui_click', click);
  await vi.advanceTimersByTimeAsync(999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(tracking.getMotionTrackingStatus()).toMatchObject({ configuration: 'loading', enabled: false, pending: 0 });
  await vi.advanceTimersByTimeAsync(1);
  expect(await Promise.all([first, second])).toEqual(['queued', 'queued']);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await tracking.flushMotionTracking()).toBe('accepted');
  expect(JSON.parse(fetcher.mock.calls[2][1].body).events).toHaveLength(2);
});

it.each(['network', 'http', 'json', 'shape'])('bounds %s configuration failures and retries on a later call after cooldown', async failure => {
  let failed = true;
  const fetcher = vi.fn(async () => {
    if (!failed) return Response.json({ enabled: true });
    if (failure === 'network') throw new Error('PRIVATE_URL_AND_SECRET');
    if (failure === 'http') return new Response('', { status: 503 });
    if (failure === 'json') return new Response('not json');
    return Response.json({ enabled: 'true' });
  });
  vi.stubGlobal('fetch', fetcher);
  const tracking = await import('./tracking'), pending = tracking.trackMotion('ui_click', click);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await pending).toBe('config_unavailable');
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(tracking.getMotionTrackingStatus()).toEqual({ configuration: 'unavailable', enabled: false, pending: 0, retryAfterMs: 30_000 });
  expect(await tracking.flushMotionTracking()).toBe('disabled');
  expect(await tracking.trackMotion('ui_click', click)).toBe('config_unavailable');
  await vi.advanceTimersByTimeAsync(29_999);
  expect(await tracking.trackMotion('ui_click', click)).toBe('config_unavailable');
  expect(fetcher).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1); failed = false;
  expect(await tracking.trackMotion('ui_click', click)).toBe('queued');
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(await tracking.flushMotionTracking()).toBe('accepted');
});

it('treats a policy disablement as final and stops retries when the user opts out', async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error('offline')); vi.stubGlobal('fetch', fetcher);
  const tracking = await import('./tracking'), pending = tracking.trackMotion('ui_click', click);
  await vi.advanceTimersByTimeAsync(500);
  tracking.setMotionTrackingEnabled(false);
  expect(await pending).toBe('disabled');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await tracking.trackMotion('ui_click', click)).toBe('disabled');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(tracking.getMotionTrackingStatus()).toEqual({ configuration: 'disabled', enabled: false, pending: 0, retryAfterMs: 0 });
});

it('does not retry a server opt-out and allows a confirmed preference change to re-enable', async () => {
  const fetcher = vi.fn(async () => Response.json({ enabled: false })); vi.stubGlobal('fetch', fetcher);
  const tracking = await import('./tracking');
  expect(await tracking.trackMotion('ui_click', click)).toBe('disabled');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await tracking.trackMotion('ui_click', click)).toBe('disabled');
  expect(fetcher).toHaveBeenCalledTimes(1);
  tracking.setMotionTrackingEnabled(true);
  expect(await tracking.trackMotion('ui_click', click)).toBe('queued');
  await tracking.flushMotionTracking();
  expect(await tracking.trackMotion('ui_click', click)).toBe('disabled');
});

it('resumes reporting new events after repeated opt-out and re-enable cycles', async () => {
  const bodies: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    return Response.json({ enabled: true });
  }));
  const tracking = await import('./tracking');
  for (let cycle = 0; cycle < 3; cycle++) {
    tracking.setMotionTrackingEnabled(true);
    expect(await tracking.trackMotion('ui_click', click)).toBe('queued');
    expect(await tracking.flushMotionTracking()).toBe('accepted');
    expect(bodies).toHaveLength(cycle + 1);
    expect(await tracking.trackMotion('ui_click', click)).toBe('queued');
    tracking.setMotionTrackingEnabled(false);
    expect(await tracking.trackMotion('ui_click', click)).toBe('disabled');
    expect(await tracking.flushMotionTracking()).toBe('disabled');
    expect(tracking.getMotionTrackingStatus().pending).toBe(0);
  }
  expect(new Set(bodies.map(body => body.events[0].event_id)).size).toBe(3);
});

it('exposes safe queue and delivery statuses while rejecting private or non-Studio payloads', async () => {
  let failing = true;
  const fetcher = vi.fn(async (_url, init?: RequestInit) => init?.method === 'POST' && failing
    ? new Response('', { status: 503 }) : Response.json({ enabled: true }));
  vi.stubGlobal('fetch', fetcher);
  const tracking = await import('./tracking');
  expect(await tracking.trackMotion('ui_click', { ...click, prompt: 'PRIVATE_CONTENT' } as any)).toBe('invalid');
  expect(await tracking.trackMotion('mcp_tool_started' as any, {
    tool_name: 'motion_get_project', call_id: crypto.randomUUID(), accepted: true,
  } as any)).toBe('invalid');
  for (let i = 0; i < 64; i++) expect(await tracking.trackMotion('ui_click', click)).toBe('queued');
  expect(await tracking.trackMotion('ui_click', click)).toBe('full');
  expect(await tracking.flushMotionTracking()).toBe('retry');
  failing = false;
  expect(await tracking.flushMotionTracking()).toBe('accepted');
  expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toEqual(JSON.parse(fetcher.mock.calls[2][1]!.body as string));
  expect(JSON.stringify(tracking.getMotionTrackingStatus())).not.toMatch(/PRIVATE|prompt|properties/);
  tracking.setMotionTrackingEnabled(false);
  expect(await tracking.flushMotionTracking()).toBe('disabled');
  expect(tracking.getMotionTrackingStatus().pending).toBe(0);
});

const clearMetricsConsentCookie = () => { document.cookie = 'om_metrics_consent=; Max-Age=0; Path=/'; };

it('never treats cloud /motion-api/tracking enabled=true as device-ID consent and blocks odDeviceId passthrough until explicit consent', async () => {
  clearMetricsConsentCookie();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ enabled: true, locked: true, reason: 'cloud' })),
  );
  history.replaceState(
    null,
    '',
    '/explore?od_origin=open_design&od_entry_id=ent_1&od_entry_source=openmotion_manage_subscription&od_entry_at=2026-11-24T00:00:00.000Z&od_device_id=dev_should_not_leak',
  );
  const tracking = await import('./tracking');
  const { isMotionDeviceIdConsented } = await import('./trackingIdentity');
  const { collectOneTapAttribution } = await import('./googleOneTap');

  await tracking.initializeTracking();
  expect(tracking.getMotionTrackingStatus()).toMatchObject({ configuration: 'ready', enabled: true });
  expect(isMotionDeviceIdConsented()).toBe(false);

  const collected = collectOneTapAttribution();
  expect(collected.attribution.odEntry).toMatchObject({
    sourceProduct: 'open_design',
    entryId: 'ent_1',
    sourceDetail: 'openmotion_manage_subscription',
    entryOccurredAt: '2026-11-24T00:00:00.000Z',
  });
  expect(collected.attribution.odEntry).not.toHaveProperty('odDeviceId');
  expect(collected.attribution.odEntry).not.toHaveProperty('odDeviceIdConsent');
});

it('forwards odDeviceId into One Tap odEntry attribution only with the explicit consent cookie, including HTML-injected config', async () => {
  document.cookie = 'om_metrics_consent=granted; Path=/';
  const tag = document.createElement('script');
  tag.type = 'application/json';
  tag.id = 'openmotion-tracking-config';
  tag.textContent = JSON.stringify({ enabled: true, posthogEnabled: true, locked: true, reason: 'cloud', tracert: null });
  document.head.appendChild(tag);
  const fetcher = vi.fn(async () => Response.json({ enabled: true }));
  vi.stubGlobal('fetch', fetcher);
  history.replaceState(
    null,
    '',
    '/explore?od_origin=open_design&od_entry_id=ent_2&od_entry_source=openmotion_manage_subscription&od_entry_at=2026-11-24T00:00:00.000Z&od_device_id=dev_consented_1',
  );
  try {
    const tracking = await import('./tracking');
    const { isMotionDeviceIdConsented } = await import('./trackingIdentity');
    const { collectOneTapAttribution } = await import('./googleOneTap');

    await tracking.initializeTracking();
    expect(fetcher).not.toHaveBeenCalled();
    expect(isMotionDeviceIdConsented()).toBe(true);

    const collected = collectOneTapAttribution();
    expect(collected.attribution.odEntry).toMatchObject({
      sourceProduct: 'open_design',
      entryId: 'ent_2',
      odDeviceId: 'dev_consented_1',
      odDeviceIdConsent: true,
    });

    document.cookie = 'om_metrics_consent=denied; Path=/';
    expect(isMotionDeviceIdConsented()).toBe(false);
    expect(collectOneTapAttribution().attribution.odEntry).not.toHaveProperty('odDeviceId');
  } finally {
    tag.remove();
    clearMetricsConsentCookie();
  }
});

it('does not treat toggling usage-data sharing on via setMotionTrackingEnabled(true) as device-ID consent', async () => {
  clearMetricsConsentCookie();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ enabled: false, locked: true, reason: 'cloud' })),
  );
  history.replaceState(
    null,
    '',
    '/explore?od_origin=open_design&od_entry_id=ent_3&od_entry_source=openmotion_manage_subscription&od_entry_at=2026-11-24T00:00:00.000Z&od_device_id=dev_toggle_blocked',
  );
  const tracking = await import('./tracking');
  const { isMotionDeviceIdConsented } = await import('./trackingIdentity');
  const { collectOneTapAttribution } = await import('./googleOneTap');

  try {
    await tracking.initializeTracking();
    expect(isMotionDeviceIdConsented()).toBe(false);

    // Enabling usage-data sharing must NOT grant device-ID consent
    tracking.setMotionTrackingEnabled(true);
    expect(tracking.getMotionTrackingStatus()).toMatchObject({ configuration: 'ready', enabled: true });
    expect(isMotionDeviceIdConsented()).toBe(false);
    expect(collectOneTapAttribution().attribution.odEntry).not.toHaveProperty('odDeviceId');

    // Explicit device-ID consent enables it, turning sharing off clears it, turning it back on restores it,
    // and Do Not Track always wins.
    document.cookie = 'om_metrics_consent=granted; Path=/';
    expect(isMotionDeviceIdConsented()).toBe(true);
    tracking.setMotionTrackingEnabled(false);
    expect(isMotionDeviceIdConsented()).toBe(false);
    tracking.setMotionTrackingEnabled(true);
    expect(isMotionDeviceIdConsented()).toBe(true);
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    expect(isMotionDeviceIdConsented()).toBe(false);
  } finally {
    clearMetricsConsentCookie();
  }
});

it('reads HTML-injected runtime config with zero config GET and dual-reports identical event_id to PostHog and Tracert', async () => {
  const tag = document.createElement('script');
  tag.type = 'application/json';
  tag.id = 'openmotion-tracking-config';
  tag.textContent = JSON.stringify({
    enabled: true,
    posthogEnabled: true,
    locked: true,
    reason: 'cloud',
    tracert: { spmA: 99, endpoint: '/t/events', environment: 'prod', appVersion: '0.1.0' },
  });
  document.head.appendChild(tag);

  const posthogPayloads: Array<{ events: Array<{ event: string; event_id: string; occurred_at: string }> }> = [];
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.body) posthogPayloads.push(JSON.parse(String(init.body)));
    return Response.json({ ok: true, accepted: true });
  });
  vi.stubGlobal('fetch', fetcher);

  const tracertCaptures: Array<{ event: string; props: Record<string, unknown>; options: { uuid?: string; timestamp?: Date } }> = [];
  const tracertConsents: string[] = [];
  const tracertIdentifies: string[] = [];
  let tracertResets = 0;

  const tracertClient = await import('./tracertClient');
  tracertClient.setTracertSdkLoaderForTests(async () => ({
    Tracert: class {
      init() { return this; }
      capture(event: string, props: Record<string, unknown> = {}, options: { uuid?: string; timestamp?: Date } = {}) {
        tracertCaptures.push({ event, props, options });
      }
      identify(id: string) { tracertIdentifies.push(id); }
      reset() { tracertResets += 1; }
      setContext() {}
      clearContext() {}
      setConsent(state: string) { tracertConsents.push(state); }
      async flush() { return { status: 'confirmed' as const, accepted: 0, duplicate: 0, rejected: 0, dropped: 0, pending: 0 }; }
      destroy() {}
    },
  }));

  try {
    const tracking = await import('./tracking');
    tracking.syncMotionTrackingIdentity({
      signedIn: true,
      userId: 'app-user-dual-1',
      workspaceId: 'ext-ws-dual-1',
      workspaceRole: 'owner',
      planTier: 'plus',
    });

    expect(await tracking.trackMotion('ui_click', click)).toBe('queued');
    // Invalid private payload must be rejected for BOTH PostHog and Tracert.
    expect(await tracking.trackMotion('ui_click', { ...click, prompt: 'SECRET' } as any)).toBe('invalid');
    await tracking.flushMotionTracking();

    // Only 1 POST to /motion-api/tracking; zero GET /motion-api/tracking because HTML tag hydrated synchronously.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(posthogPayloads).toHaveLength(1);
    expect(posthogPayloads[0].events).toHaveLength(1);
    expect(tracertCaptures).toHaveLength(1);
    expect(tracertCaptures[0].event).toBe('ui_click');
    expect(tracertCaptures[0].options.uuid).toBe(posthogPayloads[0].events[0].event_id);
    expect(tracertCaptures[0].options.timestamp?.toISOString()).toBe(posthogPayloads[0].events[0].occurred_at);
    expect(tracertIdentifies).toEqual(['app-user-dual-1']);

    tracking.resetMotionTrackingIdentity();
    expect(tracertResets).toBe(1);

    tracking.setMotionTrackingEnabled(false);
    expect(tracertConsents).toContain('denied');
    tracking.resetMotionTrackingForTests();
  } finally {
    tag.remove();
  }
});

it('supports Tracert-only mode without posting batches to /motion-api/tracking', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      enabled: true,
      posthogEnabled: false,
      locked: true,
      reason: 'cloud',
      tracert: { spmA: 'openmotion-web', environment: 'test' },
    }),
  );
  vi.stubGlobal('fetch', fetcher);

  const tracertCaptures: Array<{ event: string; uuid?: string }> = [];
  const tracertClient = await import('./tracertClient');
  tracertClient.setTracertSdkLoaderForTests(async () => ({
    Tracert: class {
      init() { return this; }
      capture(event: string, _props?: Record<string, unknown>, options?: { uuid?: string }) {
        tracertCaptures.push({ event, uuid: options?.uuid });
      }
      identify() {}
      reset() {}
      setContext() {}
      clearContext() {}
      setConsent() {}
      async flush() { return { status: 'confirmed' as const, accepted: 0, duplicate: 0, rejected: 0, dropped: 0, pending: 0 }; }
      destroy() {}
    },
  }));

  const tracking = await import('./tracking');
  expect(await tracking.trackMotion('ui_click', click)).toBe('queued');
  expect(await tracking.flushMotionTracking()).toBe('accepted');
  // Only the initial GET /motion-api/tracking config call occurred; no POST batch sent to PostHog proxy.
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(tracertCaptures).toHaveLength(1);
  expect(tracertCaptures[0].event).toBe('ui_click');
  tracking.resetMotionTrackingForTests();
});

it('strictly enforces the shared cloud allowlist across BOTH PostHog and Tracert and attaches/rotates browser device_id', async () => {
  const posthogPayloads: Array<{ events: Array<{ event: string; event_id: string }>; device_id?: string }> = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && init.body) {
      posthogPayloads.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true, accepted: true });
    }
    return Response.json({
      enabled: true,
      posthogEnabled: true,
      allowlistEnabled: true,
      locked: true,
      reason: 'cloud',
      tracert: { spmA: 3, environment: 'test' },
    });
  });
  vi.stubGlobal('fetch', fetcher);

  const tracertCaptures: Array<{ event: string; uuid?: string }> = [];
  const tracertClient = await import('./tracertClient');
  tracertClient.setTracertSdkLoaderForTests(async () => ({
    Tracert: class {
      init() { return this; }
      capture(event: string, _props?: Record<string, unknown>, options?: { uuid?: string }) {
        tracertCaptures.push({ event, uuid: options?.uuid });
      }
      identify() {}
      reset() {}
      setContext() {}
      clearContext() {}
      setConsent() {}
      async flush() { return { status: 'confirmed' as const, accepted: 0, duplicate: 0, rejected: 0, dropped: 0, pending: 0 }; }
      destroy() {}
    },
  }));

  const tracking = await import('./tracking');
  // Non-allowlisted event & blocked card area must be dropped on BOTH PostHog and Tracert.
  expect(await tracking.trackMotion('playback', { action: 'play' })).toBe('disabled');
  expect(
    await tracking.trackMotion('surface_view', {
      page_name: 'explore',
      area: 'template_card',
      element: 'card',
    }),
  ).toBe('disabled');

  // Allowlisted event must pass BOTH sinks with matching event_id and a stable browser device_id.
  expect(await tracking.trackMotion('ui_click', click)).toBe('queued');
  await tracking.flushMotionTracking();

  expect(posthogPayloads).toHaveLength(1);
  expect(posthogPayloads[0].events.map((ev) => ev.event)).toEqual(['ui_click']);
  expect(tracertCaptures.map((ev) => ev.event)).toEqual(['ui_click']);
  expect(tracertCaptures[0].uuid).toBe(posthogPayloads[0].events[0].event_id);
  const firstDeviceId = posthogPayloads[0].device_id;
  expect(typeof firstDeviceId).toBe('string');
  expect(firstDeviceId!.length).toBeGreaterThanOrEqual(8);

  // Explicit sign-out rotates browser device_id so a subsequent user does not reuse the prior anonymous id.
  tracking.resetMotionTrackingIdentity();
  expect(await tracking.trackMotion('ui_click', click)).toBe('queued');
  await tracking.flushMotionTracking();
  expect(posthogPayloads).toHaveLength(2);
  expect(posthogPayloads[1].device_id).toBeTruthy();
  expect(posthogPayloads[1].device_id).not.toBe(firstDeviceId);

  tracking.resetMotionTrackingForTests();
});

it('discards unflushed browser events and cancels in-flight retries across sign-out and account switch boundaries', async () => {
  const delivered: Array<{ events: Array<{ event: string; properties: Record<string, unknown> }>; device_id?: string }> = [];
  let releaseInFlight: (() => void) | null = null;
  let postCall = 0;

  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && init.body) {
      postCall += 1;
      const parsed = JSON.parse(String(init.body)) as {
        events: Array<{ event: string; properties: Record<string, unknown> }>;
        device_id?: string;
      };
      if (postCall === 1) {
        // Hold Alice's in-flight request until an identity transition aborts it.
        await new Promise<void>((resolve, reject) => {
          releaseInFlight = resolve;
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      delivered.push(parsed);
      return Response.json({ ok: true, accepted: true });
    }
    return Response.json({
      enabled: true,
      posthogEnabled: true,
      allowlistEnabled: true,
      locked: true,
      reason: 'cloud',
    });
  });
  vi.stubGlobal('fetch', fetcher);

  const tracking = await import('./tracking');
  await tracking.initializeTracking();

  // 1. Alice signs in and queues an event without flushing.
  tracking.syncMotionTrackingIdentity({ signedIn: true, userId: 'amr_alice', workspaceId: 'ws_alice' });
  expect(await tracking.trackMotion('ui_click', click)).toBe('queued');
  expect(tracking.getMotionTrackingStatus().pending).toBe(1);

  // Alice signs out before flush: her queued event MUST be discarded rather than
  // flushed later under the rotated device_id or Bob's session cookie.
  tracking.resetMotionTrackingIdentity();
  expect(tracking.getMotionTrackingStatus().pending).toBe(0);
  expect(await tracking.flushMotionTracking()).toBe('empty');
  expect(delivered).toHaveLength(0);

  // 2. Alice signs in again, starts an in-flight flush, and account switches to Bob mid-flight.
  tracking.syncMotionTrackingIdentity({ signedIn: true, userId: 'amr_alice', workspaceId: 'ws_alice' });
  expect(await tracking.trackMotion('ui_click', { page_name: 'home', area: 'workspace', element: 'open_project' })).toBe('queued');
  const aliceFlush = tracking.flushMotionTracking();
  await Promise.resolve();

  tracking.syncMotionTrackingIdentity({ signedIn: true, userId: 'amr_bob', workspaceId: 'ws_bob' });
  releaseInFlight?.();
  expect(await aliceFlush).toBe('drop');
  expect(tracking.getMotionTrackingStatus().pending).toBe(0);

  // Flushing after the switch does NOT retry Alice's aborted event.
  expect(await tracking.flushMotionTracking()).toBe('empty');
  expect(delivered).toHaveLength(0);

  // Bob's own event flushes cleanly.
  expect(await tracking.trackMotion('ui_click', { page_name: 'studio', area: 'workspace', element: 'export' })).toBe('queued');
  expect(await tracking.flushMotionTracking()).toBe('accepted');
  expect(delivered).toHaveLength(1);
  expect(delivered[0].events.map((ev) => ev.properties.element)).toEqual(['export']);

  tracking.resetMotionTrackingForTests();
});
