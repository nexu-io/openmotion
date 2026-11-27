import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveClientIp } from '../../src/infra/client-ip.ts';

function headers(values: Record<string, string>) {
  const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

describe('resolveClientIp proxy trust', () => {
  it('ignores the client-supplied left-most X-Forwarded-For entry', () => {
    // A proxy appends the peer address, so with one trusted hop the right-most value wins.
    const resolved = resolveClientIp(
      headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }),
      1,
    );
    assert.equal(resolved, '203.0.113.9');
  });

  it('never lets a rotating spoofed first hop change the bucket key', () => {
    const one = resolveClientIp(headers({ 'x-forwarded-for': '1.1.1.1, 198.51.100.7' }), 1);
    const two = resolveClientIp(headers({ 'x-forwarded-for': '2.2.2.2, 198.51.100.7' }), 1);
    assert.equal(one, two);
    assert.equal(one, '198.51.100.7');
  });

  it('honours a multi-hop configuration', () => {
    assert.equal(
      resolveClientIp(headers({ 'x-forwarded-for': 'spoofed, 203.0.113.9, 10.0.0.2' }), 2),
      '203.0.113.9',
    );
  });

  it('refuses to key on a chain shorter than the configured hop count', () => {
    // Every entry in a short chain could be client supplied, so the caller shares the local bucket
    // instead of indexing the left-most value.
    assert.equal(resolveClientIp(headers({ 'x-forwarded-for': '203.0.113.9' }), 3), 'local');
    assert.equal(
      resolveClientIp(headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), 3),
      'local',
    );
  });

  it('ignores both proxy headers when no hop is trusted', () => {
    assert.equal(
      resolveClientIp(
        headers({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' }),
        0,
      ),
      'local',
    );
  });

  it('uses x-real-ip only when hops are trusted', () => {
    assert.equal(resolveClientIp(headers({ 'x-real-ip': '5.6.7.8' }), 1), '5.6.7.8');
  });

  it('returns local when no proxy headers are present', () => {
    assert.equal(resolveClientIp(headers({}), 2), 'local');
    assert.equal(resolveClientIp(headers({ 'x-forwarded-for': ' , ' }), 2), 'local');
  });
});