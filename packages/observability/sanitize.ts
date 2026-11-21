const REDACTED = '[redacted]';

const SENSITIVE_QUERY_KEYS = new Set([
  'preview_token',
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'code',
  'state',
  'session',
  'session_id',
  'tracking_context',
  'signature',
  'sig',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  'x-amz-date',
  'x-amz-signedheaders',
  'x-amz-algorithm',
  'x-amz-expires',
  'api_key',
  'apikey',
  'key',
  'secret',
  'password',
  'passwd',
  'auth',
  'authorization',
]);

const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-session-token',
]);

const SENSITIVE_OBJECT_KEY_PATTERN =
  /(?:token|secret|password|passwd|authorization|cookie|api.?key|private.?key|signature|credential)/i;

const EXTENSION_URL_PATTERN = /\b(?:chrome|moz|safari|safari-web)-extension:\/\//i;
const STACK_FRAME_PATTERN = /:\d+:\d+\)?\s*$/;
const PREVIEW_ROUTE_PATTERN = /\/api\/projects\/[^/]+\/preview(?:\/|$|\?)/i;

export interface SanitizeOptions {
  readonly previewOrigin?: string | null;
  readonly dsnOrigin?: string | null;
}

export interface SentryLikeStackFrame {
  filename?: string;
  abs_path?: string;
  [key: string]: unknown;
}

export interface SentryLikeExceptionValue {
  type?: string;
  value?: string;
  stacktrace?: {
    frames?: SentryLikeStackFrame[];
  };
  [key: string]: unknown;
}

export interface SentryLikeBreadcrumb {
  category?: string;
  type?: string;
  message?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SentryLikeSpan {
  description?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SentryLikeEvent {
  type?: string;
  message?: string;
  transaction?: string;
  culprit?: string;
  exception?: {
    values?: SentryLikeExceptionValue[];
  };
  request?: {
    url?: string;
    headers?: Record<string, string>;
    query_string?: string | Record<string, unknown> | Array<[string, string]>;
    cookies?: Record<string, string>;
    data?: unknown;
    [key: string]: unknown;
  };
  breadcrumbs?: SentryLikeBreadcrumb[];
  spans?: SentryLikeSpan[];
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SentryLikeEventHint {
  originalException?: unknown;
  [key: string]: unknown;
}

function isSensitiveQueryKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_QUERY_KEYS.has(lower)) return true;
  return SENSITIVE_OBJECT_KEY_PATTERN.test(lower);
}

/**
 * Strips credentials and sensitive query parameters from absolute or relative URLs.
 */
export function sanitizeUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl;
  const trimmed = rawUrl.trim();
  const isRelative = trimmed.startsWith('/');
  try {
    const parsed = new URL(trimmed, isRelative ? 'https://openmotion.invalid' : undefined);
    parsed.username = '';
    parsed.password = '';
    if (parsed.search) {
      const nextParams = new URLSearchParams();
      for (const [key, value] of parsed.searchParams.entries()) {
        nextParams.append(key, isSensitiveQueryKey(key) ? REDACTED : value);
      }
      parsed.search = nextParams.toString();
    }
    if (isRelative) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return parsed.toString();
  } catch {
    return trimmed.replace(
      /([?&][^=&]*?(?:token|secret|password|sig|signature|credential|code|state|key|auth)[^=&]*=)[^&#\s]*/gi,
      `$1${REDACTED}`,
    );
  }
}

/**
 * Redacts credentials, tokens, private keys, email addresses, and sensitive URL query params from free text.
 */
export function sanitizeText(value: string): string {
  let text = String(value);
  text = text
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/((?:set-cookie|cookie|authorization|proxy-authorization)\s*:\s*)[^\r\n]+/gi, `$1${REDACTED}`)
    .replace(/\b(?:Bearer|Basic)\s+[^\s"',;}]+/gi, '[redacted authorization]')
    .replace(
      /([\w-]*(?:token|secret|password|passwd|authorization|cookie|api.?key)[\w-]*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /\b(?:sk-[\w-]{8,}|om_pat_[\w-]{8,}|sntry[su]_[\w-]{8,}|ph[cx]_[\w-]{8,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{12,}|AKIA[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g,
      '[redacted token]',
    )
    .replace(/https?:\/\/[^\s<>"')]+/gi, (match) => sanitizeUrl(match))
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]');
  return text;
}

export function sanitizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADER_KEYS.has(lower) || SENSITIVE_OBJECT_KEY_PATTERN.test(lower)) {
      cleaned[key] = REDACTED;
    } else if (typeof value === 'string') {
      cleaned[key] = sanitizeText(value);
    }
  }
  return cleaned;
}

function sanitizeRecord(
  record: Record<string, unknown> | undefined,
  depth = 0,
): Record<string, unknown> | undefined {
  if (!record || depth > 4) return record;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SENSITIVE_OBJECT_KEY_PATTERN.test(key)) {
      next[key] = REDACTED;
      continue;
    }
    if (typeof value === 'string') {
      if (
        key === 'url' ||
        key === 'from' ||
        key === 'to' ||
        key === 'http.url' ||
        key === 'url.full' ||
        key === 'location'
      ) {
        next[key] = sanitizeUrl(value);
      } else {
        next[key] = sanitizeText(value);
      }
    } else if (Array.isArray(value)) {
      next[key] = value.map((item) =>
        typeof item === 'string'
          ? sanitizeText(item)
          : item && typeof item === 'object'
            ? sanitizeRecord(item as Record<string, unknown>, depth + 1)
            : item,
      );
    } else if (value && typeof value === 'object') {
      next[key] = sanitizeRecord(value as Record<string, unknown>, depth + 1);
    } else {
      next[key] = value;
    }
  }
  return next;
}

export function isNoisyCompositionAssetError(message: string, name?: string | null): boolean {
  if (message.includes('Error fetching') && (message.includes('404') || message.includes('Not Found'))) {
    return true;
  }
  if (name === 'EncodingError' || message.includes('unsupported or unrecognizable format')) {
    return true;
  }
  if (message.includes('MEDIA_ERR_SRC_NOT_SUPPORTED')) {
    return true;
  }
  return false;
}

export function isExtensionOnlyStackText(stack: string | null | undefined): boolean {
  const frames = stack?.split('\n').filter((line) => STACK_FRAME_PATTERN.test(line)) ?? [];
  return frames.length > 0 && frames.every((line) => EXTENSION_URL_PATTERN.test(line));
}

function isPreviewSource(value: string | undefined, previewOrigin?: string | null): boolean {
  if (!value) return false;
  if (PREVIEW_ROUTE_PATTERN.test(value)) return true;
  if (!previewOrigin) return false;
  try {
    return new URL(value).origin === previewOrigin;
  } catch {
    return value.startsWith(previewOrigin);
  }
}

function collectFrameUrls(event: SentryLikeEvent): string[] {
  const urls: string[] = [];
  for (const ex of event.exception?.values ?? []) {
    for (const frame of ex.stacktrace?.frames ?? []) {
      const candidate = frame.abs_path || frame.filename;
      if (typeof candidate === 'string' && candidate.trim()) {
        urls.push(candidate.trim());
      }
    }
  }
  return urls;
}

/**
 * Mirrors Studio's noise suppression rules and enforces preview-origin isolation
 * so untrusted composition scripts or browser extensions never pollute alerts.
 */
export function shouldDropBrowserEvent(
  event: SentryLikeEvent,
  hint?: SentryLikeEventHint,
  options: SanitizeOptions = {},
): boolean {
  const original = hint?.originalException;
  const originalName =
    original instanceof Error
      ? original.name
      : original && typeof original === 'object' && 'name' in original && typeof original.name === 'string'
        ? original.name
        : null;
  const originalMessage =
    original instanceof Error
      ? original.message
      : typeof original === 'string'
        ? original
        : original && typeof original === 'object' && 'message' in original && typeof original.message === 'string'
          ? original.message
          : '';
  const originalStack = original instanceof Error ? original.stack : undefined;

  const firstEx = event.exception?.values?.[0];
  const eventName = firstEx?.type ?? originalName;
  const combinedMessage = [event.message, firstEx?.value, originalMessage].filter(Boolean).join(' ');

  if (/ResizeObserver loop/i.test(combinedMessage)) return true;
  if (eventName === 'AbortError') return true;
  if (isNoisyCompositionAssetError(combinedMessage, eventName)) return true;
  if (isExtensionOnlyStackText(originalStack)) return true;

  const frameUrls = collectFrameUrls(event);
  if (frameUrls.length > 0 && frameUrls.every((url) => EXTENSION_URL_PATTERN.test(url))) {
    return true;
  }
  if (
    frameUrls.length > 0 &&
    frameUrls.every((url) => isPreviewSource(url, options.previewOrigin))
  ) {
    return true;
  }
  if (
    frameUrls.length === 0 &&
    (isPreviewSource(event.culprit, options.previewOrigin) ||
      isPreviewSource(event.request?.url, options.previewOrigin))
  ) {
    return true;
  }

  return false;
}

export function sanitizeSentryBreadcrumb<T extends SentryLikeBreadcrumb>(
  breadcrumb: T,
  options: SanitizeOptions = {},
): T | null {
  const url = typeof breadcrumb.data?.url === 'string' ? breadcrumb.data.url : undefined;
  if (url && options.dsnOrigin) {
    try {
      if (new URL(url).origin === options.dsnOrigin) return null;
    } catch {
      // Fall through to normal sanitization for relative URLs.
    }
  }

  const next: SentryLikeBreadcrumb = { ...breadcrumb };
  if (typeof next.message === 'string') {
    next.message = sanitizeText(next.message);
  }
  if (next.data && typeof next.data === 'object') {
    next.data = sanitizeRecord(next.data);
  }
  return next as T;
}

export function sanitizeSentryEvent<T extends SentryLikeEvent>(
  event: T,
  options: SanitizeOptions = {},
): T {
  const next: SentryLikeEvent = { ...event };

  if (typeof next.message === 'string') {
    next.message = sanitizeText(next.message);
  }
  if (typeof next.transaction === 'string') {
    next.transaction = sanitizeUrl(next.transaction);
  }
  if (typeof next.culprit === 'string') {
    next.culprit = sanitizeText(next.culprit);
  }

  if (next.exception?.values) {
    next.exception = {
      ...next.exception,
      values: next.exception.values.map((ex) => ({
        ...ex,
        ...(typeof ex.value === 'string' ? { value: sanitizeText(ex.value) } : {}),
        ...(ex.stacktrace?.frames
          ? {
              stacktrace: {
                ...ex.stacktrace,
                frames: ex.stacktrace.frames.map((frame) => ({
                  ...frame,
                  ...(typeof frame.filename === 'string' ? { filename: sanitizeUrl(frame.filename) } : {}),
                  ...(typeof frame.abs_path === 'string' ? { abs_path: sanitizeUrl(frame.abs_path) } : {}),
                })),
              },
            }
          : {}),
      })),
    };
  }

  if (next.request) {
    const req = { ...next.request };
    if (typeof req.url === 'string') req.url = sanitizeUrl(req.url);
    if (req.headers) req.headers = sanitizeHeaders(req.headers);
    if (typeof req.query_string === 'string') {
      req.query_string = sanitizeUrl(`/?${req.query_string.replace(/^\?/, '')}`).replace(/^\/\??/, '');
    } else if (req.query_string && typeof req.query_string === 'object' && !Array.isArray(req.query_string)) {
      req.query_string = sanitizeRecord(req.query_string);
    } else if (Array.isArray(req.query_string)) {
      req.query_string = req.query_string.map(
        ([key, value]): [string, string] => [
          key,
          isSensitiveQueryKey(key) ? REDACTED : sanitizeText(value),
        ],
      );
    }
    delete req.cookies;
    delete req.data;
    next.request = req;
  }

  if (Array.isArray(next.breadcrumbs)) {
    next.breadcrumbs = next.breadcrumbs
      .map((crumb) => sanitizeSentryBreadcrumb(crumb, options))
      .filter((crumb): crumb is SentryLikeBreadcrumb => crumb !== null);
  }

  if (Array.isArray(next.spans)) {
    next.spans = next.spans.map((span) => ({
      ...span,
      ...(typeof span.description === 'string' ? { description: sanitizeText(span.description) } : {}),
      ...(span.data && typeof span.data === 'object' ? { data: sanitizeRecord(span.data) } : {}),
    }));
  }

  if (next.extra && typeof next.extra === 'object') {
    next.extra = sanitizeRecord(next.extra);
  }

  if (next.tags && typeof next.tags === 'object') {
    next.tags = sanitizeRecord(next.tags);
  }

  return next as T;
}
