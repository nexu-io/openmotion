import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MessageCenterRequestError,
  MessageCenterService,
  type MessageCenterAccountClient,
} from '../gateway/message-center.ts';
import { TouchpointRequestError, TouchpointService } from '../gateway/touchpoints.ts';
import { WhatsNewService } from '../gateway/whats-new.ts';
import { localizeWhatsNewContent } from '../shared/growth-surfaces.ts';
import { buildSocialSharePayload, normalizeFeedbackText } from '../shared/social-share.ts';
import { validProperties } from '../tracking/core.ts';
import { studioEvents } from '../tracking/events.ts';
import { fixture } from './fixtures.ts';
import { transport } from './http.ts';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('MessageCenterService handles signed-in pagination, link sanitization, loop guards, anonymous reads, and upstream failures', async () => {
  let signedIn = true;
  const authHeaders: Array<string | null> = [];
  const account: MessageCenterAccountClient = {
    async getControlSession() {
      return signedIn
        ? { apiUrl: 'https://amr-api.open-design.ai', controlKey: 'ctrl_secret', controlKeyId: 'ck_1' }
        : null;
    },
  };

  let mode: 'paginated' | 'loop' | 'fail500' = 'paginated';
  const service = new MessageCenterService(account, {
    publicApiUrl: 'https://amr-api.open-design.ai',
    fetcher: (async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      const headers = new Headers(init?.headers);
      authHeaders.push(headers.get('authorization'));

      if (mode === 'fail500') return jsonRes({ error: 'down' }, 503);
      if (mode === 'loop') {
        return jsonRes({
          messages: [{ id: 'm1', audienceType: 'global', typeName: 'update', title: 'Loop', body: 'B', publishedAt: '2026-11-01T00:00:00Z', readAt: null, ctaLabel: null, ctaUrl: null }],
          nextCursor: 'same_cursor',
        });
      }

      if (urlStr.includes('/read-all')) return jsonRes({ ok: true });
      if (urlStr.includes('/messages/m1/read')) return jsonRes({ ok: true });

      const parsed = new URL(urlStr);
      const cursor = parsed.searchParams.get('cursor');
      if (!cursor) {
        return jsonRes({
          messages: [
            {
              id: 'm1',
              audienceType: 'targeted',
              messageKey: 'go-plan-sunset-2026-08',
              typeName: 'billing',
              title: 'Go Plan Sunset',
              body: 'Migrate to Plus.',
              imageUrl: 'http://insecure.example/cover.png',
              ctaLabel: 'Open',
              ctaUrl: 'javascript:alert(1)',
              publishedAt: '2026-11-20T00:00:00Z',
              readAt: null,
            },
          ],
          nextCursor: 'page_2',
        });
      }
      return jsonRes({
        messages: [
          {
            id: 'm2',
            audienceType: 'global',
            typeName: 'release',
            title: 'Release Notes',
            body: 'Details here.',
            imageUrl: 'https://cdn.open-design.ai/img.png',
            ctaLabel: 'Read notes',
            ctaUrl: 'https://open-design.ai/changelog',
            publishedAt: '2026-11-19T00:00:00Z',
            readAt: '2026-11-19T01:00:00Z',
          },
        ],
        nextCursor: null,
      });
    }) as typeof fetch,
  });

  // Signed-in 2-page fetch + sanitization
  const feed = await service.listMessages('en');
  assert.equal(feed.signedIn, true);
  assert.equal(feed.messages.length, 2);
  assert.equal(feed.unreadCount, 1);
  assert.equal(authHeaders[0], 'Bearer ctrl_secret');
  assert.equal(feed.messages[0].imageUrl, undefined);
  assert.equal(feed.messages[0].ctaUrl, null);
  assert.equal(feed.messages[0].ctaLabel, null);
  assert.equal(feed.messages[1].imageUrl, 'https://cdn.open-design.ai/img.png');
  assert.equal(feed.messages[1].ctaUrl, 'https://open-design.ai/changelog');

  // Signed-in markRead + markAllRead
  assert.deepEqual(await service.markRead('m1'), { ok: true });
  assert.deepEqual(await service.markAllRead(), { ok: true });

  // Signed-out public fetch omits auth header, and write operations reject with 401
  signedIn = false;
  authHeaders.length = 0;
  const publicFeed = await service.listMessages('zh-CN');
  assert.equal(publicFeed.signedIn, false);
  assert.equal(authHeaders[0], null);
  await assert.rejects(() => service.markRead('m1'), (err: unknown) =>
    err instanceof MessageCenterRequestError && err.status === 401,
  );
  await assert.rejects(() => service.markAllRead(), (err: unknown) =>
    err instanceof MessageCenterRequestError && err.status === 401,
  );

  // Cursor loop guard
  signedIn = true;
  mode = 'loop';
  await assert.rejects(() => service.listMessages('en'), (err: unknown) =>
    err instanceof MessageCenterRequestError && err.status === 502 && err.code === 'message_center_unavailable',
  );

  // Upstream 5xx fails cleanly with 502
  mode = 'fail500';
  await assert.rejects(() => service.listMessages('en'), (err: unknown) =>
    err instanceof MessageCenterRequestError && err.status === 502,
  );
});

test('TouchpointService caches per scope, replays unexpired on 5xx, and purges immediately on 410 revocation or 401/403', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'om-touchpoints-test-'));
  try {
    let nowMs = Date.parse('2026-11-24T12:00:00Z');
    let currentKeyId = 'ck_scope_a';
    let upstreamMode: 'active' | '503' | '410' | '404' | '401' | 'network_err' = 'active';
    let currentEndsAt = '2026-11-25T12:00:00Z';

    const service = new TouchpointService(
      {
        root: dir,
        async getControlSession() {
          return {
            apiUrl: 'https://amr-api.open-design.ai',
            controlKey: `secret_${currentKeyId}`,
            controlKeyId: currentKeyId,
          };
        },
      },
      {
        now: () => nowMs,
        fetcher: (async (url: string | URL) => {
          if (String(url).includes('/events')) {
            if (upstreamMode === 'network_err') throw new Error('ECONNRESET');
            return jsonRes({ ok: true });
          }
          if (upstreamMode === 'network_err') throw new Error('ENETDOWN');
          if (upstreamMode === '503') return jsonRes({ error: 'unavailable' }, 503);
          if (upstreamMode === '404') return jsonRes({}, 404);
          if (upstreamMode === '401') return jsonRes({}, 401);
          if (upstreamMode === '410') return jsonRes({ activityId: 'act_ds_flash' }, 410);
          return jsonRes({
            activityId: 'act_ds_flash',
            touchpointDecisionId: 'dec_1',
            deploymentId: 'dep_1',
            placementKey: 'opend.home.campaign-modal',
            endsAt: currentEndsAt,
            staticActions: [
              { id: 'upgrade', target: { kind: 'https', url: 'https://open-design.ai/pricing' } },
              { id: 'internal', target: { kind: 'internal', path: '/agent' } },
            ],
            content: {
              id: 'dec_1',
              placementKey: 'opend.home.campaign-modal',
              badgeLabel: 'Flash Deal',
              title: 'Try DeepSeek V4.1 Flash',
              body: 'Fastest creative agent turn-around.',
              highlights: ['2x faster responses', 'Included in Plus & Pro'],
              paidCtaLabel: 'Use DeepSeek V4.1 Flash',
              freeCtaLabel: 'Upgrade plan',
              targetModelId: 'deepseek-v4-flash',
              targetModelLabel: 'DeepSeek V4.1 Flash',
            },
          });
        }) as typeof fetch,
      },
    );

    // 1. Live 200 populates cache
    const live = await service.getProductionTouchpoint({
      placementKey: 'opend.home.campaign-modal',
      locale: 'en',
    });
    assert.equal(live.status, 'active');
    assert.equal(live.offlineReplay, false);
    assert.equal(live.decision?.badgeLabel, 'Flash Deal');
    assert.equal(live.decision?.ctaUrl, 'https://open-design.ai/pricing');
    assert.equal(live.decision?.internalPath, '/agent');

    // 2. Scope isolation: distinct account scope sees 503 -> none (cannot read Scope A cache)
    currentKeyId = 'ck_scope_b';
    upstreamMode = '503';
    const otherScope = await service.getProductionTouchpoint({
      placementKey: 'opend.home.campaign-modal',
      locale: 'en',
    });
    assert.equal(otherScope.status, 'none');
    assert.equal(otherScope.decision, null);

    // 3. Back on Scope A during 503 outage -> replays cached unexpired decision
    currentKeyId = 'ck_scope_a';
    const replayed = await service.getProductionTouchpoint({
      placementKey: 'opend.home.campaign-modal',
      locale: 'en',
    });
    assert.equal(replayed.status, 'active');
    assert.equal(replayed.offlineReplay, true);
    assert.equal(replayed.decision?.touchpointDecisionId, 'dec_1');

    // 4. 410 revocation immediately purges cache and NEVER replays afterward
    upstreamMode = '410';
    const revoked = await service.getProductionTouchpoint({
      placementKey: 'opend.home.campaign-modal',
      locale: 'en',
    });
    assert.equal(revoked.status, 'revoked');
    assert.equal(revoked.decision, null);
    upstreamMode = '503';
    const afterRevoked = await service.getProductionTouchpoint({
      placementKey: 'opend.home.campaign-modal',
      locale: 'en',
    });
    assert.equal(afterRevoked.status, 'none');

    // 5. Expiry suppresses offline replay once now > endsAt
    upstreamMode = 'active';
    currentEndsAt = '2026-11-24T13:00:00Z';
    await service.getProductionTouchpoint({ placementKey: 'opend.home.campaign-modal', locale: 'en' });
    nowMs = Date.parse('2026-11-24T13:05:00Z');
    upstreamMode = '503';
    const expired = await service.getProductionTouchpoint({
      placementKey: 'opend.home.campaign-modal',
      locale: 'en',
    });
    assert.equal(expired.status, 'none');
    assert.equal(expired.decision, null);

    // 6. 401 clears cache and returns unauthorized
    nowMs = Date.parse('2026-11-24T12:00:00Z');
    upstreamMode = 'active';
    await service.getProductionTouchpoint({ placementKey: 'opend.home.campaign-modal', locale: 'en' });
    upstreamMode = '401';
    const unauth = await service.getProductionTouchpoint({
      placementKey: 'opend.home.campaign-modal',
      locale: 'en',
    });
    assert.equal(unauth.status, 'unauthorized');
    upstreamMode = '503';
    assert.equal(
      (await service.getProductionTouchpoint({ placementKey: 'opend.home.campaign-modal', locale: 'en' })).status,
      'none',
    );

    // 7. Invalid placement rejected with 400; telemetry tolerates network failure
    await assert.rejects(
      () => service.getProductionTouchpoint({ placementKey: 'unknown.slot', locale: 'en' }),
      (err: unknown) => err instanceof TouchpointRequestError && err.status === 400,
    );
    assert.deepEqual(
      await service.reportTouchpointEvent({
        activityId: 'act_1',
        touchpointDecisionId: 'dec_1',
        placementKey: 'opend.home.campaign-modal',
        eventType: 'impression',
      }),
      { ok: true },
    );
    upstreamMode = 'network_err';
    assert.deepEqual(
      await service.reportTouchpointEvent({
        activityId: 'act_1',
        touchpointDecisionId: 'dec_1',
        placementKey: 'opend.home.campaign-modal',
        eventType: 'click',
      }),
      { ok: false },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("WhatsNewService honors channel gating, validates schema/HTTPS links, and localizes docs/whats-new.json", async () => {
  // Default packaged environment serves the shipped docs/whats-new.json.
  const defaultPackaged = new WhatsNewService({ env: {}, version: '1.2.3' });
  const defaultRes = await defaultPackaged.readWhatsNew();
  assert.equal(defaultRes.version, '1.2.3');
  assert.ok(defaultRes.id);
  assert.ok(defaultRes.content);

  // Explicit opt-out or non-release channel disables What's New.
  const optedOut = new WhatsNewService({ env: { OPENMOTION_WHATS_NEW_ENABLED: '0' } });
  const optedOutRes = await optedOut.readWhatsNew();
  assert.equal(optedOutRes.id, null);
  assert.equal(optedOutRes.content, null);

  const devChannel = new WhatsNewService({ env: { OPENMOTION_RELEASE_CHANNEL: 'dev' } });
  const devRes = await devChannel.readWhatsNew();
  assert.equal(devRes.id, null);
  assert.equal(devRes.content, null);

  const localStable = new WhatsNewService({
    env: { OPENMOTION_RELEASE_CHANNEL: 'stable' },
    version: '1.2.3',
  });
  const localRes = await localStable.readWhatsNew();
  assert.equal(localRes.version, '1.2.3');
  assert.ok(localRes.id);
  assert.ok(localRes.content);
  const zh = localizeWhatsNewContent(localRes.content!, 'zh-CN');
  assert.ok(zh.notes.length >= 2);
  assert.ok(zh.title.length > 0);

  // Remote override with schema degradation on insecure URL / malformed document
  let remotePayload: unknown = {
    id: 'rel_1',
    title: 'Remote Title',
    body: '- Line A\n- Line B',
    linkUrl: 'http://insecure.example/notes',
    imageUrl: 'javascript:alert(1)',
  };
  const remoteSvc = new WhatsNewService({
    env: { OPENMOTION_WHATS_NEW_URL: 'https://updates.example/whats-new.json' },
    cacheTtlMs: 0,
    fetcher: (async () => jsonRes(remotePayload)) as typeof fetch,
  });
  const remoteOk = await remoteSvc.readWhatsNew();
  assert.equal(remoteOk.id, 'rel_1');
  assert.equal(remoteOk.content?.linkUrl, undefined);
  assert.equal(remoteOk.content?.imageUrl, undefined);
  assert.deepEqual(localizeWhatsNewContent(remoteOk.content!, 'en').notes, ['Line A', 'Line B']);

  remotePayload = { title: 'Missing ID', body: 'No ID' };
  const malformed = await remoteSvc.readWhatsNew();
  assert.equal(malformed.id, null);
  assert.equal(malformed.content, null);
});

test('server.ts exposes /api/message-center/*, /api/touchpoints/*, and /api/whats-new routes', () =>
  fixture(async store => {
    const req = transport(store);

    const whatsNew = await req('/motion-api/whats-new');
    assert.equal(whatsNew.status, 200);
    const whatsNewJson = await whatsNew.json();
    assert.ok(whatsNewJson.id);
    assert.ok(whatsNewJson.content);

    const invalidTp = await req('/motion-api/touchpoints/production?placementKey=bad.slot');
    assert.equal(invalidTp.status, 400);

    const signedOutTp = await req('/motion-api/touchpoints/production?placementKey=opend.home.campaign-modal');
    assert.equal(signedOutTp.status, 200);
    assert.equal((await signedOutTp.json()).status, 'unauthorized');

    const badEvent = await req('/motion-api/touchpoints/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'invalid' }),
    });
    assert.equal(badEvent.status, 400);

    const signedOutReadAll = await req('/motion-api/message-center/read-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(signedOutReadAll.status, 401);
  }));

test('experience_survey_event schema and feedback_text rule enforce bounds and enums', () => {
  assert.equal(
    validProperties(studioEvents, 'experience_survey_event', {
      action: 'shown',
      trigger: 'post_deliverable',
    }),
    true,
  );

  const maxNote = 'x'.repeat(240);
  assert.equal(
    validProperties(studioEvents, 'experience_survey_event', {
      action: 'submitted',
      trigger: 'post_generation',
      score: 9,
      improvement: 'visual_quality',
      feedback_text: maxNote,
    }),
    true,
  );

  for (const imp of [
    'wrong_output',
    'incomplete_output',
    'hard_to_use',
    'stuck_or_failed',
    'too_slow',
    'visual_quality',
    'other',
  ] as const) {
    assert.equal(
      validProperties(studioEvents, 'experience_survey_event', {
        action: 'submitted',
        trigger: 'post_export',
        score: 7,
        improvement: imp,
      }),
      true,
    );
  }

  // Reject out-of-range score, unknown improvement, oversized text, and control characters
  assert.equal(
    validProperties(studioEvents, 'experience_survey_event', {
      action: 'submitted',
      trigger: 'post_generation',
      score: 11,
    }),
    false,
  );
  assert.equal(
    validProperties(studioEvents, 'experience_survey_event', {
      action: 'submitted',
      trigger: 'post_generation',
      improvement: 'unknown_chip',
    }),
    false,
  );
  assert.equal(
    validProperties(studioEvents, 'experience_survey_event', {
      action: 'submitted',
      trigger: 'post_generation',
      feedback_text: 'a'.repeat(241),
    }),
    false,
  );
  assert.equal(
    validProperties(studioEvents, 'experience_survey_event', {
      action: 'submitted',
      trigger: 'post_generation',
      feedback_text: 'bad\ncontrol',
    }),
    false,
  );
});

test('social share helpers sanitize unsafe URLs, normalize notes, and order platforms by locale', () => {
  assert.equal(normalizeFeedbackText('   \n\t  '), undefined);
  assert.equal(normalizeFeedbackText('  Great\nrender\tquality!  '), 'Great render quality!');
  assert.equal(normalizeFeedbackText('y'.repeat(300))?.length, 240);

  const zhPayload = buildSocialSharePayload({
    title: '新春短片 & Demo',
    shareUrl: 'https://open-design.ai/share/abc?v=1',
    locale: 'zh-CN',
  });
  assert.equal(zhPayload.shareUrl, 'https://open-design.ai/share/abc?v=1');
  assert.equal(zhPayload.platforms[0]?.platform, 'weibo');
  assert.ok(zhPayload.copyText.includes('新春短片 & Demo'));
  assert.ok(zhPayload.platforms[1]?.shareUrl.includes(encodeURIComponent('https://open-design.ai/share/abc?v=1')));

  // Unsafe URLs must fall back cleanly to default safe origin
  const unsafeHttp = buildSocialSharePayload({
    title: 'Showcase',
    shareUrl: 'http://insecure.example/x',
    locale: 'en',
  });
  assert.equal(unsafeHttp.shareUrl, 'https://open-design.ai');
  assert.equal(unsafeHttp.platforms[0]?.platform, 'x');

  const unsafeJs = buildSocialSharePayload({
    title: 'Showcase',
    shareUrl: 'javascript:alert(1)',
    locale: 'en',
  });
  assert.equal(unsafeJs.shareUrl, 'https://open-design.ai');
});
