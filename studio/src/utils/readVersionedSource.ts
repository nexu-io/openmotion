import { ORDERED_TEXT_EDITS_HEADER } from '../../../shared/ordered-text-edits';
import { applyTextPatch, TEXT_PATCH_BASE_HEADER } from '../../../shared/text-patch';
import { studioApiFetch } from './studioApiFetch';

export interface SourceVersion { content: string; version: string }

function sourceResponse(source: SourceVersion, received: Headers): Response {
  const headers = new Headers({ ETag: source.version });
  for (const capability of ['X-OpenMotion-Text-Edits', ORDERED_TEXT_EDITS_HEADER]) {
    if (received.get(capability) === '1') headers.set(capability, '1');
  }
  return Response.json({ ...source, missing: false }, { headers });
}

// A delta is meaningful only to a reader holding exactly the revision it names.
// Preserve the ordinary Response for status handling and old hosts' full reads.
export async function readVersionedSource(url: string, base?: SourceVersion): Promise<Response> {
  if (!base) return studioApiFetch(url);
  const response = await studioApiFetch(url, { headers: {
    'If-None-Match': base.version,
    [TEXT_PATCH_BASE_HEADER]: base.version,
  } });
  // A compression proxy may weaken the HTTP validator without changing the version in the JSON.
  // Compare the opaque read tag; keep the authoritative source version for subsequent writes.
  const readTag = response.headers.get('etag')?.replace(/^W\//, '');
  if (response.status === 304) {
    return readTag === base.version ? sourceResponse(base, response.headers) : studioApiFetch(url);
  }
  if (!response.ok || response.headers.get('X-OpenMotion-Representation') !== 'text-patch') return response;
  try {
    const body = await response.json();
    if (body.baseVersion === base.version && /^"patch:[a-f0-9]{64}"$/.test(body.version) && body.version === readTag) {
      const content = applyTextPatch(base.content, body.patch);
      return sourceResponse({ content, version: body.version }, response.headers);
    }
  } catch {
    // A bad or truncated delta is recoverable with an ordinary full-source read.
  }
  return studioApiFetch(url);
}
