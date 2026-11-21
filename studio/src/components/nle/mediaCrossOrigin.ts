/**
 * Same-origin app/preview/asset URLs in Cloud mode may `302` redirect to cross-origin
 * presigned S3/R2 URLs (configured with canonical CORS headers). Opting these elements
 * into `crossOrigin="anonymous"` keeps Web Audio `createMediaElementSource()` audible
 * across the redirect while still sending same-origin cookies on the initial hop.
 * External third-party URLs are left without `crossOrigin` so hosts without CORS still play.
 */
export function mediaCrossOriginForUrl(url: string): "anonymous" | undefined {
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith("//")) return undefined;
  if (trimmed.startsWith("/")) return "anonymous";
  try {
    const base = typeof window !== "undefined" ? window.location.href : "http://localhost/";
    const resolved = new URL(trimmed, base);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return undefined;
    if (typeof window !== "undefined" && resolved.origin === window.location.origin) {
      return "anonymous";
    }
  } catch {
    return undefined;
  }
  return undefined;
}
