import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DesktopTelemetryCollector } from '../src/telemetry.ts';

test('DesktopTelemetryCollector aggregates counters, latency, and persists zero-PII metrics across restarts', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'om-telemetry-'));
  try {
    const collector1 = new DesktopTelemetryCollector({
      dataDir: tmpDir,
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
      shellVersion: '0.2.1',
      env: {},
    });

    assert.equal(collector1.isEnabled(), true);
    assert.ok(collector1.record({ category: 'app.startup', outcome: 'ok', durationMs: 420 }));
    assert.ok(collector1.record({ category: 'auth.handoff', outcome: 'authenticated', durationMs: 1200 }));
    assert.ok(collector1.record({ category: 'auth.handoff', outcome: 'timeout', durationMs: 3000 }));
    assert.ok(
      collector1.record({
        category: 'agent.connect',
        outcome: 'ok',
        agentId: 'cursor',
        connectMode: 'config',
        durationMs: 35,
      }),
    );

    // Extra/PII keys must be rejected by strict Zod schema
    const rejectedPii = collector1.record({
      category: 'auth.handoff',
      outcome: 'error',
      // @ts-expect-error testing runtime strict schema enforcement
      email: 'ada@open-design.ai',
    });
    assert.equal(rejectedPii, null);

    const summary = collector1.getSummary();
    assert.equal(summary.totalEvents, 4);
    assert.equal(summary.categories['auth.handoff']?.total, 2);
    assert.equal(summary.categories['auth.handoff']?.avgDurationMs, 2100);
    assert.equal(summary.categories['auth.handoff']?.maxDurationMs, 3000);
    assert.equal(summary.categories['agent.connect']?.outcomes.ok, 1);

    const diskPath = path.join(tmpDir, 'telemetry', 'health-metrics.json');
    assert.equal(existsSync(diskPath), true);
    const rawDisk = readFileSync(diskPath, 'utf8');
    assert.equal(rawDisk.includes('ada@open-design.ai'), false);

    // Reload from disk preserves counts
    const collector2 = new DesktopTelemetryCollector({
      dataDir: tmpDir,
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
      shellVersion: '0.2.1',
      env: {},
    });
    assert.equal(collector2.getSummary().totalEvents, 4);

    // Toggle off stops recording; reset clears counters
    collector2.setEnabled(false);
    assert.equal(collector2.record({ category: 'updater.check', outcome: 'ok' }), null);
    assert.equal(collector2.reset().totalEvents, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DesktopTelemetryCollector respects DO_NOT_TRACK, restricts flush URLs to domain scope, and refuses symlinks', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'om-telemetry-guard-'));
  try {
    const dntCollector = new DesktopTelemetryCollector({
      dataDir: tmpDir,
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
      shellVersion: '0.2.1',
      env: { DO_NOT_TRACK: '1' },
    });
    assert.equal(dntCollector.isEnabled(), false);
    assert.equal(dntCollector.record({ category: 'app.startup', outcome: 'ok' }), null);

    // Evil flush URL must be blocked
    let fetchCalls = 0;
    const evilFlushCollector = new DesktopTelemetryCollector({
      dataDir: tmpDir,
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
      shellVersion: '0.2.1',
      env: {},
      flushEndpointUrl: 'https://evil.example.com/telemetry',
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response('ok', { status: 200 });
      },
    });
    const evilRes = await evilFlushCollector.flush();
    assert.equal(evilRes.ok, false);
    assert.equal(evilRes.reason, 'origin_denied');
    assert.equal(fetchCalls, 0);

    // Allowed domain flush succeeds
    const goodFlushCollector = new DesktopTelemetryCollector({
      dataDir: tmpDir,
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
      shellVersion: '0.2.1',
      env: {},
      flushEndpointUrl: 'https://motion.open-design.ai/api/telemetry',
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response('ok', { status: 200 });
      },
    });
    const goodRes = await goodFlushCollector.flush();
    assert.equal(goodRes.ok, true);
    assert.equal(fetchCalls, 1);

    // Symlinked telemetry file is never overwritten
    const symDir = mkdtempSync(path.join(os.tmpdir(), 'om-telemetry-sym-'));
    try {
      const victim = path.join(symDir, 'victim.json');
      writeFileSync(victim, '{"untouched":true}', 'utf8');
      mkdirSync(path.join(symDir, 'telemetry'), { recursive: true });
      symlinkSync(victim, path.join(symDir, 'telemetry', 'health-metrics.json'));

      const symCollector = new DesktopTelemetryCollector({
        dataDir: symDir,
        channel: 'stable',
        platform: 'darwin',
        arch: 'arm64',
        shellVersion: '0.2.1',
        env: {},
      });
      symCollector.record({ category: 'app.startup', outcome: 'ok' });
      assert.equal(readFileSync(victim, 'utf8'), '{"untouched":true}');
    } finally {
      rmSync(symDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
