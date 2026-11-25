/**
 * Q1 Frozen Contract — Desktop System-Browser Session Handoff (C1 <-> K3).
 *
 * Flow (Design Doc §5.1):
 * 1. Desktop shell opens system browser at `/auth/desktop/start` with PKCE S256
 *    `code_challenge`, `state`, and loopback `redirect_uri`.
 * 2. Cloud verifies/completes browser OIDC login, mints a single-use handoff code
 *    (TTL <= 60s) bound to `code_challenge`, and redirects to `redirect_uri?code=...&state=...`.
 * 3. Desktop main process exchanges `{ code, codeVerifier, redirectUri }` via
 *    POST `/auth/desktop/exchange` using the main window's session so the cloud
 *    response writes `om_session` directly into the window cookie jar.
 */

export const DESKTOP_HANDOFF_START_PATH = '/auth/desktop/start' as const;
export const DESKTOP_HANDOFF_EXCHANGE_PATH = '/auth/desktop/exchange' as const;
export const DESKTOP_HANDOFF_TTL_SEC = 60 as const;

export type DesktopHandoffExchangeRequest = {
  code: string;
  codeVerifier: string;
  redirectUri: string;
};

export type DesktopHandoffExchangeResponse = {
  ok: true;
  user: {
    id: string;
    email?: string | null;
    name?: string | null;
  };
  workspaceId: string;
};

/**
 * Validates that a desktop handoff redirect URI targets an explicit loopback
 * HTTP endpoint (`http://127.0.0.1:<port>/...` or `http://localhost:<port>/...`
 * or `http://[::1]:<port>/...`) with a non-privileged port and no credentials/hash.
 */
export function isValidDesktopLoopbackRedirectUri(rawUri: string): boolean {
  try {
    const parsed = new URL(rawUri);
    if (parsed.protocol !== 'http:') return false;
    if (parsed.username || parsed.password || parsed.hash) return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
      return false;
    }
    const port = Number.parseInt(parsed.port, 10);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return false;
    }
    return parsed.pathname.startsWith('/');
  } catch {
    return false;
  }
}
