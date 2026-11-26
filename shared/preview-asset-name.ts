/** Accept a readable media filename after URL decoding, including at the iframe boundary. */
export function isDisplayablePreviewAssetName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 120 || !/^[\p{L}\p{M}\p{N} _.'()’-]+$/u.test(value)) return false;
  const match = /^(.+)\.(?:png|jpe?g|webp|gif|svg|avif|ico|bmp|tiff?|heic|mp4|mov|webm|mkv|m4v|ogv|mp3|wav|m4a|aac|ogg|oga|opus|flac|aiff?)$/i.exec(value);
  if (!match || !/^[\p{L}\p{N}]/u.test(match[1])) return false;
  const stem = match[1];
  return !/(?:[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}|[a-f\d]{12,}|(?=[a-z\d]*\d)[a-z\d]{16,}|[a-z\d]{24,})/i.test(stem) &&
    !/^(?:\d+|(?:untitled|unnamed|temp|tmp|file|asset|image|img|audio|video|download)(?:[ _-]?\d+)?)$/i.test(stem);
}

/** Select the authored URL when it uniquely identifies the resource, including across storage redirects. */
export function previewAssetName(el: HTMLImageElement | HTMLMediaElement): string | undefined {
  let source = el.getAttribute('src');
  if (el.tagName === 'IMG') {
    if (el.getAttribute('srcset') || el.parentElement?.tagName === 'PICTURE') source = null;
  } else if (!source) {
    const candidates = el.querySelectorAll('source[src]');
    if (candidates.length === 1) source = candidates[0].getAttribute('src');
  }
  for (const candidate of [source, el.currentSrc]) {
    const raw = candidate?.trim();
    if (!raw || /^(?:[?#]|data:|blob:)/i.test(raw)) continue;
    try {
      const url = new URL(raw, 'http://localhost/');
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (/\/derived\/[a-f\d]{64}\/proxy\.(?:mp4|webp|m4a)$/i.test(url.pathname)) continue;
      const name = decodeURIComponent(url.pathname.split('/').pop() || '');
      if (isDisplayablePreviewAssetName(name)) return name;
    } catch { /* The other URL may still identify the selected resource. */ }
  }
}
