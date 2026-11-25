export type MessageCenterAudienceType = 'global' | 'targeted';

export interface MessageCenterMessage {
  id: string;
  messageKey?: string | null;
  audienceType: MessageCenterAudienceType;
  typeName: string;
  title: string;
  body: string;
  imageUrl?: string | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
  publishedAt: string;
  readAt: string | null;
}

export interface MessageCenterFeedResponse {
  signedIn: boolean;
  messages: MessageCenterMessage[];
  unreadCount: number;
}

export const GO_PLAN_SUNSET_MESSAGE_KEY_PREFIX = 'go-plan-sunset-2026-08';

export function findPriorityAnnouncementMessage(
  messages: readonly MessageCenterMessage[],
): MessageCenterMessage | null {
  return (
    messages.find(
      message =>
        message.audienceType === 'targeted' &&
        message.readAt == null &&
        Boolean(message.messageKey?.startsWith(GO_PLAN_SUNSET_MESSAGE_KEY_PREFIX)),
    ) ?? null
  );
}

export function toOpenDesignApiLocale(locale: string): string {
  const trimmed = locale.trim();
  const mapping: Record<string, string> = {
    en: 'en-US',
    'es-ES': 'es',
    'pt-BR': 'pt',
  };
  return mapping[trimmed] ?? (trimmed || 'en-US');
}

export function safeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function safeInternalPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512) return null;
  if (!/^\/(?!\/)/.test(trimmed) || trimmed.includes('\\')) return null;
  if (trimmed.split('/').some(segment => segment === '..')) return null;
  try {
    const resolved = new URL(trimmed, 'https://openmotion.invalid');
    return resolved.origin === 'https://openmotion.invalid' ? resolved.pathname + resolved.search + resolved.hash : null;
  } catch {
    return null;
  }
}

export const TOUCHPOINT_PLACEMENT_KEYS = [
  'opend.home.account-badge',
  'opend.home.campaign-modal',
] as const;

export type TouchpointPlacementKey = (typeof TOUCHPOINT_PLACEMENT_KEYS)[number];

export type TouchpointEventType = 'impression' | 'click' | 'dismiss' | 'action';

export interface ProductionTouchpointDecision {
  activityId: string;
  touchpointDecisionId: string;
  deploymentId?: string | null;
  placementKey: TouchpointPlacementKey;
  endsAt: string;
  authorizationExpiresAt?: string | null;
  serverTime?: string | null;
  badgeLabel: string;
  title: string;
  subtitle?: string | null;
  body: string;
  highlights: string[];
  imageUrl?: string | null;
  paidCtaLabel?: string | null;
  freeCtaLabel?: string | null;
  ctaUrl?: string | null;
  internalPath?: string | null;
  targetModelId?: string | null;
  targetModelLabel?: string | null;
}

export type ProductionTouchpointStatus = 'active' | 'none' | 'revoked' | 'unauthorized';

export interface ProductionTouchpointResponse {
  status: ProductionTouchpointStatus;
  decision: ProductionTouchpointDecision | null;
  offlineReplay: boolean;
}

export interface WhatsNewLocaleContent {
  title?: string;
  body?: string;
  linkUrl?: string;
  ctaLabel?: string;
}

export interface WhatsNewContent {
  title: string;
  body: string;
  imageUrl?: string;
  linkUrl?: string;
  ctaLabel?: string;
  locales?: Record<string, WhatsNewLocaleContent>;
}

export interface WhatsNewResponse {
  version: string;
  id: string | null;
  content: WhatsNewContent | null;
}

export function whatsNewNotesFromBody(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map(line => line.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);
}

export function localizeWhatsNewContent(
  content: WhatsNewContent,
  locale: string,
): {
  title: string;
  body: string;
  notes: string[];
  linkUrl: string | null;
  ctaLabel: string | null;
} {
  const locales = content.locales ?? {};
  const normalized = locale.trim().toLowerCase();
  const primary = normalized.split('-')[0];
  let matched: WhatsNewLocaleContent | undefined;

  if (locales[locale]) {
    matched = locales[locale];
  } else {
    for (const [key, entry] of Object.entries(locales)) {
      if (key.toLowerCase() === normalized) {
        matched = entry;
        break;
      }
    }
    if (!matched && primary) {
      for (const [key, entry] of Object.entries(locales)) {
        if (key.toLowerCase().split('-')[0] === primary) {
          matched = entry;
          break;
        }
      }
    }
  }

  const title = matched?.title?.trim() || content.title;
  const body = matched?.body?.trim() || content.body;
  const linkUrl = matched?.linkUrl?.trim() || content.linkUrl?.trim() || null;
  const ctaLabel = matched?.ctaLabel?.trim() || content.ctaLabel?.trim() || null;

  return {
    title,
    body,
    notes: whatsNewNotesFromBody(body),
    linkUrl,
    ctaLabel,
  };
}
