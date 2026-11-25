import type { MessageCenterFeedResponse } from '../../../../shared/growth-surfaces';
import { gatewayRequest } from '../gatewayClient';

const ANONYMOUS_READ_IDS_KEY = 'openmotion.message-center.anonymous-read-ids.v1';
const ARCHIVED_IDS_KEY = 'openmotion.message-center.archived-ids.v1';

function readIdSet(key: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0));
  } catch {
    return new Set();
  }
}

function writeIdSet(key: string, ids: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // Private browsing or storage quota errors remain non-fatal.
  }
}

export function readAnonymousReadIds(): Set<string> {
  return readIdSet(ANONYMOUS_READ_IDS_KEY);
}

export function writeAnonymousReadIds(ids: Set<string>): void {
  writeIdSet(ANONYMOUS_READ_IDS_KEY, ids);
}

export function clearAnonymousReadIds(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(ANONYMOUS_READ_IDS_KEY);
  } catch {
    // Ignore storage removal failures.
  }
}

export function readArchivedMessageIds(): Set<string> {
  return readIdSet(ARCHIVED_IDS_KEY);
}

export function writeArchivedMessageIds(ids: Set<string>): void {
  writeIdSet(ARCHIVED_IDS_KEY, ids);
}

export function fetchMessageCenterFeed(locale: string): Promise<MessageCenterFeedResponse> {
  return gatewayRequest<MessageCenterFeedResponse>(
    `message-center/messages?locale=${encodeURIComponent(locale)}`,
  );
}

export function markMessageCenterRead(messageId: string): Promise<{ ok: boolean }> {
  return gatewayRequest<{ ok: boolean }>(
    `message-center/messages/${encodeURIComponent(messageId)}/read`,
    'POST',
    {},
  );
}

export function markAllMessageCenterRead(): Promise<{ ok: boolean }> {
  return gatewayRequest<{ ok: boolean }>('message-center/read-all', 'POST', {});
}
