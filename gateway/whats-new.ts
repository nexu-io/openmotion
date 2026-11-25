import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  safeHttpsUrl,
  type WhatsNewContent,
  type WhatsNewLocaleContent,
  type WhatsNewResponse,
} from '../shared/growth-surfaces.ts';
import type { Fetcher } from './network.ts';

const WHATS_NEW_RELEASE_CHANNELS = new Set(['beta', 'prerelease', 'preview', 'stable']);
const WHATS_NEW_CACHE_TTL_MS = 10 * 60 * 1000;
const WHATS_NEW_TIMEOUT_MS = 4_000;
const DEFAULT_WHATS_NEW_FILE = new URL('../docs/whats-new.json', import.meta.url);
const PACKAGE_JSON_FILE = new URL('../package.json', import.meta.url);

let cachedPackageVersion: string | null = null;
function readPackageVersion(): string {
  if (cachedPackageVersion) return cachedPackageVersion;
  try {
    const parsed = JSON.parse(readFileSync(PACKAGE_JSON_FILE, 'utf8')) as { version?: unknown };
    cachedPackageVersion = typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : '0.0.1';
  } catch {
    cachedPackageVersion = '0.0.1';
  }
  return cachedPackageVersion;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function isAllowedWhatsNewOverrideUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === 'https:') return true;
    return (
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

function parseLocaleOverrides(value: unknown): Record<string, WhatsNewLocaleContent> | undefined {
  if (!isRecord(value)) return undefined;
  const locales: Record<string, WhatsNewLocaleContent> = {};
  for (const [locale, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const override: WhatsNewLocaleContent = {};
    const title = readNonEmptyString(entry.title);
    const body = readNonEmptyString(entry.body);
    const linkUrl = safeHttpsUrl(entry.linkUrl);
    const ctaLabel = readNonEmptyString(entry.ctaLabel);
    if (title) override.title = title;
    if (body) override.body = body;
    if (linkUrl) override.linkUrl = linkUrl;
    if (ctaLabel) override.ctaLabel = ctaLabel;
    if (Object.keys(override).length > 0) locales[locale] = override;
  }
  return Object.keys(locales).length > 0 ? locales : undefined;
}

export function parseWhatsNewDocument(payload: unknown): { id: string | null; content: WhatsNewContent | null } {
  if (!isRecord(payload)) return { id: null, content: null };
  const id = readNonEmptyString(payload.id);
  const title = readNonEmptyString(payload.title);
  const body = readNonEmptyString(payload.body);
  if (!id || !title || !body) return { id: null, content: null };

  const imageUrl = safeHttpsUrl(payload.imageUrl);
  const linkUrl = safeHttpsUrl(payload.linkUrl);
  const ctaLabel = readNonEmptyString(payload.ctaLabel);
  const locales = parseLocaleOverrides(payload.locales);

  return {
    id,
    content: {
      title,
      body,
      ...(imageUrl ? { imageUrl } : {}),
      ...(linkUrl ? { linkUrl } : {}),
      ...(ctaLabel ? { ctaLabel } : {}),
      ...(locales ? { locales } : {}),
    },
  };
}

export type WhatsNewSourceMode =
  | { kind: 'disabled' }
  | { kind: 'url'; url: string }
  | { kind: 'local' };

export function resolveWhatsNewSource(env: NodeJS.ProcessEnv = process.env): WhatsNewSourceMode {
  const overrideUrl = env.OPENMOTION_WHATS_NEW_URL?.trim();
  if (overrideUrl) {
    return isAllowedWhatsNewOverrideUrl(overrideUrl) ? { kind: 'url', url: overrideUrl } : { kind: 'disabled' };
  }
  if (env.OPENMOTION_WHATS_NEW_ENABLED?.trim() === '1') {
    return { kind: 'local' };
  }
  const channel = (env.OPENMOTION_RELEASE_CHANNEL || env.MOTION_RELEASE_CHANNEL || '').trim().toLowerCase();
  if (WHATS_NEW_RELEASE_CHANNELS.has(channel)) {
    return { kind: 'local' };
  }
  return { kind: 'disabled' };
}

export interface WhatsNewServiceOptions {
  fetcher?: Fetcher;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  version?: string;
  localFileUrl?: URL | string;
  cacheTtlMs?: number;
}

export class WhatsNewService {
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly version: string;
  private readonly localFileUrl: URL | string;
  private readonly cacheTtlMs: number;
  private cached: { sourceKey: string; expiresAt: number; id: string | null; content: WhatsNewContent | null } | null = null;

  constructor(options: WhatsNewServiceOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.env = options.env ?? process.env;
    this.version = options.version ?? readPackageVersion();
    this.localFileUrl = options.localFileUrl ?? DEFAULT_WHATS_NEW_FILE;
    this.cacheTtlMs = options.cacheTtlMs ?? WHATS_NEW_CACHE_TTL_MS;
  }

  async readWhatsNew(): Promise<WhatsNewResponse> {
    const source = resolveWhatsNewSource(this.env);
    if (source.kind === 'disabled') {
      return { version: this.version, id: null, content: null };
    }

    if (source.kind === 'url') {
      const now = this.now();
      if (this.cached && this.cached.sourceKey === source.url && this.cached.expiresAt > now) {
        return { version: this.version, id: this.cached.id, content: this.cached.content };
      }
      try {
        const response = await this.fetcher(source.url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(WHATS_NEW_TIMEOUT_MS),
        });
        if (!response.ok) {
          return { version: this.version, id: null, content: null };
        }
        const parsed = parseWhatsNewDocument(await response.json());
        if (this.cacheTtlMs > 0) {
          this.cached = {
            sourceKey: source.url,
            expiresAt: now + this.cacheTtlMs,
            id: parsed.id,
            content: parsed.content,
          };
        }
        return { version: this.version, id: parsed.id, content: parsed.content };
      } catch {
        return { version: this.version, id: null, content: null };
      }
    }

    try {
      const text = await readFile(this.localFileUrl, 'utf8');
      const parsed = parseWhatsNewDocument(JSON.parse(text));
      return { version: this.version, id: parsed.id, content: parsed.content };
    } catch {
      return { version: this.version, id: null, content: null };
    }
  }
}

const defaultWhatsNewService = new WhatsNewService();

export function whatsNewFor(): WhatsNewService {
  return defaultWhatsNewService;
}
