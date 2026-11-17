export const WORKSPACE_LOCATION_CHANGED = 'motion:workspace-location';
const entryKey = 'openmotionHistoryIndex';
const sessionKey = 'openmotionHistorySession';
const boundsPrefix = 'motion.workspace.history.';
const memoryBounds = new Map<string, number>();

export function workspaceHistoryIndex(): number | null {
  const value = history.state?.[entryKey];
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function workspaceHistorySession(): string | null {
  const value = history.state?.[sessionKey];
  return typeof value === 'string' && value ? value : null;
}

function lastIndex(session: string, fallback: number): number {
  try {
    const saved = sessionStorage.getItem(boundsPrefix + session);
    const index = saved === null ? null : Number(saved);
    if (index !== null && Number.isSafeInteger(index) && index >= 0) return index;
  } catch { /* Navigation still works when tab storage is unavailable. */ }
  return memoryBounds.get(session) ?? fallback;
}

function rememberLastIndex(session: string, index: number) {
  memoryBounds.set(session, index);
  try { sessionStorage.setItem(boundsPrefix + session, String(index)); } catch { /* Use memory until reload. */ }
}

export function initializeWorkspaceHistory() {
  if (workspaceHistoryIndex() === null || workspaceHistorySession() === null) {
    const session = crypto.randomUUID();
    history.replaceState({ ...history.state, [entryKey]: 0, [sessionKey]: session }, '', location.href);
    rememberLastIndex(session, 0);
  }
}

/** A bitmask keeps React snapshots stable without storing a second route stack. */
export function workspaceHistoryAvailability(): number {
  const index = workspaceHistoryIndex(), session = workspaceHistorySession();
  if (index === null || session === null) return 0;
  return (index > 0 ? 1 : 0) | (index < lastIndex(session, index) ? 2 : 0);
}

export function traverseWorkspaceHistory(delta: -1 | 1) {
  if (!(workspaceHistoryAvailability() & (delta < 0 ? 1 : 2))) return;
  history.go(delta);
}

/** Keep history identity when the editor updates its hash or the shell resolves a project. */
export function writeWorkspaceHistory(target: string | URL, replace = false) {
  const url = new URL(target, location.href);
  if (url.origin !== location.origin) throw new Error('Workspace navigation must stay on this origin');
  initializeWorkspaceHistory();
  const index = workspaceHistoryIndex()!;
  const session = workspaceHistorySession()!;
  if (url.href !== location.href) {
    if (replace) history.replaceState({ ...history.state, [entryKey]: index }, '', url);
    else {
      history.pushState({ [entryKey]: index + 1, [sessionKey]: session }, '', url);
      rememberLastIndex(session, index + 1);
    }
  }
  window.dispatchEvent(new Event(WORKSPACE_LOCATION_CHANGED));
}
