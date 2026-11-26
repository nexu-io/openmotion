export const AUTH_PENDING_DRAFT_KEY = 'openmotion.auth.pending-draft.v1';
export const HOME_DRAFT_STORAGE_KEY = 'motion.home.draft.v1';
export const STUDIO_DRAFTS_STORAGE_KEY = 'openmotion.studio.drafts.v1';
export const HAD_AUTH_SESSION_KEY = 'openmotion.auth.had-session.v1';
export const AUTH_RECOVERY_EVENT = 'motion:auth-recovery';
export const AUTH_PENDING_DRAFT_CHANGED_EVENT = 'motion:auth-pending-draft-changed';
const PENDING_DRAFT_TTL_MS = 30 * 60_000;

function notifyAuthPendingDraftChanged(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event(AUTH_PENDING_DRAFT_CHANGED_EVENT));
  } catch {
    // Ignore event dispatch failures.
  }
}

export type AuthRecoveryKind = 'auth_required' | 'auth_unavailable';

export interface AuthPendingDraft {
  readonly returnTo: string;
  readonly action: 'create_project' | 'start_session' | 'use_template' | 'open_editor' | 'save_edit' | 'generic';
  readonly idempotencyKey: string;
  readonly templateId?: string;
  readonly instruction?: string;
  readonly projectId?: string;
  readonly homeDraftSnapshot?: string | null;
  readonly autoResume?: boolean;
  readonly savedAt: number;
}

export interface AuthRecoveryDetail {
  readonly kind: AuthRecoveryKind;
  readonly status: number;
  readonly message: string;
  readonly returnTo?: string;
  readonly draft?: AuthPendingDraft | null;
  readonly sessionExpired?: boolean;
  readonly hasDraft?: boolean;
}

export function markAuthenticatedSession(authenticated: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (authenticated) {
      window.sessionStorage.setItem(HAD_AUTH_SESSION_KEY, '1');
    } else {
      window.sessionStorage.removeItem(HAD_AUTH_SESSION_KEY);
    }
  } catch {
    // Ignore storage failures.
  }
}

export function hadAuthenticatedSession(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(HAD_AUTH_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

export function readPersistedStudioDrafts<T = Record<string, unknown>>(): Record<string, T> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(STUDIO_DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, T>;
  } catch {
    return {};
  }
}

function hasMeaningfulStudioDraft(draft: unknown): boolean {
  if (!draft || typeof draft !== 'object') return false;
  const record = draft as {
    prompt?: unknown;
    references?: unknown;
    relight?: unknown;
    videoChoices?: unknown;
  };
  if (typeof record.prompt === 'string' && record.prompt.trim().length > 0) return true;
  if (Array.isArray(record.references) && record.references.length > 0) return true;
  if (record.relight && typeof record.relight === 'object' && Object.keys(record.relight).length > 0) return true;
  if (record.videoChoices && typeof record.videoChoices === 'object' && Object.keys(record.videoChoices).length > 0) return true;
  return false;
}

export function savePersistedStudioDraft(key: string, draft: unknown): void {
  if (typeof window === 'undefined' || !key) return;
  try {
    const current = readPersistedStudioDrafts<Record<string, unknown>>();
    if (!hasMeaningfulStudioDraft(draft)) {
      if (!(key in current)) return;
      delete current[key];
    } else {
      const record = draft as Record<string, unknown>;
      // Persist only serializable creation fields (drop heavy Asset objects in `target`).
      const serializable: Record<string, unknown> = {
        modality: record.modality,
        prompt: typeof record.prompt === 'string' ? record.prompt : '',
        references: Array.isArray(record.references) ? record.references : [],
      };
      if (record.relight !== undefined) serializable.relight = record.relight;
      if (record.videoChoices !== undefined) serializable.videoChoices = record.videoChoices;
      if (record.shotPreferences !== undefined) serializable.shotPreferences = record.shotPreferences;
      if (typeof record.preferredModel === 'string') serializable.preferredModel = record.preferredModel;
      if (typeof record.model === 'string') serializable.model = record.model;
      if (record.parameters !== undefined) serializable.parameters = record.parameters;
      current[key] = serializable;
    }
    if (Object.keys(current).length === 0) {
      window.sessionStorage.removeItem(STUDIO_DRAFTS_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(STUDIO_DRAFTS_STORAGE_KEY, JSON.stringify(current));
    }
  } catch {
    // Ignore storage quota / private mode failures.
  }
}

export function clearPersistedStudioDraft(key: string): void {
  if (typeof window === 'undefined' || !key) return;
  try {
    const current = readPersistedStudioDrafts<Record<string, unknown>>();
    if (!(key in current)) return;
    delete current[key];
    if (Object.keys(current).length === 0) {
      window.sessionStorage.removeItem(STUDIO_DRAFTS_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(STUDIO_DRAFTS_STORAGE_KEY, JSON.stringify(current));
    }
  } catch {
    // Ignore storage failures.
  }
}

export function hasPersistedStudioDraft(): boolean {
  const drafts = readPersistedStudioDrafts();
  return Object.values(drafts).some(hasMeaningfulStudioDraft);
}

export function hasPreservedUnsavedDraft(
  detail?: AuthRecoveryDetail | null,
  pendingDraft?: AuthPendingDraft | null,
): boolean {
  if (detail?.hasDraft) return true;
  if (pendingDraft?.instruction?.trim()) return true;
  if (pendingDraft?.templateId) return true;
  if (pendingDraft?.homeDraftSnapshot?.trim()) return true;
  if (typeof window !== 'undefined') {
    try {
      if (window.localStorage.getItem(HOME_DRAFT_STORAGE_KEY)?.trim()) return true;
    } catch {
      // Ignore storage failures.
    }
  }
  return hasPersistedStudioDraft();
}

export function consumeAuthCancelledFromUrl(): boolean {
  if (typeof window === 'undefined') return false;
  const url = new URL(window.location.href);
  if (url.searchParams.get('auth_cancelled') !== '1') return false;
  url.searchParams.delete('auth_cancelled');
  const nextHref = `${url.pathname}${url.search}${url.hash}`;
  try {
    window.history.replaceState(window.history.state, '', nextHref);
  } catch {
    // Ignore history API restrictions in embedded frames.
  }
  cancelAuthPendingIntent();
  return true;
}

/**
 * The user declined to sign in (cancelled the OIDC page or dismissed the sign-in prompt).
 * A later, unrelated sign-in must never auto-submit or auto-create a project, while
 * user-entered drafts stay available for a manual resume.
 */
export function cancelAuthPendingIntent(): void {
  const existing = readAuthPendingDraft();
  if (!existing) return;
  if (existing.instruction?.trim() || existing.homeDraftSnapshot?.trim()) {
    const preserved: AuthPendingDraft = { ...existing, autoResume: false };
    try {
      window.sessionStorage.setItem(AUTH_PENDING_DRAFT_KEY, JSON.stringify(preserved));
    } catch {
      // Ignore storage failures.
    }
    notifyAuthPendingDraftChanged();
  } else {
    clearAuthPendingDraft();
  }
}

export function currentReturnToPath(): string {
  if (typeof window === 'undefined') return '/';
  const target = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return target.startsWith('/') ? target : '/';
}

export function saveAuthPendingDraft(
  input: Omit<AuthPendingDraft, 'returnTo' | 'idempotencyKey' | 'savedAt' | 'homeDraftSnapshot'> & {
    returnTo?: string;
    idempotencyKey?: string;
    homeDraftSnapshot?: string | null;
  },
): AuthPendingDraft {
  let homeDraftSnapshot = input.homeDraftSnapshot;
  if (homeDraftSnapshot === undefined && typeof window !== 'undefined') {
    try {
      homeDraftSnapshot = window.localStorage.getItem(HOME_DRAFT_STORAGE_KEY);
    } catch {
      homeDraftSnapshot = null;
    }
  }
  const existing = readAuthPendingDraft();
  const sameIntent =
    existing &&
    existing.action === input.action &&
    existing.templateId === input.templateId &&
    existing.instruction === input.instruction &&
    existing.projectId === input.projectId;

  const draft: AuthPendingDraft = {
    returnTo: input.returnTo ?? currentReturnToPath(),
    action: input.action,
    idempotencyKey: input.idempotencyKey ?? (sameIntent ? existing.idempotencyKey : crypto.randomUUID()),
    ...(input.templateId ? { templateId: input.templateId } : {}),
    ...(input.instruction ? { instruction: input.instruction } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(homeDraftSnapshot !== undefined ? { homeDraftSnapshot } : {}),
    ...(input.autoResume ? { autoResume: true } : {}),
    savedAt: Date.now(),
  };
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.setItem(AUTH_PENDING_DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Ignore storage quota / private mode failures.
    }
    notifyAuthPendingDraftChanged();
  }
  return draft;
}

export function readAuthPendingDraft(nowMs = Date.now()): AuthPendingDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(AUTH_PENDING_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthPendingDraft>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.idempotencyKey !== 'string') return null;
    if (typeof parsed.savedAt !== 'number' || nowMs - parsed.savedAt > PENDING_DRAFT_TTL_MS) {
      window.sessionStorage.removeItem(AUTH_PENDING_DRAFT_KEY);
      return null;
    }
    return {
      returnTo: typeof parsed.returnTo === 'string' && parsed.returnTo.startsWith('/') ? parsed.returnTo : '/',
      action: parsed.action ?? 'generic',
      idempotencyKey: parsed.idempotencyKey,
      ...(typeof parsed.templateId === 'string' ? { templateId: parsed.templateId } : {}),
      ...(typeof parsed.instruction === 'string' ? { instruction: parsed.instruction } : {}),
      ...(typeof parsed.projectId === 'string' ? { projectId: parsed.projectId } : {}),
      ...(parsed.homeDraftSnapshot !== undefined ? { homeDraftSnapshot: parsed.homeDraftSnapshot } : {}),
      ...(parsed.autoResume === true ? { autoResume: true } : {}),
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}

export function restoreHomeDraftIfMissing(draft: AuthPendingDraft | null): void {
  if (!draft?.homeDraftSnapshot || typeof window === 'undefined') return;
  try {
    if (!window.localStorage.getItem(HOME_DRAFT_STORAGE_KEY)) {
      window.localStorage.setItem(HOME_DRAFT_STORAGE_KEY, draft.homeDraftSnapshot);
    }
  } catch {
    // Ignore storage failures.
  }
}

export function clearAuthPendingDraft(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(AUTH_PENDING_DRAFT_KEY);
  } catch {
    // Ignore storage failures.
  }
  notifyAuthPendingDraftChanged();
}

export function classifyAuthHttpError(
  status: number,
  payload: Record<string, unknown>,
  fallbackMessage?: string,
): AuthRecoveryDetail | null {
  const errorCode = typeof payload.errorCode === 'string' ? payload.errorCode : undefined;
  const code = typeof payload.code === 'string' ? payload.code : undefined;
  const message =
    typeof payload.error === 'string'
      ? payload.error
      : fallbackMessage || (status === 503 ? 'Temporarily unable to verify login status.' : 'Sign in required.');

  if (status === 503 && (errorCode === 'auth_unavailable' || code === 'AUTH_UNAVAILABLE')) {
    return { kind: 'auth_unavailable', status: 503, message };
  }
  if (status === 401 && (errorCode === 'auth_required' || code === 'UNAUTHORIZED')) {
    const serverSessionExpired =
      typeof payload.sessionExpired === 'boolean' ? payload.sessionExpired : undefined;
    const inferredExpired = /session expired|revoked/i.test(message);
    const sessionExpired =
      serverSessionExpired === true || inferredExpired || hadAuthenticatedSession();
    return {
      kind: 'auth_required',
      status: 401,
      message,
      sessionExpired,
    };
  }
  return null;
}

export function notifyAuthRecovery(detail: AuthRecoveryDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AuthRecoveryDetail>(AUTH_RECOVERY_EVENT, { detail }));
}
