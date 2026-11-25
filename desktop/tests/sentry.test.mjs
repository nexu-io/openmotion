import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDesktopSentryReporter,
  extractDebugMetaImages,
  parseSentryEnvelopeEndpoints,
  resolveDesktopSentryDsn,
} from '../src/sentry.ts';

const TEST_DSN = 'https://publickey123@sentry.open-design.ai/42';

test('parseSentryEnvelopeEndpoints derives envelope and minidump URLs and rejects invalid DSNs', () => {
  const parsed = parseSentryEnvelopeEndpoints(TEST_DSN);
  assert.ok(parsed);
  assert.equal(parsed.envelopeUrl, 'https://sentry.open-design.ai/api/42/envelope/');
  assert.equal(
    parsed.minidumpUrl,
    'https://sentry.open-design.ai/api/42/minidump/?sentry_key=publickey123',
  );
  assert.equal(parsed.publicKey, 'publickey123');
  assert.equal(parsed.projectId, '42');

  const prefixed = parseSentryEnvelopeEndpoints('https://key9@example.com/sub/99');
  assert.equal(prefixed?.envelopeUrl, 'https://example.com/sub/api/99/envelope/');
  assert.equal(
    prefixed?.minidumpUrl,
    'https://example.com/sub/api/99/minidump/?sentry_key=key9',
  );

  assert.equal(parseSentryEnvelopeEndpoints(''), null);
  assert.equal(parseSentryEnvelopeEndpoints('http://public@evil.example.com/42'), null);
  assert.equal(parseSentryEnvelopeEndpoints('https://public@example.com/not-a-number'), null);
});

test('createDesktopSentryReporter is default-off without DSN or under DO_NOT_TRACK', async () => {
  let fetchCalls = 0;
  let crashStarts = 0;
  const fakeCrashReporter = {
    start() {
      crashStarts += 1;
    },
  };

  const noDsn = createDesktopSentryReporter({
    dsn: undefined,
    release: 'openmotion-desktop@0.2.1',
    channel: 'stable',
    platform: 'darwin',
    arch: 'arm64',
    shellVersion: '0.2.1',
    env: {},
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response('ok', { status: 200 });
    },
  });
  assert.equal(noDsn.isEnabled(), false);
  assert.equal(noDsn.startCrashReporter(fakeCrashReporter), false);
  assert.equal(await noDsn.captureException(new Error('boom')), false);
  assert.equal(fetchCalls, 0);
  assert.equal(crashStarts, 0);

  const optedOut = createDesktopSentryReporter({
    dsn: TEST_DSN,
    release: 'openmotion-desktop@0.2.1',
    channel: 'stable',
    platform: 'darwin',
    arch: 'arm64',
    shellVersion: '0.2.1',
    env: { DO_NOT_TRACK: '1' },
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response('ok', { status: 200 });
    },
  });
  assert.equal(optedOut.isEnabled(), false);
  assert.equal(optedOut.startCrashReporter(fakeCrashReporter), false);
  assert.equal(await optedOut.captureMessage('test'), false);
  assert.equal(fetchCalls, 0);
  assert.equal(crashStarts, 0);
});

test('createDesktopSentryReporter sends scrubbed Sentry Envelopes, wires crashReporter, and enforces rate limit', async () => {
  const sentRequests = [];
  let crashConfig = null;
  let nowMs = 1_700_000_000_000;

  const reporter = createDesktopSentryReporter({
    dsn: TEST_DSN,
    release: 'openmotion-desktop@0.2.1',
    channel: 'stable',
    platform: 'darwin',
    arch: 'arm64',
    shellVersion: '0.2.1',
    getInstallId: () => '5a1d8f3c-7c62-4e0b-8f38-2f6b1c0a9e77',
    osVersion: '24.3.0',
    electronVersion: '45.4.1',
    chromeVersion: '134.0.0.0',
    nodeVersion: '22.18.0',
    appStartTime: 1_700_000_000_000,
    redactPaths: ['/opt/demo-home/Library/Application Support/OpenDesign', '/opt/demo-home'],
    env: {},
    maxEventsPerMinute: 2,
    now: () => nowMs,
    fetchImpl: async (url, init) => {
      sentRequests.push({ url: String(url), headers: init?.headers, body: String(init?.body ?? '') });
      return new Response('{}', { status: 200 });
    },
  });

  assert.equal(reporter.isEnabled(), true);
  const started = reporter.startCrashReporter({
    start(opts) {
      crashConfig = opts;
    },
  });
  assert.equal(started, true);
  assert.equal(
    crashConfig.submitURL,
    'https://sentry.open-design.ai/api/42/minidump/?sentry_key=publickey123',
  );
  assert.equal(crashConfig.extra, undefined);
  assert.equal(crashConfig.globalExtra['sentry[release]'], 'openmotion-desktop@0.2.1');
  assert.equal(crashConfig.globalExtra['sentry[environment]'], 'production');
  assert.equal(crashConfig.globalExtra['sentry[tags][shell_version]'], '0.2.1');
  assert.equal(crashConfig.globalExtra['sentry[tags][host_kind]'], 'desktop');
  assert.equal(crashConfig.globalExtra['sentry[user][id]'], '5a1d8f3c-7c62-4e0b-8f38-2f6b1c0a9e77');
  assert.equal(crashConfig.globalExtra['sentry[contexts][runtime][name]'], 'Electron');
  assert.equal(crashConfig.globalExtra['sentry[contexts][runtime][version]'], '45.4.1');
  assert.equal(crashConfig.globalExtra['sentry[contexts][os][name]'], 'macOS');
  assert.equal(crashConfig.globalExtra['sentry[contexts][os][version]'], '24.3.0');

  reporter.addBreadcrumb({
    category: 'lifecycle',
    message: 'Loaded /opt/demo-home/secret with Bearer sk_live_secret_999',
    data: { token: 'crumb_secret', step: 'boot' },
  });

  const leakyError = new Error(
    'Failed loading /opt/demo-home/Library/Application Support/OpenDesign/secrets.json with Bearer sk_live_secret_999',
  );
  const ok1 = await reporter.captureException(leakyError, {
    area: 'updater',
    extra: {
      accessToken: 'super_secret_token',
      note: 'path=/opt/demo-home/private.txt',
    },
  });
  assert.equal(ok1, true);
  assert.equal(sentRequests.length, 1);
  assert.equal(sentRequests[0].url, 'https://sentry.open-design.ai/api/42/envelope/');

  const lines = sentRequests[0].body.trim().split('\n');
  assert.equal(lines.length, 3);
  const envHeader = JSON.parse(lines[0]);
  const itemHeader = JSON.parse(lines[1]);
  const payload = JSON.parse(lines[2]);

  assert.equal(envHeader.dsn, TEST_DSN);
  assert.equal(itemHeader.type, 'event');
  assert.equal(payload.release, 'openmotion-desktop@0.2.1');
  assert.equal(payload.environment, 'production');
  assert.equal(payload.user.id, '5a1d8f3c-7c62-4e0b-8f38-2f6b1c0a9e77');
  assert.equal(payload.contexts.os.name, 'macOS');
  assert.equal(payload.contexts.os.version, '24.3.0');
  assert.equal(payload.contexts.runtime.name, 'Electron');
  assert.equal(payload.contexts.runtime.version, '45.4.1');
  assert.equal(payload.contexts.node.version, '22.18.0');
  assert.equal(payload.contexts.chrome.version, '134.0.0.0');
  assert.equal(payload.contexts.device.arch, 'arm64');
  assert.equal(payload.contexts.app.app_version, '0.2.1');
  assert.equal(payload.breadcrumbs.length, 1);
  assert.equal(payload.breadcrumbs[0].category, 'lifecycle');
  assert.equal(payload.breadcrumbs[0].data.step, 'boot');
  assert.equal(payload.breadcrumbs[0].data.token, '[redacted]');
  assert.equal(payload.tags.host_kind, 'desktop');
  assert.equal(payload.tags.area, 'updater');
  assert.equal(sentRequests[0].body.includes('sk_live_secret_999'), false);
  assert.equal(sentRequests[0].body.includes('super_secret_token'), false);
  assert.equal(sentRequests[0].body.includes('crumb_secret'), false);
  assert.equal(sentRequests[0].body.includes('/opt/demo-home'), false);

  // Second event within 1 minute succeeds; third is rate-limited
  assert.equal(await reporter.captureMessage('Renderer gone', 'fatal'), true);
  assert.equal(await reporter.captureMessage('Flood event', 'error'), false);
  assert.equal(sentRequests.length, 2);

  // After 61 seconds window resets; runtime opt-out stops sending
  nowMs += 61_000;
  reporter.setEnabled(false);
  assert.equal(await reporter.captureMessage('After opt-out', 'error'), false);
  assert.equal(sentRequests.length, 2);
});

test('resolveDesktopSentryDsn prefers a runtime override and falls back to the embedded build value', () => {
  assert.equal(resolveDesktopSentryDsn({}, undefined), undefined);
  assert.equal(resolveDesktopSentryDsn({}, ''), undefined);
  assert.equal(resolveDesktopSentryDsn({}, ` ${TEST_DSN} `), TEST_DSN);
  assert.equal(
    resolveDesktopSentryDsn({ SENTRY_DESKTOP_DSN: 'https://override@example.com/7' }, TEST_DSN),
    'https://override@example.com/7',
  );
  assert.equal(
    resolveDesktopSentryDsn(
      { SENTRY_DESKTOP_DSN: '  ', OPENMOTION_DESKTOP_SENTRY_DSN: 'https://alt@example.com/8' },
      TEST_DSN,
    ),
    'https://alt@example.com/8',
  );
});

test('setEnabled applies a persisted opt-out before startup and gates crash dump upload afterwards', async () => {
  const calls = [];
  let fetchCalls = 0;
  const fakeCrashReporter = {
    start(options) {
      calls.push(['start', options.uploadToServer]);
    },
    setUploadToServer(value) {
      calls.push(['upload', value]);
    },
  };
  const reporter = createDesktopSentryReporter({
    dsn: TEST_DSN,
    release: 'openmotion-desktop@0.2.1',
    channel: 'stable',
    platform: 'darwin',
    arch: 'arm64',
    shellVersion: '0.2.1',
    env: {},
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response('ok', { status: 200 });
    },
  });

  reporter.setEnabled(false);
  assert.equal(reporter.startCrashReporter(fakeCrashReporter), false);
  assert.equal(await reporter.captureException(new Error('startup failure')), false);
  assert.deepEqual(calls, []);
  assert.equal(fetchCalls, 0);

  reporter.setEnabled(true);
  assert.deepEqual(calls, [['start', true]]);

  reporter.setEnabled(false);
  reporter.setEnabled(true);
  assert.deepEqual(calls, [
    ['start', true],
    ['upload', false],
    ['upload', true],
  ]);
});

function makeOutboxReporter(overrides = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'om-sentry-outbox-'));
  const outboxPath = path.join(dir, 'telemetry', 'sentry-outbox.json');
  const state = { nowMs: 1_700_000_000_000, responses: [], bodies: [] };
  const reporter = createDesktopSentryReporter({
    dsn: TEST_DSN,
    release: 'openmotion-desktop@0.2.1',
    channel: 'stable',
    platform: 'darwin',
    arch: 'arm64',
    shellVersion: '0.2.1',
    env: {},
    outboxPath,
    maxEventsPerMinute: 100,
    now: () => state.nowMs,
    fetchImpl: async (_url, init) => {
      state.bodies.push(String(init?.body ?? ''));
      const next = state.responses.shift() ?? 200;
      if (next === 'offline') throw new TypeError('fetch failed');
      return new Response('{}', { status: next });
    },
    ...overrides,
  });
  const queued = () =>
    existsSync(outboxPath) ? JSON.parse(readFileSync(outboxPath, 'utf8')).items : [];
  return { reporter, state, outboxPath, queued, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const messageOf = body => JSON.parse(body.split('\n')[2]).message;
const sentAtOf = body => JSON.parse(body.split('\n')[0]).sent_at;

test('an undeliverable event waits in the outbox and is delivered in order once the network is back', async () => {
  const { reporter, state, outboxPath, queued, cleanup } = makeOutboxReporter();
  try {
    state.responses = ['offline', 503, 429];
    assert.equal(await reporter.captureMessage('first', 'error'), false);
    assert.equal(await reporter.captureMessage('second', 'error'), false);
    assert.equal(await reporter.captureMessage('third', 'error'), false);
    assert.deepEqual(queued().map(item => messageOf(item.body)), ['first', 'second', 'third']);
    if (process.platform !== 'win32') {
      assert.equal(statSync(outboxPath).mode & 0o777, 0o600);
    }

    // Still unreachable: nothing is lost and nothing after the failing item is attempted.
    state.bodies = [];
    state.responses = [200, 'offline'];
    assert.equal(await reporter.flushOutbox(), 1);
    assert.equal(state.bodies.length, 2);
    assert.deepEqual(queued().map(item => messageOf(item.body)), ['second', 'third']);

    // Delivered two hours late: the envelope carries the time of this attempt, the event its own.
    const queuedAtMs = state.nowMs;
    state.nowMs += 2 * 60 * 60 * 1000;
    state.bodies = [];
    assert.equal(await reporter.flushOutbox(), 2);
    assert.deepEqual(state.bodies.map(messageOf), ['second', 'third']);
    assert.equal(sentAtOf(state.bodies[0]), new Date(state.nowMs).toISOString());
    assert.equal(JSON.parse(state.bodies[0].split('\n')[2]).timestamp, queuedAtMs / 1000);
    assert.equal(existsSync(outboxPath), false);
    assert.equal(await reporter.flushOutbox(), 0);
  } finally {
    cleanup();
  }
});

test('the outbox drops what ingest rejects, expires old items, stays bounded, and is erased on opt-out', async () => {
  const { reporter, state, outboxPath, queued, cleanup } = makeOutboxReporter();
  try {
    // A payload ingest refuses can never succeed: it is neither queued nor retried.
    state.responses = [400];
    assert.equal(await reporter.captureMessage('rejected', 'error'), false);
    assert.equal(existsSync(outboxPath), false);

    state.responses = ['offline', 400, 200];
    await reporter.captureMessage('rejected-later', 'error');
    state.responses = ['offline'];
    await reporter.captureMessage('kept', 'error');
    state.responses = [400, 200];
    assert.equal(await reporter.flushOutbox(), 1);
    assert.equal(existsSync(outboxPath), false);

    // Bounded: only the most recent failures are worth the disk and the upload.
    for (let index = 0; index < 25; index += 1) {
      state.nowMs += 1;
      state.responses = ['offline'];
      await reporter.captureMessage(`burst-${index}`, 'error');
    }
    assert.equal(queued().length, 20);
    assert.equal(messageOf(queued()[0].body), 'burst-5');
    assert.equal(messageOf(queued()[19].body), 'burst-24');

    // A week-old failure is no longer actionable.
    state.nowMs += 8 * 24 * 60 * 60 * 1000;
    state.bodies = [];
    assert.equal(await reporter.flushOutbox(), 0);
    assert.equal(state.bodies.length, 0);
    assert.equal(existsSync(outboxPath), false);

    // Turning reporting off removes what was collected but not yet sent.
    state.responses = ['offline'];
    await reporter.captureMessage('before-opt-out', 'error');
    assert.equal(queued().length, 1);
    reporter.setEnabled(false);
    assert.equal(existsSync(outboxPath), false);
    reporter.setEnabled(true);
    state.bodies = [];
    assert.equal(await reporter.flushOutbox(), 0);
    assert.equal(state.bodies.length, 0);
  } finally {
    cleanup();
  }
});

test('captureTransaction sends Sentry transaction envelopes with spans, measurements, and outbox retry', async () => {
  const { reporter, state, queued, cleanup } = makeOutboxReporter({
    getInstallId: () => '9f1c2e3b-4a5d-6b7c-8d9e-0f1a2b3c4d5e',
    osVersion: '24.3.0',
    electronVersion: '45.4.1',
  });
  try {
    const startMs = state.nowMs;
    const ok = await reporter.captureTransaction({
      name: 'desktop.startup',
      op: 'app.launch',
      startMs,
      endMs: startMs + 1_450,
      status: 'ok',
      tags: { outcome: 'ok' },
      measurements: {
        app_cold_start: { value: 1450, unit: 'millisecond' },
      },
      spans: [
        { op: 'electron.ready', description: 'Electron app.whenReady', startMs, endMs: startMs + 220 },
        { op: 'studio.load', description: 'Studio load', startMs: startMs + 250, endMs: startMs + 1_450 },
      ],
    });
    assert.equal(ok, true);
    assert.equal(state.bodies.length, 1);

    const [envHeader, itemHeader, payload] = state.bodies[0].trim().split('\n').map(line => JSON.parse(line));
    assert.equal(envHeader.trace.transaction, 'desktop.startup');
    assert.equal(itemHeader.type, 'transaction');
    assert.equal(payload.type, 'transaction');
    assert.equal(payload.transaction, 'desktop.startup');
    assert.equal(payload.user.id, '9f1c2e3b-4a5d-6b7c-8d9e-0f1a2b3c4d5e');
    assert.equal(payload.contexts.trace.op, 'app.launch');
    assert.equal(payload.contexts.trace.status, 'ok');
    assert.equal(payload.measurements.app_cold_start.value, 1450);
    assert.equal(payload.spans.length, 2);
    assert.equal(payload.spans[0].parent_span_id, payload.contexts.trace.span_id);
    assert.equal(payload.spans[0].trace_id, payload.contexts.trace.trace_id);

    // Offline transaction queues in outbox and flushes later
    state.responses = ['offline'];
    assert.equal(
      await reporter.captureTransaction({
        name: 'desktop.updater.check',
        op: 'updater.check',
        startMs,
        endMs: startMs + 300,
      }),
      false,
    );
    assert.equal(queued().length, 1);
    state.responses = [200];
    assert.equal(await reporter.flushOutbox(), 1);
  } finally {
    cleanup();
  }
});

test('captureException normalizes bundled frames to app:///dist/... and attaches debug_meta.images', async () => {
  const bodies = [];
  const distDir = '/opt/OpenDesign/resources/app.asar/dist';
  const debugId = '11111111-2222-4333-8444-555555555555';
  const reporter = createDesktopSentryReporter({
    dsn: TEST_DSN,
    release: 'openmotion-desktop@0.2.1',
    channel: 'stable',
    platform: 'darwin',
    arch: 'arm64',
    shellVersion: '0.2.1',
    appDistDir: distDir,
    redactPaths: [distDir],
    debugIds: {
      [`Error\n    at file://${distDir}/main.mjs:999:12`]: debugId,
    },
    env: {},
    fetchImpl: async (_url, init) => {
      bodies.push(String(init?.body ?? ''));
      return new Response('{}', { status: 200 });
    },
  });

  const err = new Error('boom');
  err.stack = `Error: boom\n    at bootDesktop (file://${distDir}/main.mjs:420:15)\n    at node:internal/process/task_queues:95:5`;
  assert.equal(await reporter.captureException(err), true);
  const payload = JSON.parse(bodies[0].trim().split('\n')[2]);
  const frames = payload.exception.values[0].stacktrace.frames;
  const appFrame = frames.find(frame => frame.function === 'bootDesktop');
  assert.equal(appFrame.filename, 'app:///dist/main.mjs');
  assert.equal(appFrame.abs_path, 'app:///dist/main.mjs');
  assert.equal(appFrame.in_app, true);
  assert.deepEqual(payload.debug_meta, {
    images: [{ type: 'sourcemap', code_file: 'app:///dist/main.mjs', debug_id: debugId }],
  });
  assert.deepEqual(
    extractDebugMetaImages({ [`Error\n    at ${distDir}/preload.cjs:1:1`]: debugId }, distDir),
    [{ type: 'sourcemap', code_file: 'app:///dist/preload.cjs', debug_id: debugId }],
  );
});

test('breadcrumbs stay bounded and are cleared when sharing is disabled', async () => {
  const bodies = [];
  const reporter = createDesktopSentryReporter({
    dsn: TEST_DSN,
    release: 'openmotion-desktop@0.2.1',
    channel: 'test',
    platform: 'darwin',
    arch: 'arm64',
    shellVersion: '0.2.1',
    maxBreadcrumbs: 3,
    env: {},
    fetchImpl: async (_url, init) => {
      bodies.push(String(init?.body ?? ''));
      return new Response('{}', { status: 200 });
    },
  });

  for (let i = 1; i <= 5; i += 1) {
    reporter.addBreadcrumb({ category: 'nav', message: `step-${i}` });
  }
  await reporter.captureMessage('first', 'error');
  const firstPayload = JSON.parse(bodies[0].trim().split('\n')[2]);
  assert.deepEqual(
    firstPayload.breadcrumbs.map(crumb => crumb.message),
    ['step-3', 'step-4', 'step-5'],
  );

  reporter.setEnabled(false);
  reporter.setEnabled(true);
  await reporter.captureMessage('second', 'error');
  const secondPayload = JSON.parse(bodies[1].trim().split('\n')[2]);
  assert.equal(secondPayload.breadcrumbs, undefined);
});
