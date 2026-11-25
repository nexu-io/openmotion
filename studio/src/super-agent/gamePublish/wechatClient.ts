/**
 * Calls to the local OpenMotion service for publishing a WeChat Mini Game
 * (gateway/wechat-minigame.ts). The upload key is sent once to be saved on this machine
 * and is never read back.
 */

const BASE = '/motion-api/publish/wechat';

export class WechatPublishError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'WechatPublishError';
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let code = 'REQUEST_FAILED';
    let message = `Request failed (${res.status})`;
    try {
      const payload = await res.json();
      if (payload?.error?.code) code = String(payload.error.code);
      if (payload?.error?.message) message = String(payload.error.message);
      else if (typeof payload?.error === 'string') message = payload.error;
    } catch {
      // Not JSON
    }
    throw new WechatPublishError(code, message, res.status);
  }
  return res.json() as Promise<T>;
}

export type WechatStepKey = 'account' | 'appid' | 'key' | 'ip' | 'port' | 'preview' | 'upload' | 'testers'
  | 'category' | 'review' | 'filing' | 'release';

/** Publish progress the local service keeps per game; the Agent's openmotion_game_wechat calls update it. */
export interface WechatPublishStatus {
  gameId: string;
  appid: string | null;
  hasKey: boolean;
  /** WeChat refused the saved key since it was saved: the page offers to replace the key file. */
  keyRejected?: boolean;
  steps: Array<{ key: WechatStepKey; status: 'done' | 'todo' | 'blocked' | 'unknown'; later: boolean; at?: string; detail?: string }>;
  current: WechatStepKey | null;
  preview: { createdAt: string; qrcodeUrl: string } | null;
  upload?: { state: 'done' | 'failed' | 'unknown'; version: string; at: string; error?: string };
  uploadedVersion?: string;
}

export const APPID_PATTERN = /^wx[0-9a-f]{16}$/i;

export const wechatClient = {
  state: (gameId: string) => call<WechatPublishStatus>(`/state/${encodeURIComponent(gameId)}`),
  saveKey: (appid: string, privateKey: string) =>
    call<{ appid: string; hasKey: boolean; savedAt: string }>('/credentials', { method: 'PUT', body: JSON.stringify({ appid, privateKey }) }),
};
