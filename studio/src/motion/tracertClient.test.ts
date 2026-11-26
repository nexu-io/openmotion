// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureTracertEvent,
  configureTracert,
  flushTracert,
  getTracertStatus,
  resetTracertForTests,
  resetTracertIdentity,
  sanitizeTracertProperties,
  setTracertEnabled,
  setTracertSdkLoaderForTests,
  syncTracertIdentity,
  type TracertClientLike,
} from './tracertClient';

function createFakeTracertModule() {
  const calls = {
    init: [] as unknown[],
    capture: [] as Array<{ event: string; props: unknown; options: unknown }>,
    identify: [] as Array<{ id: string; traits: unknown }>,
    reset: 0,
    setContext: [] as Array<{ scope: string; props: unknown }>,
    clearContext: [] as string[],
    setConsent: [] as string[],
    flush: 0,
    destroy: 0,
  };

  class FakeTracert implements TracertClientLike {
    init(config: unknown) {
      calls.init.push(config);
      return this;
    }
    capture(event: string, props?: Record<string, unknown>, options?: unknown) {
      calls.capture.push({ event, props, options });
      return { status: 'accepted', id: 'fake-id' };
    }
    identify(id: string, traits?: Record<string, unknown>) {
      calls.identify.push({ id, traits });
    }
    reset() {
      calls.reset += 1;
    }
    setContext(scope: string, props: Record<string, unknown>) {
      calls.setContext.push({ scope, props });
    }
    clearContext(scope: string) {
      calls.clearContext.push(scope);
    }
    setConsent(consent: string) {
      calls.setConsent.push(consent);
    }
    async flush() {
      calls.flush += 1;
      return { status: 'confirmed' as const, accepted: 0, duplicate: 0, rejected: 0, dropped: 0, pending: 0 };
    }
    destroy() {
      calls.destroy += 1;
    }
  }

  return { calls, mod: { Tracert: FakeTracert } };
}

beforeEach(() => {
  resetTracertForTests();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  resetTracertForTests();
  Reflect.deleteProperty(navigator, 'doNotTrack');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('tracertClient adapter', () => {
  it('never loads the SDK when unconfigured (self-hosted default)', () => {
    const loader = vi.fn(async () => createFakeTracertModule().mod);
    setTracertSdkLoaderForTests(loader);

    configureTracert(null, true);
    captureTracertEvent('ui_click', { page_name: 'home', area: 'header', element: 'open_pricing' }, {
      eventId: crypto.randomUUID(),
      occurredAt: new Date(),
    });

    expect(loader).not.toHaveBeenCalled();
    expect(getTracertStatus()).toEqual({ configured: false, loaded: false, enabled: false, queued: 0 });
  });

  it('strips undefined and non-finite property values defensively', () => {
    expect(
      sanitizeTracertProperties({
        page_name: 'explore',
        area: 'hub_videos',
        hub_id: undefined,
        position: 2,
        bad_nan: Number.NaN,
        bad_inf: Number.POSITIVE_INFINITY,
        signed_in: true,
        nullable: null,
        nested_ignored: { a: 1 },
      }),
    ).toEqual({
      page_name: 'explore',
      area: 'hub_videos',
      position: 2,
      signed_in: true,
      nullable: null,
    });
  });

  it('buffers early events and identity while the SDK chunk loads, and replays in order', async () => {
    const { calls, mod } = createFakeTracertModule();
    let resolveLoad!: (value: typeof mod) => void;
    setTracertSdkLoaderForTests(
      () => new Promise<typeof mod>((resolve) => { resolveLoad = resolve; }),
    );

    configureTracert({ spmA: 42, environment: 'prod', appVersion: '0.1.0' }, true);
    syncTracertIdentity({
      signedIn: true,
      userId: 'app-user-123',
      workspaceId: 'ext-ws-9',
      workspaceRole: 'owner',
      planTier: 'plus',
    });

    const eventId = '11111111-1111-4111-8111-111111111111';
    const occurredAt = new Date('2026-11-26T04:00:00.000Z');
    captureTracertEvent(
      'ui_click',
      { page_name: 'explore', area: 'hub_videos', element: 'open_detail', hub_id: undefined },
      { eventId, occurredAt },
    );

    expect(getTracertStatus()).toMatchObject({ configured: true, loaded: false, enabled: true });

    resolveLoad(mod);
    await flushTracert();

    expect(calls.init).toHaveLength(1);
    expect(calls.init[0]).toMatchObject({
      spmA: 42,
      environment: 'prod',
      appVersion: '0.1.0',
      enabled: true,
      consent: { initial: 'granted' },
      plugins: [],
    });
    // Explicitly force-syncs consent after init and sets runtime context.
    expect(calls.setConsent).toEqual(['granted']);
    expect(calls.setContext[0]?.scope).toBe('runtime');
    expect(calls.setContext[0]?.props).toMatchObject({
      product: 'openmotion',
      entrypoint: 'studio',
      runtime: 'browser',
      capture_source: 'explicit',
      env: 'prod',
      app_version: '0.1.0',
    });

    // Replayed identity + deduplicated user context + sanitized capture with matching eventId.
    expect(calls.identify).toEqual([{ id: 'app-user-123', traits: undefined }]);
    expect(calls.setContext.find((entry) => entry.scope === 'user')?.props).toEqual({
      workspace_id: 'ext-ws-9',
      workspace_role: 'owner',
      plan_tier: 'plus',
    });
    expect(calls.capture).toEqual([
      {
        event: 'ui_click',
        props: { page_name: 'explore', area: 'hub_videos', element: 'open_detail' },
        options: { uuid: eventId, timestamp: occurredAt },
      },
    ]);

    // Session expiry after authentication clears user context AND resets SDK identity once,
    // while a subsequent signed-out update while already anonymous does NOT call reset() again.
    syncTracertIdentity({ signedIn: false });
    expect(calls.reset).toBe(1);
    expect(calls.clearContext).toContain('user');

    syncTracertIdentity({ signedIn: false });
    expect(calls.reset).toBe(1);

    // Explicit sign-out calls reset().
    resetTracertIdentity();
    expect(calls.reset).toBe(2);

    // Disabling calls setConsent('denied') to wipe memory + cross-page outbox.
    setTracertEnabled(false);
    expect(calls.setConsent).toEqual(['granted', 'denied']);
  });

  it('preserves in-flight initialization for equivalent configs and restarts load when config genuinely changes', async () => {
    const first = createFakeTracertModule();
    const second = createFakeTracertModule();
    const resolvers: Array<(value: typeof first.mod) => void> = [];
    const loader = vi.fn(
      () => new Promise<typeof first.mod>((resolve) => {
        resolvers.push(resolve);
      }),
    );
    setTracertSdkLoaderForTests(loader);

    // Simulate account hydration parsing the injected config tag first, then tracking init
    // parsing the exact same tag into a second distinct object while import() is still pending.
    configureTracert({ spmA: 3, environment: 'test', appVersion: '0.1.0' }, true);
    syncTracertIdentity({ signedIn: true, userId: 'app-user-race', workspaceId: 'ws-race' });
    configureTracert({ spmA: 3, environment: 'test', appVersion: '0.1.0' }, true);
    const eventId = '33333333-3333-4333-8333-333333333333';
    captureTracertEvent('session_start', {}, { eventId, occurredAt: new Date('2026-11-26T09:00:00.000Z') });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(resolvers).toHaveLength(1);
    resolvers[0]!(first.mod);
    await flushTracert();

    expect(getTracertStatus()).toEqual({ configured: true, loaded: true, enabled: true, queued: 0 });
    expect(first.calls.init).toHaveLength(1);
    expect(first.calls.identify).toEqual([{ id: 'app-user-race', traits: undefined }]);
    expect(first.calls.capture).toHaveLength(1);

    // Now test genuinely changed config while a load is in flight: stale import must be ignored
    // and the new config must start a fresh load immediately.
    resetTracertForTests();
    resolvers.length = 0;
    loader.mockClear();
    setTracertSdkLoaderForTests(loader);

    configureTracert({ spmA: 3, environment: 'test', appVersion: '0.1.0' }, true);
    configureTracert({ spmA: 99, environment: 'prod', appVersion: '0.2.0' }, true);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(resolvers).toHaveLength(2);

    // Resolve stale first load first (must be ignored), then resolve second load.
    resolvers[0]!(first.mod);
    await Promise.resolve();
    expect(getTracertStatus().loaded).toBe(false);

    resolvers[1]!(second.mod);
    await flushTracert();
    expect(getTracertStatus()).toMatchObject({ configured: true, loaded: true, enabled: true });
    expect(second.calls.init).toHaveLength(1);
    expect(second.calls.init[0]).toMatchObject({ spmA: 99, environment: 'prod', appVersion: '0.2.0' });
  });

  it('integrates cleanly with the real @powerformer/tracert SDK over Collector v1', async () => {
    const sentRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as {
          batch?: Array<{ id: string }>;
        };
        sentRequests.push({ url: String(url), body: parsed });
        const results = (parsed.batch ?? []).map((item, index) => ({
          index,
          id: item.id,
          status: 'accepted',
        }));
        return new Response(
          JSON.stringify({ schema_version: 1, request_id: `req-${sentRequests.length}`, results }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }),
    );

    const realMod = await import('@powerformer/tracert');
    setTracertSdkLoaderForTests(async () => realMod as unknown as { Tracert: new () => TracertClientLike });

    configureTracert(
      { spmA: 77, endpoint: 'http://127.0.0.1:4173/t/events', environment: 'test', appVersion: '0.1.0-test' },
      true,
    );
    await flushTracert();

    const eventId = '22222222-2222-4222-8222-222222222222';
    const occurredAt = new Date('2026-11-26T04:10:00.000Z');
    syncTracertIdentity({
      signedIn: true,
      userId: 'app-user-real-1',
      workspaceId: 'ext-ws-real-1',
      workspaceRole: 'editor',
      planTier: 'pro',
    });
    captureTracertEvent(
      'ui_click',
      { page_name: 'explore', area: 'hub_videos', element: 'open_detail', hub_id: undefined },
      { eventId, occurredAt },
    );

    await flushTracert();

    expect(sentRequests.length).toBeGreaterThanOrEqual(1);
    expect(sentRequests[0]?.url).toBe('http://127.0.0.1:4173/t/events');
    const envelopes = sentRequests.flatMap((req) => (req.body.batch as Array<Record<string, unknown>>) ?? []);
    const identifyEnv = envelopes.find((env) => env.type === 'identify');
    const captureEnv = envelopes.find((env) => env.type === 'capture' && env.event === 'ui_click');

    expect(identifyEnv).toBeDefined();
    expect((identifyEnv?.identity as Record<string, unknown>)?.user_id).toBe('app-user-real-1');

    expect(captureEnv).toBeDefined();
    expect(captureEnv?.id).toBe(eventId);
    expect(captureEnv?.occurred_at).toBe(occurredAt.toISOString());
    expect((captureEnv?.identity as Record<string, unknown>)?.user_id).toBe('app-user-real-1');
    expect((captureEnv?.identity as Record<string, unknown>)?.device_id).toBeTruthy();
    expect(captureEnv?.properties).toMatchObject({
      product: 'openmotion',
      entrypoint: 'studio',
      env: 'test',
      app_version: '0.1.0-test',
      workspace_id: 'ext-ws-real-1',
      workspace_role: 'editor',
      plan_tier: 'pro',
      page_name: 'explore',
      area: 'hub_videos',
      element: 'open_detail',
    });
    expect('hub_id' in (captureEnv?.properties as Record<string, unknown>)).toBe(false);
  });

  it('clears persisted SDK user_id on session expiry (same-tab and across reloads) while preserving anonymous reload continuity', async () => {
    const envelopes: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as {
          batch?: Array<{ id: string } & Record<string, unknown>>;
        };
        const batch = parsed.batch ?? [];
        envelopes.push(...batch);
        return new Response(
          JSON.stringify({
            schema_version: 1,
            request_id: `req-${envelopes.length}`,
            results: batch.map((item, index) => ({ index, id: item.id, status: 'accepted' })),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const realMod = await import('@powerformer/tracert');
    const config = {
      spmA: 3,
      endpoint: 'http://127.0.0.1:4173/t/events',
      environment: 'test' as const,
      appVersion: '0.1.0-test',
    };
    const simulatePageReload = () => {
      const persisted = Array.from({ length: localStorage.length }, (_, i) => {
        const key = localStorage.key(i)!;
        return [key, localStorage.getItem(key)!] as const;
      });
      resetTracertForTests();
      localStorage.clear();
      for (const [k, v] of persisted) localStorage.setItem(k, v);
      setTracertSdkLoaderForTests(async () => realMod as unknown as { Tracert: new () => TracertClientLike });
      configureTracert(config, true);
    };

    // 1. Genuinely anonymous visitor: reload while signed out keeps the same device_id & anonymous_id.
    setTracertSdkLoaderForTests(async () => realMod as unknown as { Tracert: new () => TracertClientLike });
    configureTracert(config, true);
    await flushTracert();
    syncTracertIdentity({ signedIn: false });
    const anonId1 = '44444444-4444-4444-8444-444444444441';
    captureTracertEvent('session_start', {}, { eventId: anonId1, occurredAt: new Date() });
    await flushTracert();

    simulatePageReload();
    await flushTracert();
    syncTracertIdentity({ signedIn: false });
    const anonId2 = '44444444-4444-4444-8444-444444444442';
    captureTracertEvent('session_start', {}, { eventId: anonId2, occurredAt: new Date() });
    await flushTracert();

    const anonEv1 = envelopes.find((e) => e.id === anonId1)?.identity as Record<string, unknown>;
    const anonEv2 = envelopes.find((e) => e.id === anonId2)?.identity as Record<string, unknown>;
    expect(anonEv1.user_id).toBeNull();
    expect(anonEv2.user_id).toBeNull();
    expect(anonEv2.device_id).toBe(anonEv1.device_id);
    expect(anonEv2.anonymous_id).toBe(anonEv1.anonymous_id);

    // 2. Alice signs in, then session expires in the same tab without clicking Sign Out.
    syncTracertIdentity({
      signedIn: true,
      userId: 'amr_alice_expiry',
      workspaceId: 'ws_alice',
      workspaceRole: 'owner',
      planTier: 'pro',
    });
    const aliceEvId = '44444444-4444-4444-8444-444444444443';
    captureTracertEvent('session_start', {}, { eventId: aliceEvId, occurredAt: new Date() });
    await flushTracert();
    expect((envelopes.find((e) => e.id === aliceEvId)?.identity as Record<string, unknown>).user_id).toBe(
      'amr_alice_expiry',
    );

    syncTracertIdentity({ signedIn: false });
    const afterSameTabExpiryId = '44444444-4444-4444-8444-444444444444';
    captureTracertEvent('session_start', {}, { eventId: afterSameTabExpiryId, occurredAt: new Date() });
    await flushTracert();
    const afterSameTab = envelopes.find((e) => e.id === afterSameTabExpiryId);
    expect((afterSameTab?.identity as Record<string, unknown>).user_id).toBeNull();
    expect((afterSameTab?.properties as Record<string, unknown>).workspace_id).toBeUndefined();

    // 3. Alice signs in again, page reloads with persisted storage, and server reports session expired.
    syncTracertIdentity({ signedIn: true, userId: 'amr_alice_expiry', workspaceId: 'ws_alice' });
    await flushTracert();

    simulatePageReload();
    await flushTracert();
    syncTracertIdentity({ signedIn: false });
    const afterReloadExpiryId = '44444444-4444-4444-8444-444444444445';
    captureTracertEvent('session_start', {}, { eventId: afterReloadExpiryId, occurredAt: new Date() });
    await flushTracert();
    const afterReloadExpiry = envelopes.find((e) => e.id === afterReloadExpiryId)?.identity as Record<string, unknown>;
    expect(afterReloadExpiry.user_id).toBeNull();

    // 4. Another reload while still signed out preserves the new anonymous device_id without resetting again.
    simulatePageReload();
    await flushTracert();
    syncTracertIdentity({ signedIn: false });
    const afterSecondAnonReloadId = '44444444-4444-4444-8444-444444444446';
    captureTracertEvent('session_start', {}, { eventId: afterSecondAnonReloadId, occurredAt: new Date() });
    await flushTracert();
    const afterSecondAnonReload = envelopes.find((e) => e.id === afterSecondAnonReloadId)?.identity as Record<string, unknown>;
    expect(afterSecondAnonReload.user_id).toBeNull();
    expect(afterSecondAnonReload.device_id).toBe(afterReloadExpiry.device_id);
  });
});
