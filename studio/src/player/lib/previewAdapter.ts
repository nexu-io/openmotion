/**
 * The boundary between Studio and a project preview.
 *
 * Same-origin previews can still expose their document and runtime directly.
 * Isolated previews must use this small, typed postMessage protocol instead.
 * The adapter deliberately checks the iframe window, origin, project and
 * project-scoped token before a message reaches editor code.
 */

export const PREVIEW_BRIDGE_SOURCE = "openmotion-preview-bridge" as const;
export const PREVIEW_BRIDGE_PARENT_SOURCE = "openmotion-studio" as const;
export const PREVIEW_BRIDGE_VERSION = 1 as const;

export type PreviewBridgeMessageType =
  | "preview-ready"
  | "select-element"
  | "selection-geometry"
  | "edit-element"
  | "timeline-state"
  | "playback-control"
  | "pick-mode"
  | "runtime-error"
  | "preview-replaced"
  | "handshake"
  | "response";

export interface PreviewBridgeMessage {
  readonly source: typeof PREVIEW_BRIDGE_SOURCE | typeof PREVIEW_BRIDGE_PARENT_SOURCE;
  readonly version: typeof PREVIEW_BRIDGE_VERSION;
  readonly type: PreviewBridgeMessageType;
  readonly projectId: string;
  readonly token: string;
  readonly requestId?: string;
  readonly [key: string]: unknown;
}

export interface PreviewAdapterOptions {
  readonly iframe: HTMLIFrameElement;
  readonly projectId?: string;
  readonly expectedOrigin?: string;
  readonly token?: string;
}

export interface PreviewAdapter {
  readonly iframe: HTMLIFrameElement;
  readonly projectId: string | null;
  readonly token: string | null;
  readonly targetOrigin: string;
  readonly sameOrigin: boolean;
  readonly document: () => Document | null;
  readonly window: () => Window | null;
  readonly accepts: (event: MessageEvent) => boolean;
  readonly send: (
    type: PreviewBridgeMessageType,
    payload?: Record<string, unknown>,
    requestId?: string,
  ) => string | null;
  readonly request: <T = unknown>(
    type: PreviewBridgeMessageType,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<T>;
}

function readUrl(iframe: HTMLIFrameElement): URL | null {
  try {
    return new URL(iframe.getAttribute("src") || iframe.src, window.location.href);
  } catch {
    return null;
  }
}

function readProjectId(url: URL | null, explicit?: string): string | null {
  if (explicit?.trim()) return explicit.trim();
  const match = url?.pathname.match(/\/api\/projects\/([^/]+)\/preview(?:\/|$)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function readToken(url: URL | null, explicit?: string): string | null {
  const token = explicit?.trim() || url?.searchParams.get("pt")?.trim();
  return token || null;
}

function normalizeOrigin(origin: string | null | undefined): string {
  if (!origin || origin === "null") return window.location.origin;
  try {
    return new URL(origin).origin;
  } catch {
    return window.location.origin;
  }
}

function randomRequestId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  return `preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBridgeMessage(value: unknown): value is PreviewBridgeMessage {
  return (
    isRecord(value) &&
    (value.source === PREVIEW_BRIDGE_SOURCE || value.source === PREVIEW_BRIDGE_PARENT_SOURCE) &&
    value.version === PREVIEW_BRIDGE_VERSION &&
    typeof value.type === "string" &&
    typeof value.projectId === "string" &&
    typeof value.token === "string"
  );
}

export function createPreviewAdapter(options: PreviewAdapterOptions): PreviewAdapter {
  const { iframe } = options;
  const url = readUrl(iframe);
  const targetOrigin = normalizeOrigin(options.expectedOrigin ?? url?.origin);
  const projectId = readProjectId(url, options.projectId);
  const token = readToken(url, options.token);
  const sameOrigin = targetOrigin === window.location.origin;

  const accepts = (event: MessageEvent): boolean => {
    if (event.source !== iframe.contentWindow || event.origin !== targetOrigin) return false;
    if (!isBridgeMessage(event.data) || event.data.source !== PREVIEW_BRIDGE_SOURCE) return false;
    if (projectId && event.data.projectId !== projectId) return false;
    if (!token || event.data.token !== token) return false;
    return true;
  };

  const send = (
    type: PreviewBridgeMessageType,
    payload: Record<string, unknown> = {},
    requestId?: string,
  ): string | null => {
    const target = iframe.contentWindow;
    if (!target || !projectId || !token) return null;
    const id = requestId ?? randomRequestId();
    target.postMessage(
      {
        ...payload,
        source: PREVIEW_BRIDGE_PARENT_SOURCE,
        version: PREVIEW_BRIDGE_VERSION,
        type,
        projectId,
        token,
        requestId: id,
      },
      targetOrigin,
    );
    return id;
  };

  const request = <T = unknown>(
    type: PreviewBridgeMessageType,
    payload: Record<string, unknown> = {},
    timeoutMs = 1500,
  ): Promise<T> => {
    const requestId = randomRequestId();
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error(`Preview request timed out: ${type}`));
      }, timeoutMs);
      const onMessage = (event: MessageEvent) => {
        if (!accepts(event)) return;
        if (event.data.type !== "response" || event.data.requestId !== requestId) return;
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        if (event.data.ok === false) reject(new Error(String(event.data.error || "Preview request failed")));
        else resolve(event.data.result as T);
      };
      window.addEventListener("message", onMessage);
      if (!send(type, payload, requestId)) {
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        reject(new Error("Preview bridge is not ready"));
      }
    });
  };

  return {
    iframe,
    projectId,
    token,
    targetOrigin,
    sameOrigin,
    document: () => {
      try {
        return iframe.contentDocument;
      } catch {
        return null;
      }
    },
    window: () => {
      try {
        return iframe.contentWindow;
      } catch {
        return null;
      }
    },
    accepts,
    send,
    request,
  };
}

export function isPreviewBridgeMessageValue(value: unknown): value is PreviewBridgeMessage {
  return isBridgeMessage(value);
}
