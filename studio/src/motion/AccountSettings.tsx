import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import * as tracking from './pageTracking';
import { Tooltip } from "../components/ui/Tooltip";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountSummary } from '../../../shared/provider-directory';
import { RemixIcon } from '../icons/RemixIcons';
import { useI18n } from '../i18n/I18n';
import { useToast } from '../hooks/useToast';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { gatewayRequest } from './gatewayClient';
import { GITHUB_REPOSITORY } from './githubRepository';
import { notifyProvidersChanged } from './useProviderDirectory';
import { activeAccountOffer, MULTIMODAL_CAPABILITIES } from './accountOffer';
import { SettingsError, SettingsLoading } from './settingsPrimitives';

export function useAccountSummary() {
  const [account, updateAccount] = useState<AccountSummary | null>(null), [error, setError] = useState(false);
  const request = useRef(0);
  const setAccount = useCallback((value: AccountSummary) => { request.current++; updateAccount(value); setError(false); }, []);
  const refresh = useCallback(async (billing = false) => {
    const current = ++request.current;
    try { const value = await gatewayRequest<AccountSummary>('settings/account' + (billing ? '?refresh=true' : '')); if (current === request.current) { updateAccount(value); setError(false); } }
    catch { if (current === request.current) setError(true); }
  }, []);
  useEffect(() => { void refresh(); const update = () => void refresh(); window.addEventListener('motion:account-changed', update); return () => { request.current++; window.removeEventListener('motion:account-changed', update); }; }, [refresh]);
  useEffect(() => {
    if (account?.state !== 'authorizing') return;
    const timer = setInterval(() => void refresh(), 1500); return () => clearInterval(timer);
  }, [account, refresh]);
  return { account, error, refresh, setAccount };
}
export function AccountSettings({ subscription = false, openProviders }: { subscription?: boolean; openProviders: () => void }) {
  const { t } = useI18n(), state = useAccountSummary(), toast = useToast();
  const [busy, setBusy] = useState(false), [refreshing, setRefreshing] = useState(false), [lastState, setLastState] = useState<string>();
  const [subscriptionUrl, setSubscriptionUrl] = useState<string>();
  const signedIn = state.account?.state === 'signed-in';
  // The local service opens the subscription page in the system browser, where sign-in happened, with a fresh entry
  // and a one-time account intent. When no browser could be launched, Studio tries the returned link itself; the
  // request has used up the click by then, so a blocked popup leaves a link that opens it on the next click.
  async function openSubscription(element: 'manage_subscription' | 'view_plans') {
    tracking.reportSettingsClick('account', element);
    setSubscriptionUrl(undefined);
    try {
      const { url, opened } = await gatewayRequest<{ url: string; opened: boolean }>('settings/account/subscription', 'POST', {});
      if (opened) return;
      const page = window.open(url, '_blank');
      if (page) page.opener = null; else setSubscriptionUrl(url);
    } catch { toast.showToast(t("Couldn't open your browser. Try again."), 'error'); }
  }
  const subscriptionButton = (element: 'manage_subscription' | 'view_plans', primary = false) => <Button variant="ghost" className="om-button h-auto" data-primary={primary || undefined} onClick={() => void openSubscription(element)}>
    {element === 'view_plans' && <RemixIcon name="sparkling-line" size={16} />}{t(element === 'view_plans' ? 'Upgrade to Plus' : 'Manage subscription')}<RemixIcon name="external-link-line" size={15} /></Button>;
  const subscriptionLink = subscriptionUrl && <a className="om-button" data-primary href={subscriptionUrl} target="_blank" rel="noreferrer" onClick={() => setSubscriptionUrl(undefined)}>{t('Continue in browser')}<RemixIcon name="external-link-line" size={15} /></a>;
  useEffect(() => {
    if (signedIn) void state.refresh(true);
  }, [signedIn, state.refresh]);
  useEffect(() => {
    if (lastState === 'authorizing' && state.account?.state === 'signed-in') {
      notifyProvidersChanged(); window.dispatchEvent(new Event('motion:account-changed')); toast.showToast(t('Signed in to OpenDesign'), 'info');
    }
    setLastState(state.account?.state);
  }, [state.account?.state, lastState, t, toast.showToast]);
  async function action(name: 'login' | 'logout' | 'cancel') {
    tracking.reportSettingsClick('account', name === 'login' ? 'sign_in' : name === 'logout' ? 'sign_out' : 'cancel_sign_in');
    setBusy(true);
    try { state.setAccount(await gatewayRequest<AccountSummary>('settings/account/' + name, 'POST', {})); notifyProvidersChanged(); window.dispatchEvent(new Event('motion:account-changed')); }
    catch (error) { toast.showToast(error instanceof Error ? error.message : t('Could not update account'), 'error'); }
    finally { setBusy(false); }
  }
  async function refreshBilling() {
    tracking.reportSettingsClick('account', 'refresh_billing');
    setRefreshing(true);
    try { await state.refresh(true); } finally { setRefreshing(false); }
  }
  const account = state.account, pending = account?.state === 'authorizing', expired = account?.state === 'reauth-required';
  const syncing = pending && account.syncing, failure = !pending && !signedIn ? account?.errorCode : undefined;
  const signIn = <Button variant="ghost" className="om-button h-auto" data-primary disabled={busy} onClick={() => void action('login')}><RemixIcon name={failure === 'setup_failed' ? 'refresh-line' : 'login-box-line'} size={17} />{t(failure === 'setup_failed' ? 'Retry' : expired || failure ? 'Sign in again' : 'Sign in with OpenDesign')}</Button>;
  // The connector opens the activation page itself; the link is the fallback, and leads only when opening failed.
  const browserLink = account?.authorizationUrl && !syncing && <a className="om-button" data-primary={account.browserOpened === false || undefined} href={account.authorizationUrl} target="_blank" rel="noreferrer">{t(account.browserOpened === false ? 'Continue in browser' : "Didn't open? Click here")}<RemixIcon name="external-link-line" size={15} /></a>;
  // The name leads when the account has one that differs from the email; the email is shown once either way.
  // Signed-out people learn what signing in unlocks; Free and Go accounts learn what upgrading unlocks.
  const signedOutGuide = !signedIn && !pending && !expired && !failure;
  const plan = signedIn && !account?.billingUnavailable ? account?.plan?.trim().toLowerCase() : undefined;
  const upgradeGuide = plan === 'free' || plan === 'go', offer = activeAccountOffer();
  const capabilities = <ul className="om-account-capabilities" aria-label={t('Multimodal')}>{MULTIMODAL_CAPABILITIES.map(item => <li key={item.label}><RemixIcon name={item.icon} size={16} />{t(item.label)}</li>)}</ul>;
  const offerNote = offer && <p className="om-account-offer"><RemixIcon name="sparkling-fill" size={15} /><strong>{t(offer.title)}</strong><span>{t(offer.detail)}</span></p>;
  const name = account?.user?.name?.trim(), email = account?.user?.email, named = Boolean(name) && name!.toLowerCase() !== email?.toLowerCase();
  return <div className="om-settings-page">
    {state.error ? <SettingsError retry={() => void state.refresh(true)} /> : !account ? <SettingsLoading /> : <>
      <div className="om-account-identity"><span className="om-avatar"><RemixIcon name="user-3-line" size={36} /></span><h1 className="om-title">{subscription ? t('Subscription & usage') : named ? name : email || t('Your OpenDesign account')}</h1><p className="om-muted">{(subscription || named) && email ? email : t('Your creative workspace, connected.')}</p></div>
      {signedOutGuide ? <section className="om-card om-plan-guide">
        <div className="om-plan-guide-head"><h2 className="om-title">{t('Sign in to start multimodal generation')}</h2><span className="om-badge" data-active="true">{t('Plus and above')}</span></div>
        <p className="om-muted">{t('Sign in, then upgrade to Plus to generate images, video, voiceovers and music right in OpenMotion. No API keys to set up.')}</p>
        {capabilities}{offerNote}
        <div className="om-settings-actions">{signIn}</div>
      </section> : <section className="om-card om-account-summary"><div><h2 className="om-subtitle">{t(signedIn ? 'Connected to OpenDesign' : syncing ? 'Finishing sign-in' : pending ? 'Complete sign-in in your browser' : expired ? 'OpenDesign sign-in expired' : 'Sign in to OpenDesign')}</h2><p className="om-muted">{t(signedIn ? 'Account models and your own providers can be selected side by side.' : expired ? 'Sign in again to keep using your account models, subscription and usage.' : 'Sign in with OpenDesign to sync your models, subscription and usage.')}</p>
        {pending && <p className="om-muted" role="status">{t(syncing ? 'Authorized. Syncing your account…' : account.authorizationUrl ? 'Waiting for browser authorization…' : 'Connecting to OpenDesign. Please wait…')}{account.userCode && !syncing && <strong className="om-account-code">{account.userCode}</strong>}</p>}
        {account.error && <p className="om-muted" role="alert">{t(account.error)}</p>}</div>
        <div className="om-settings-actions">{signedIn ? <Button variant="ghost" className="om-button h-auto" onClick={() => void action('logout')} disabled={busy}>{t('Sign out')}</Button> : pending ? <>{browserLink}<Button variant="ghost" className="om-button h-auto" disabled={busy || syncing} onClick={() => void action('cancel')}>{t('Cancel')}</Button></> : expired ? <>{signIn}<Button variant="ghost" className="om-button h-auto" onClick={() => void action('logout')} disabled={busy}>{t('Sign out')}</Button></> : <>{signIn}{failure === 'credentials_rejected' && <a className="om-button" href={`${GITHUB_REPOSITORY}/issues/new/choose`} target="_blank" rel="noreferrer">{t('Report an issue')}<RemixIcon name="external-link-line" size={15} /></a>}</>}</div>
      </section>}
      {upgradeGuide && <section className="om-card om-plan-guide" data-guide="upgrade">
        <div className="om-plan-guide-head"><h2 className="om-title om-plan-name">{plan === 'free' ? t('Free plan') : 'Go'}</h2><span className="om-badge">{t('Current plan')}</span></div>
        <p className="om-muted">{t('Upgrade to Plus to generate images, video, voiceovers and music. Pro and Max include them too.')}</p>
        {capabilities}{offerNote}
        <div className="om-settings-actions">{subscriptionButton('view_plans', true)}{subscriptionButton('manage_subscription')}{subscriptionLink}</div>
      </section>}
      <section className="om-settings-section"><div className="om-settings-row"><h2 className="om-subtitle">{t('Subscription & usage')}</h2>{signedIn && <Tooltip label={t('Refresh account')} wrap><IconButton variant="ghost" className="motion-icon-button" aria-label={t('Refresh account')} disabled={refreshing} aria-busy={refreshing} onClick={() => void refreshBilling()} icon={<RemixIcon name={refreshing ? 'loader-4-line' : 'refresh-line'} size={17} className={refreshing ? 'animate-spin motion-reduce:animate-none' : undefined} />} /></Tooltip>}</div>
        {!(signedIn && account.billingUnavailable) && <div className="om-account-metrics"><div className="om-card"><span className="om-muted">{t('Current plan')}</span><h3 className="om-title">{signedIn && account.plan ? account.plan === 'free' ? t('Free plan') : account.plan : '—'}</h3><p className="om-muted">{t(signedIn ? 'Managed by OpenDesign' : 'Sign in to view your plan')}</p></div><div className="om-card"><span className="om-muted">{t('Available balance')}</span><h3 className="om-title">{signedIn && account.balance != null ? `$${account.balance}` : '—'}</h3><p className="om-muted">{t(signedIn ? 'Account credits in USD' : 'Sign in to view usage')}</p></div></div>}
        {signedIn && account.billingUnavailable && <div className="om-settings-row"><p className="om-muted">{t(account.billingError?.status === 403 ? "The billing service declined this request. Open Manage subscription to check your plan in OpenDesign." : "Couldn't load your plan and balance. Account models are unaffected and can be used as usual.")}</p><Button variant="ghost" className="om-button h-auto" disabled={refreshing} aria-busy={refreshing} onClick={() => void refreshBilling()}><RemixIcon name={refreshing ? 'loader-4-line' : 'refresh-line'} size={15} className={refreshing ? 'animate-spin motion-reduce:animate-none' : undefined} />{t('Refresh')}</Button></div>}
        {signedIn && !upgradeGuide && <>{subscriptionButton('manage_subscription')}{subscriptionLink}</>}
      </section>
      <section className="om-card om-settings-row"><div><h2 className="om-subtitle">{t('Your models, your choice')}</h2><p className="om-muted">{t('Use account models or connect your own API keys. Choose a default for each capability.')}</p></div><Button variant="ghost" className="om-button h-auto" onClick={openProviders}>{t('Model providers')}<RemixIcon name="arrow-right-line" size={15} /></Button></section>
    </>}
    <StudioToastViewport {...toast} />
  </div>;
}
