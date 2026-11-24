import { useState, type MouseEvent } from 'react';
import { Button } from 'open-design-ui/button';
import type { AccountSummary } from '../../../shared/provider-directory';
import { useI18n } from '../i18n/I18n';
import { gatewayRequest } from './gatewayClient';
import { notifyProvidersChanged } from './useProviderDirectory';
import type { CreativePage } from './exploreTracking';
import { trackMotion } from './tracking';
import styles from './StartEntry.module.css';

/**
 * Top-right call to action for visitors who are not signed in: it takes the avatar's place. One click starts the
 * OpenDesign browser sign-in (the same handoff as Settings > Account) and opens Settings > Account, where the sign-in
 * progress, the fallback link and any failure are shown.
 */
export function StartEntry({ account, trackingPage, openAccount }: { account: AccountSummary; trackingPage: CreativePage; openAccount: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const authorizing = account.state === 'authorizing';

  async function start(event: MouseEvent) {
    void trackMotion('ui_click', { page_name: trackingPage, area: 'header', element: 'start_sign_in', interaction_method: event.detail === 0 ? 'keyboard' : 'pointer' });
    if (authorizing) { openAccount(); return; }
    setBusy(true);
    try {
      await gatewayRequest<AccountSummary>('settings/account/login', 'POST', {});
      notifyProvidersChanged();
      window.dispatchEvent(new Event('motion:account-changed'));
    } catch {
      // Settings > Account reads the account again and shows why sign-in could not start.
    } finally {
      setBusy(false);
      openAccount();
    }
  }

  return <Button variant="plain" type="button" className={styles.start} disabled={busy} onClick={event => void start(event)}>
    {t(authorizing ? 'Signing in…' : 'Get started')}
  </Button>;
}
