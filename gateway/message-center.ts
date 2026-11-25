import {
  safeHttpsUrl,
  toOpenDesignApiLocale,
  type MessageCenterFeedResponse,
  type MessageCenterMessage,
} from '../shared/growth-surfaces.ts';
import type { Fetcher } from './network.ts';
import { productionApi } from './opendesign.ts';
import type { WorkspaceCollabAccountClient } from './workspace-collab.ts';

export interface MessageCenterAccountClient {
  getControlSession: WorkspaceCollabAccountClient['getControlSession'];
}

export class MessageCenterRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeMessage(raw: unknown): MessageCenterMessage | null {
  if (!isRecord(raw)) return null;
  const id = readString(raw.id);
  if (!id) return null;
  const title = readString(raw.title);
  const body = readString(raw.body);
  if (!title && !body) return null;
  const audienceType = raw.audienceType === 'targeted' ? 'targeted' : 'global';
  const typeName = readString(raw.typeName) || 'announcement';
  const messageKey = readString(raw.messageKey) || null;
  const imageUrl = safeHttpsUrl(raw.imageUrl);
  const ctaUrl = safeHttpsUrl(raw.ctaUrl);
  const rawCtaLabel = readString(raw.ctaLabel);
  const ctaLabel = ctaUrl && rawCtaLabel ? rawCtaLabel : null;
  const publishedAt = readString(raw.publishedAt) || new Date().toISOString();
  const readAt = readString(raw.readAt) || null;

  return {
    id,
    ...(messageKey ? { messageKey } : {}),
    audienceType,
    typeName,
    title: title || typeName,
    body,
    ...(imageUrl ? { imageUrl } : {}),
    ctaLabel,
    ctaUrl,
    publishedAt,
    readAt,
  };
}

export class MessageCenterService {
  private readonly account: MessageCenterAccountClient;
  private readonly fetcher: Fetcher;
  private readonly publicApiUrl: string;

  constructor(
    account: MessageCenterAccountClient,
    options: { fetcher?: Fetcher; publicApiUrl?: string } = {},
  ) {
    this.account = account;
    this.fetcher = options.fetcher ?? fetch;
    this.publicApiUrl = (
      options.publicApiUrl?.trim() ||
      process.env.OPENMOTION_ACCOUNT_API_URL?.trim() ||
      productionApi
    ).replace(/\/$/, '');
  }

  async listMessages(locale = 'en'): Promise<MessageCenterFeedResponse> {
    const session = await this.account.getControlSession();
    const apiBase = (session?.apiUrl || this.publicApiUrl).replace(/\/$/, '');
    const apiLocale = toOpenDesignApiLocale(locale);
    const seenCursors = new Set<string>();
    const messages: MessageCenterMessage[] = [];
    let cursor: string | null = null;

    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
      const params = new URLSearchParams({ locale: apiLocale, limit: '50' });
      if (cursor) params.set('cursor', cursor);

      let response: Response;
      try {
        response = await this.fetcher(`${apiBase}/api/v1/message-center/messages?${params.toString()}`, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            ...(session ? { authorization: `Bearer ${session.controlKey}` } : {}),
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new MessageCenterRequestError(502, 'message_center_unavailable', 'Could not reach message center.');
      }

      if (!response.ok) {
        if (!session && (response.status === 401 || response.status === 403 || response.status === 404)) {
          return { signedIn: false, messages: [], unreadCount: 0 };
        }
        throw new MessageCenterRequestError(
          502,
          'message_center_unavailable',
          `Message center returned status ${response.status}.`,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new MessageCenterRequestError(502, 'message_center_unavailable', 'Invalid message center payload.');
      }

      if (!isRecord(payload) || !Array.isArray(payload.messages)) {
        throw new MessageCenterRequestError(502, 'message_center_unavailable', 'Malformed message center payload.');
      }

      for (const item of payload.messages) {
        const clean = sanitizeMessage(item);
        if (clean) messages.push(clean);
      }

      const nextCursor = readString(payload.nextCursor) || null;
      if (!nextCursor) break;
      if (nextCursor === cursor || seenCursors.has(nextCursor)) {
        throw new MessageCenterRequestError(502, 'message_center_unavailable', 'Pagination cursor did not advance.');
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    const unreadCount = messages.filter(item => item.readAt == null).length;
    return {
      signedIn: Boolean(session),
      messages,
      unreadCount,
    };
  }

  async markRead(messageId: string): Promise<{ ok: true }> {
    const cleanId = messageId.trim();
    if (!cleanId || cleanId.length > 256) {
      throw new MessageCenterRequestError(400, 'invalid_message_id', 'Message ID is required.');
    }
    const session = await this.account.getControlSession();
    if (!session) {
      throw new MessageCenterRequestError(401, 'unauthorized', 'Sign in with OpenDesign first.');
    }

    let response: Response;
    try {
      response = await this.fetcher(
        `${session.apiUrl.replace(/\/$/, '')}/api/v1/message-center/messages/${encodeURIComponent(cleanId)}/read`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${session.controlKey}`,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch {
      throw new MessageCenterRequestError(502, 'message_center_unavailable', 'Failed to mark message read.');
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new MessageCenterRequestError(401, 'unauthorized', 'OpenDesign credentials were rejected.');
      }
      throw new MessageCenterRequestError(502, 'message_center_unavailable', 'Failed to mark message read.');
    }
    return { ok: true };
  }

  async markAllRead(): Promise<{ ok: true }> {
    const session = await this.account.getControlSession();
    if (!session) {
      throw new MessageCenterRequestError(401, 'unauthorized', 'Sign in with OpenDesign first.');
    }

    let response: Response;
    try {
      response = await this.fetcher(`${session.apiUrl.replace(/\/$/, '')}/api/v1/message-center/read-all`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${session.controlKey}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new MessageCenterRequestError(502, 'message_center_unavailable', 'Failed to mark notifications read.');
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new MessageCenterRequestError(401, 'unauthorized', 'OpenDesign credentials were rejected.');
      }
      throw new MessageCenterRequestError(502, 'message_center_unavailable', 'Failed to mark notifications read.');
    }
    return { ok: true };
  }
}

const messageCenterServices = new WeakMap<MessageCenterAccountClient, MessageCenterService>();

export function messageCenterFor(
  account: MessageCenterAccountClient,
  options?: { fetcher?: Fetcher; publicApiUrl?: string },
): MessageCenterService {
  let instance = messageCenterServices.get(account);
  if (!instance) {
    instance = new MessageCenterService(account, options);
    messageCenterServices.set(account, instance);
  }
  return instance;
}
