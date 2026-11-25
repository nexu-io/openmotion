import { STUDIO_API_SAME_ORIGIN_CREDENTIALS } from "../components/editor/manualEditingAvailability";
import { projectSourceReadUrl } from '../../../shared/project-source-url';
import { editorProjectIdFromPath } from '../../../shared/spa-routes';
import { parseProjectIdFromHash } from './projectRouting';
import { diagnosticFetch } from '../motion/diagnosticRequests';

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function studioApiCredentials(): RequestCredentials {
  if (STUDIO_API_SAME_ORIGIN_CREDENTIALS) return "same-origin";
  const host = globalThis.location?.hostname;
  if (host && !LOOPBACK_HOSTS.has(host)) return "same-origin";
  // The cloud shell also authenticates with same-origin cookies when served locally.
  const cloudShell = globalThis.document?.head?.querySelector('meta[name="openmotion-runtime"][content="cloud-diskless"]');
  return cloudShell ? "same-origin" : "omit";
}

/** New cloud hosts advertise an extensionless route for current file responses.
 * A per-file GET always means "latest", even when the path happens to end in .svg. */
function hostedFileReadUrl(input: string, method = "GET"): string {
  if (!/^(GET|HEAD)$/i.test(method)) return input;
  const match = /^\/api\/projects\/([^/?#]+)\/files\/([^?#]+)(?:\?([^#]*))?$/.exec(input);
  if (!match || !globalThis.document?.head?.querySelector?.('meta[name="openmotion-runtime"][data-file-source="query"]')) return input;
  try {
    const read = projectSourceReadUrl(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
    return match[3] ? read + "&" + match[3] : read;
  } catch {
    return input; // Let the API return its normal error for malformed paths.
  }
}

export function studioApiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const target = typeof input === "string" ? hostedFileReadUrl(studioProjectUrl(input), init?.method) : input;
  return diagnosticFetch(target, { ...init, credentials: studioApiCredentials() });
}

export function studioProjectUrl(input: string, projectId?: string | null): string {
  if (!input.startsWith('/api/') || input === '/api/projects' || input.startsWith('/api/projects/')) return input;
  const location = globalThis.location;
  const id = projectId ?? (location && (editorProjectIdFromPath(location.pathname) ?? new URLSearchParams(location.search).get('project') ?? parseProjectIdFromHash(location.hash)));
  if (!id) return input;
  const url = new URL(input, 'http://studio.local');
  if (!url.searchParams.has('projectId')) url.searchParams.set('projectId', id);
  return url.pathname + url.search;
}
