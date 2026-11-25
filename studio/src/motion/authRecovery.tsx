import { useCallback, useEffect, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { RemixIcon } from '../icons/RemixIcons';
import { useI18n } from '../i18n/I18n';
import { isDesktopApp, startDesktopBrowserLogin } from '../utils/platformHost';
import { WORKSPACE_LOCATION_CHANGED } from '../utils/workspaceHistory';
import { buildLoginUrl } from './AccountSettings';
import * as tracking from './pageTracking';
import {
  AUTH_RECOVERY_EVENT,
  clearAuthPendingDraft,
  consumeAuthCancelledFromUrl,
  currentReturnToPath,
  hadAuthenticatedSession,
  hasPreservedUnsavedDraft,
  readAuthPendingDraft,
  restoreHomeDraftIfMissing,
  saveAuthPendingDraft,
  type AuthPendingDraft,
  type AuthRecoveryDetail,
} from './authRecoveryStore';

export * from './authRecoveryStore';

export interface AuthRecoveryNoticeProps {
  readonly signedIn?: boolean;
  readonly onRetry?: () => void;
  readonly onResumePendingDraft?: (draft: AuthPendingDraft) => Promise<boolean> | boolean;
  readonly onLoginNavigate?: (url: string) => void;
}

/**
 * Global non-destructive auth recovery bar (A01 / A03 / A09):
 * - On `401 auth_required`: distinguishes first-time guest sign-in from real session
 *   expiration, only mentions preserved unsaved drafts when one actually exists, and
 *   never reports a failed action as saved if the user cancels.
 * - On `503 auth_unavailable`: preserves session and drafts without forcing sign-in,
 *   offering a retry action instead.
 * - After returning from login with a preserved pending draft: lets the user resume once
 *   using the exact saved idempotency key so at most one project is created.
 */
export function AuthRecoveryNotice({
  signedIn = true,
  onRetry,
  onResumePendingDraft,
  onLoginNavigate,
}: AuthRecoveryNoticeProps) {
  const { t } = useI18n();
  const [recovery, setRecovery] = useState<AuthRecoveryDetail | null>(null);
  const [pendingDraft, setPendingDraft] = useState<AuthPendingDraft | null>(() => {
    const draft = readAuthPendingDraft();
    restoreHomeDraftIfMissing(draft);
    return draft;
  });
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    if (consumeAuthCancelledFromUrl()) {
      tracking.reportSettingsClick('account', 'cancel_sign_in');
      setRecovery(null);
      setPendingDraft(readAuthPendingDraft());
    }
  }, []);

  useEffect(() => {
    const onRecovery = (event: Event) => {
      const detail = (event as CustomEvent<AuthRecoveryDetail>).detail;
      if (!detail) return;
      setRecovery(detail);
      if (detail.draft) {
        setPendingDraft(detail.draft);
      }
    };
    const onAccountChanged = () => {
      setRecovery(null);
      const draft = readAuthPendingDraft();
      restoreHomeDraftIfMissing(draft);
      setPendingDraft(draft);
    };
    const onLocationChanged = () => {
      setRecovery(null);
    };
    window.addEventListener(AUTH_RECOVERY_EVENT, onRecovery);
    window.addEventListener('motion:account-changed', onAccountChanged);
    window.addEventListener(WORKSPACE_LOCATION_CHANGED, onLocationChanged);
    window.addEventListener('popstate', onLocationChanged);
    return () => {
      window.removeEventListener(AUTH_RECOVERY_EVENT, onRecovery);
      window.removeEventListener('motion:account-changed', onAccountChanged);
      window.removeEventListener(WORKSPACE_LOCATION_CHANGED, onLocationChanged);
      window.removeEventListener('popstate', onLocationChanged);
    };
  }, []);

  const handleSignIn = useCallback(() => {
    const targetReturnTo = recovery?.returnTo ?? pendingDraft?.returnTo ?? currentReturnToPath();
    if (!readAuthPendingDraft() && hasPreservedUnsavedDraft(recovery, pendingDraft)) {
      saveAuthPendingDraft({
        action: pendingDraft?.action ?? 'save_edit',
        returnTo: targetReturnTo,
        templateId: pendingDraft?.templateId,
        instruction: pendingDraft?.instruction,
        projectId: pendingDraft?.projectId,
      });
    }
    const url = buildLoginUrl(targetReturnTo);
    if (onLoginNavigate) {
      onLoginNavigate(url);
    } else if (isDesktopApp()) {
      void startDesktopBrowserLogin({ loginUrl: url, returnTo: targetReturnTo });
    } else {
      window.location.assign(url);
    }
  }, [recovery, pendingDraft, onLoginNavigate]);

  const handleDismiss = useCallback(() => {
    // Cancelling re-login closes the prompt while keeping local drafts preserved
    // and never marking the blocked operation as succeeded.
    setRecovery(null);
  }, []);

  const handleRetry = useCallback(() => {
    setRecovery(null);
    onRetry?.();
  }, [onRetry]);

  const handleResumeDraft = useCallback(async () => {
    if (!pendingDraft || resuming) return;
    setResuming(true);
    try {
      const ok = onResumePendingDraft ? await onResumePendingDraft(pendingDraft) : true;
      if (ok) {
        clearAuthPendingDraft();
        setPendingDraft(null);
      }
    } finally {
      setResuming(false);
    }
  }, [pendingDraft, resuming, onResumePendingDraft]);

  const handleDiscardDraft = useCallback(() => {
    clearAuthPendingDraft();
    setPendingDraft(null);
  }, []);

  if (recovery) {
    const isUnavailable = recovery.kind === 'auth_unavailable';
    const isSessionExpired =
      recovery.sessionExpired !== undefined
        ? recovery.sessionExpired
        : /session expired|revoked/i.test(recovery.message) || hadAuthenticatedSession();
    const hasDraft = hasPreservedUnsavedDraft(recovery, pendingDraft);
    const noticeMessage = isUnavailable
      ? t('Temporarily unable to verify your login status. Your session and drafts are preserved — please retry shortly.')
      : isSessionExpired
        ? hasDraft
          ? t('Your session has expired. Your unsaved draft is preserved — sign in again to continue.')
          : t('Your session has expired. Sign in again to continue.')
        : hasDraft
          ? t('Sign in with OpenDesign to continue. Your unsaved input is preserved.')
          : t('Sign in with OpenDesign to continue.');
    const signInLabel = isSessionExpired ? t('Sign in again') : t('Sign in with OpenDesign');
    return (
      <div
        className="om-auth-recovery-banner"
        role="alert"
        data-kind={recovery.kind}
        data-auth-state={isUnavailable ? 'unavailable' : isSessionExpired ? 'expired' : 'guest'}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <RemixIcon name={isUnavailable ? 'wifi-off-line' : 'lock-line'} size={16} />
          <span>{noticeMessage}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          {isUnavailable ? (
            <Button variant="ghost" className="om-button h-auto" data-primary onClick={handleRetry}>
              {t('Retry')}
            </Button>
          ) : (
            <Button variant="ghost" className="om-button h-auto" data-primary onClick={handleSignIn}>
              {signInLabel}
            </Button>
          )}
          <Button variant="ghost" className="om-button h-auto" onClick={handleDismiss}>
            {t('Cancel')}
          </Button>
        </div>
      </div>
    );
  }

  if (signedIn && pendingDraft && !pendingDraft.autoResume && onResumePendingDraft && (pendingDraft.templateId || pendingDraft.instruction)) {
    return (
      <div
        className="om-auth-recovery-banner"
        role="status"
        data-kind="pending_draft"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <RemixIcon name="history-line" size={16} />
          <span>{t('Your saved input is ready to resume after signing in.')}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          <Button variant="ghost" className="om-button h-auto" data-primary disabled={resuming} onClick={() => void handleResumeDraft()}>
            {t(resuming ? 'Resuming…' : 'Continue')}
          </Button>
          <Button variant="ghost" className="om-button h-auto" disabled={resuming} onClick={handleDiscardDraft}>
            {t('Dismiss')}
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
