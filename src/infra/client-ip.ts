/**
 * Resolves the client address from proxy headers, trusting only `TRUST_PROXY_HOPS` hops.
 *
 * Proxies append to `X-Forwarded-For`, so the left-most entry is whatever the client sent and must
 * never key a rate limit. Indexing from the right by the configured hop count yields the address the
 * outermost trusted proxy observed. A chain shorter than the configured hop count is not trustworthy
 * either, because every entry it does contain could have been supplied by the client, so both cases
 * fall back to the shared `local` bucket. `x-real-ip` is only read when the forwarded chain is
 * absent and at least one hop is trusted.
 */
export function resolveClientIp(
  headers: { get(name: string): string | null },
  trustProxyHops: number,
): string {
  if (trustProxyHops > 0) {
    const forwarded = headers.get('x-forwarded-for');
    if (forwarded) {
      const hops = forwarded
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      if (hops.length >= trustProxyHops) {
        return hops[hops.length - trustProxyHops] ?? 'local';
      }
      // Fewer entries than configured hops: no position in this chain is proxy-attested.
      return 'local';
    }
    const realIp = headers.get('x-real-ip')?.trim();
    if (realIp) return realIp;
  }
  return 'local';
}