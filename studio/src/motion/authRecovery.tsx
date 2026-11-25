import { useCallback, useEffect, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { RemixIcon } from '../icons/RemixIcons';
import { useI18n } from '../i18n/I18n';
import { isDesktopApp, startDesktopBrowserLogin } from '../utils/platformHost';
import { buildLoginUrl } from './AccountSettings';
import {
  AUTH_RECOVERY_EVENT,
  clearAuthPendingDraft,
  currentReturnToPath,
  readAuthPendingDraft,
  restoreHomeDraftIfMissing,
  saveAuthPendingDraft,
  type AuthPendingDraft,
  type AuthRecoveryDetail,
} from './authRecoveryStore';

export * from './authRecoveryStore';

export interface AuthRecoveryNoticeProps {
  readonly onRetry?: () => void;
  readonly onResumePendingDraft?: (draft: AuthPendingDraft) => Promise<boolean> | boolean;
  readonly onLoginNavigate?: (url: string) => void;
}

/**
 * Global non-destructive auth recovery bar (A01 / A03):
 * - On `401 auth_required`: preserves local drafts, prompts the user to sign in again,
 *   and never reports the failed action as saved if the user cancels.
 * - On `503 auth_unavailable`: preserves session and drafts without forcing sign-in,
 *   offering a retry action instead.
 * - After returning from login with a preserved pending draft: lets the user resume once
 *   using the exact saved idempotency key so at most one project is created.
 */
export function AuthRecoveryNotice({
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
    window.addEventListener(AUTH_RECOVERY_EVENT, onRecovery);
    window.addEventListener('motion:account-changed', onAccountChanged);
    return () => {
      window.removeEventListener(AUTH_RECOVERY_EVENT, onRecovery);
      window.removeEventListener('motion:account-changed', onAccountChanged);
    };
  }, []);

  const handleSignIn = useCallback(() => {
    const targetReturnTo = recovery?.returnTo ?? pendingDraft?.returnTo ?? currentReturnToPath();
    if (!readAuthPendingDraft()) {
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
    return (
      <div
        className="om-auth-recovery-banner"
        role="alert"
        data-kind={recovery.kind}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <RemixIcon name={isUnavailable ? 'wifi-off-line' : 'lock-line'} size={16} />
          <span>
            {isUnavailable
              ? t('Temporarily unable to verify your login status. Your session and drafts are preserved — please retry shortly.')
              : t('Your session has expired. Your unsaved draft is preserved — sign in again to continue.')}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          {isUnavailable ? (
            <Button variant="ghost" className="om-button h-auto" data-primary onClick={handleRetry}>
              {t('Retry')}
            </Button>
          ) : (
            <Button variant="ghost" className="om-button h-auto" data-primary onClick={handleSignIn}>
              {t('Sign in again')}
            </Button>
          )}
          <Button variant="ghost" className="om-button h-auto" onClick={handleDismiss}>
            {t('Cancel')}
          </Button>
        </div>
      </div>
    );
  }

  if (pendingDraft && onResumePendingDraft && (pendingDraft.templateId || pendingDraft.instruction)) {
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
