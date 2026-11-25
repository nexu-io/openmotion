import { useCallback, useSyncExternalStore } from 'react';
import type { SuperAgentFollowUpMode, SuperAgentPermissionMode } from '../../../shared/super-agent';
import { readStudioUiPreferences, writeStudioUiPreferences } from './studioUiPreferences';

const FOLLOW_UP_EVENT = 'motion:super-agent-follow-up-change';
const DEFAULT_FOLLOW_UP_BEHAVIOR: SuperAgentFollowUpMode = 'steer';
const DEFAULT_PERMISSION_MODE: SuperAgentPermissionMode = 'auto';

/** Reads the persisted default approval mode (`auto` by default, or `on-request`). */
export function savedPermissionMode(): SuperAgentPermissionMode {
  const value = readStudioUiPreferences().superAgentPermissionMode;
  return value === 'on-request' ? 'on-request' : DEFAULT_PERMISSION_MODE;
}

/** Updates the persisted default approval mode for new Super Agent conversations. */
export function savePermissionMode(mode: SuperAgentPermissionMode): void {
  const normalized: SuperAgentPermissionMode = mode === 'on-request' ? 'on-request' : 'auto';
  writeStudioUiPreferences({ superAgentPermissionMode: normalized });
}

/** Reads the persisted default follow-up behavior (`steer` by default, or `queue`). */
export function savedFollowUpBehavior(): SuperAgentFollowUpMode {
  const value = readStudioUiPreferences().superAgentFollowUpBehavior;
  return value === 'queue' ? 'queue' : DEFAULT_FOLLOW_UP_BEHAVIOR;
}

/** Updates the persisted default follow-up behavior and notifies active listeners. */
export function setFollowUpBehavior(mode: SuperAgentFollowUpMode): void {
  const normalized: SuperAgentFollowUpMode = mode === 'queue' ? 'queue' : 'steer';
  writeStudioUiPreferences({ superAgentFollowUpBehavior: normalized });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(FOLLOW_UP_EVENT));
  }
}

function subscribe(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === 'hf-studio-ui-preferences') listener();
  };
  window.addEventListener(FOLLOW_UP_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(FOLLOW_UP_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** React hook keeping Settings and Super Agent follow-up behavior synchronized. */
export function useFollowUpBehavior(): [SuperAgentFollowUpMode, (mode: SuperAgentFollowUpMode) => void] {
  const mode = useSyncExternalStore(subscribe, savedFollowUpBehavior, () => DEFAULT_FOLLOW_UP_BEHAVIOR);
  const update = useCallback((next: SuperAgentFollowUpMode) => {
    setFollowUpBehavior(next);
  }, []);
  return [mode, update];
}
