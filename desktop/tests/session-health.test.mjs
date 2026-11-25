import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDesktopSentryReporter } from '../src/sentry.ts';
import { createSessionTracker, hasCrashDumpSince } from '../src/session-health.ts';

function makeLaunches() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'om-session-'));
  const state = { nowMs: 1_700_000_000_000, enabled: true, crashDump: false, sent: [] };
  /** Each call models one process: the tracker keeps nothing but the files in `dir`. */
  const launch = (release = 'openmotion-desktop@1.0.0') =>
    createSessionTracker({
      dir,
      release,
      isEnabled: () => state.enabled,
      send: update => state.sent.push(update),
      hasCrashDumpSince: () => state.crashDump,
      now: () => state.nowMs,
    });
  return { dir, state, launch, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a launch opens a session and the next launch reports how it ended', () => {
  const { dir, state, launch, cleanup } = makeLaunches();
  try {
    const first = launch();
    const idBeforeStart = first.getInstallId();
    assert.match(idBeforeStart, /^[0-9a-f-]{36}$/);
    first.start();
    assert.equal(state.sent.length, 1);
    const opened = state.sent[0];
    assert.equal(opened.did, idBeforeStart);
    assert.deepEqual(
      { init: opened.init, status: opened.status, errors: opened.errors, release: opened.release },
      { init: true, status: 'ok', errors: 0, release: 'openmotion-desktop@1.0.0' },
    );
    assert.match(opened.sid, /^[0-9a-f-]{36}$/);
    assert.match(opened.did, /^[0-9a-f-]{36}$/);
    if (process.platform !== 'win32') {
      assert.equal(statSync(path.join(dir, 'session.json')).mode & 0o777, 0o600);
      assert.equal(statSync(path.join(dir, 'install-id')).mode & 0o777, 0o600);
    }

    // Normal quit after 90 seconds with one reported error, then an update to 1.0.1.
    first.noteError();
    state.nowMs += 90_000;
    first.end();
    state.nowMs += 3_600_000;
    state.sent = [];
    launch('openmotion-desktop@1.0.1').start();
    const [closed, reopened] = state.sent;
    assert.deepEqual(closed, {
      sid: opened.sid,
      did: opened.did,
      init: false,
      startedAt: opened.startedAt,
      timestamp: opened.startedAt + 90_000,
      status: 'exited',
      errors: 1,
      durationSeconds: 90,
      // The session is attributed to the build that ran it, not the one reporting it.
      release: 'openmotion-desktop@1.0.0',
    });
    assert.equal(reopened.init, true);
    assert.equal(reopened.release, 'openmotion-desktop@1.0.1');
    assert.notEqual(reopened.sid, opened.sid);
    assert.equal(reopened.did, opened.did);
  } finally {
    cleanup();
  }
});

test('a launch that never said goodbye is abnormal, or crashed when it left evidence', () => {
  const { state, launch, cleanup } = makeLaunches();
  try {
    // Process disappeared (force quit, power loss): no end mark, no dump.
    launch().start();
    state.nowMs += 60_000;
    state.sent = [];
    launch().start();
    assert.equal(state.sent[0].status, 'abnormal');
    assert.equal(state.sent[0].durationSeconds, undefined);
    assert.equal(state.sent[0].timestamp, state.nowMs);

    // Same, but the launch left a crash dump behind.
    state.crashDump = true;
    state.sent = [];
    launch().start();
    assert.equal(state.sent[0].status, 'crashed');
    state.crashDump = false;

    // A renderer crash the user recovered from still counts, even after a normal quit.
    const recovered = launch();
    recovered.start();
    recovered.noteCrash();
    state.nowMs += 5_000;
    recovered.end();
    state.sent = [];
    launch().start();
    assert.equal(state.sent[0].status, 'crashed');
    assert.equal(state.sent[0].durationSeconds, 5);

    // A dump from an earlier launch is not blamed on a launch that quit normally.
    const clean = launch();
    clean.start();
    clean.end();
    state.crashDump = true;
    state.sent = [];
    launch().start();
    assert.equal(state.sent[0].status, 'exited');
  } finally {
    cleanup();
  }
});

test('nothing is reported or kept while sharing is off, and turning it off erases the install id', () => {
  const { dir, state, launch, cleanup } = makeLaunches();
  try {
    state.enabled = false;
    const silent = launch();
    assert.equal(silent.getInstallId(), undefined);
    silent.start();
    silent.noteError();
    silent.end();
    assert.deepEqual(state.sent, []);
    assert.equal(existsSync(path.join(dir, 'session.json')), false);
    assert.equal(existsSync(path.join(dir, 'install-id')), false);

    state.enabled = true;
    const shared = launch();
    shared.start();
    const firstId = state.sent[0].did;
    shared.forget();
    assert.equal(existsSync(path.join(dir, 'session.json')), false);
    assert.equal(existsSync(path.join(dir, 'install-id')), false);
    shared.end();
    assert.equal(existsSync(path.join(dir, 'session.json')), false);

    // Sharing again later starts over as a new, unrelated install with no session to close.
    state.sent = [];
    launch().start();
    assert.equal(state.sent.length, 1);
    assert.equal(state.sent[0].init, true);
    assert.notEqual(state.sent[0].did, firstId);
  } finally {
    cleanup();
  }
});

test('hasCrashDumpSince finds dumps written after the launch started, in any crashpad layout', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'om-crashpad-'));
  try {
    const sinceMs = 1_700_000_000_000;
    assert.equal(hasCrashDumpSince(path.join(dir, 'missing'), sinceMs), false);
    mkdirSync(path.join(dir, 'completed'), { recursive: true });
    mkdirSync(path.join(dir, 'reports'), { recursive: true });
    writeFileSync(path.join(dir, 'settings.dat'), 'x');
    const oldDump = path.join(dir, 'completed', 'old.dmp');
    writeFileSync(oldDump, 'x');
    utimesSync(oldDump, (sinceMs - 60_000) / 1000, (sinceMs - 60_000) / 1000);
    assert.equal(hasCrashDumpSince(dir, sinceMs), false);

    const newDump = path.join(dir, 'reports', 'new.dmp');
    writeFileSync(newDump, 'x');
    utimesSync(newDump, (sinceMs + 5_000) / 1000, (sinceMs + 5_000) / 1000);
    assert.equal(hasCrashDumpSince(dir, sinceMs), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sendSession writes a Sentry session envelope, respects opt-out and queues when offline', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'om-session-envelope-'));
  const outboxPath = path.join(dir, 'sentry-outbox.json');
  const bodies = [];
  let offline = false;
  const events = [];
  try {
    const reporter = createDesktopSentryReporter({
      dsn: 'https://publickey123@sentry.open-design.ai/42',
      release: 'openmotion-desktop@1.0.1',
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
      shellVersion: '1.0.1',
      env: {},
      outboxPath,
      now: () => 1_700_000_100_000,
      onCapture: level => events.push(level),
      onDisabled: () => events.push('disabled'),
      fetchImpl: async (_url, init) => {
        if (offline) throw new TypeError('fetch failed');
        bodies.push(String(init?.body ?? ''));
        return new Response('{}', { status: 200 });
      },
    });
    const update = {
      sid: '0b6c6f0e-4b0f-4c7e-9d49-0d3f7d3f9a11',
      did: '5a1d8f3c-7c62-4e0b-8f38-2f6b1c0a9e77',
      init: false,
      startedAt: 1_700_000_000_000,
      timestamp: 1_700_000_090_000,
      status: 'exited',
      errors: 1,
      durationSeconds: 90,
      release: 'openmotion-desktop@1.0.0',
    };
    assert.equal(await reporter.sendSession(update), true);
    const [header, itemHeader, payload] = bodies[0].trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(Object.keys(header).sort(), ['dsn', 'sent_at']);
    assert.deepEqual(itemHeader, { type: 'session' });
    assert.deepEqual(payload, {
      sid: update.sid,
      did: update.did,
      init: false,
      started: '2023-11-14T22:13:20.000Z',
      timestamp: '2023-11-14T22:14:50.000Z',
      status: 'exited',
      errors: 1,
      duration: 90,
      attrs: { release: 'openmotion-desktop@1.0.0', environment: 'production' },
    });

    offline = true;
    assert.equal(await reporter.sendSession({ ...update, init: true, status: 'ok' }), false);
    assert.equal(JSON.parse(readFileSync(outboxPath, 'utf8')).items.length, 1);
    offline = false;
    assert.equal(await reporter.flushOutbox(), 1);
    assert.equal(JSON.parse(bodies[1].split('\n')[1]).type, 'session');

    // Warnings do not make a session "errored"; errors do. The caller decides from the level.
    await reporter.captureMessage('note', 'warning');
    await reporter.captureException(new Error('boom'));
    assert.deepEqual(events, ['warning', 'error']);

    reporter.setEnabled(false);
    assert.deepEqual(events, ['warning', 'error', 'disabled']);
    const sentBefore = bodies.length;
    assert.equal(await reporter.sendSession(update), false);
    assert.equal(bodies.length, sentBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
