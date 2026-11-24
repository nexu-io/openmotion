import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import type { ExploreCommunity } from '../../../shared/studio-catalog';
import { BrandLogo } from '../../../packages/design-system/react/BrandLogo';
import { brand } from '../../../packages/design-system/index.js';
import { RemixIcon } from '../icons/RemixIcons';
import { Menu, MenuItem, MenuSeparator, MenuSubmenu, MenuRadioGroup, MenuRadioItem } from '../components/ui/Menu';
import { Tooltip } from '../components/ui/Tooltip';
import { languages, useI18n, type Locale } from '../i18n/I18n';
import { setStudioTheme, useStudioThemePreference } from '../utils/studioTheme';
import {
  exportDesktopDiagnosticBundle,
  getDesktopBridge,
  isDesktopApp,
  useDesktopChrome,
} from '../utils/platformHost';
import { useWorkspaceChrome } from './WorkspaceFrame';
import { useAccountSummary } from './AccountSettings';
import { CommunityLink } from './CommunityLink';
import { clickMethod, clickOption, trackStudioClick } from './editorTracking';
import { GitHubLink } from './GitHubLink';
import { repositorySupportLinks } from './githubRepository';
import type { SettingsSection } from './workspacePageRouting';
import { useLayoutEffect, useRef, useState } from 'react';

import { CreativeNavigation, type CreativeNavigationProps } from './CreativeNavigation';
import { PricingEntry } from './PricingEntry';
import { useBlackFridayActive } from './campaignAttribution';
import { WorkspaceResourceActions } from './WorkspaceResourceActions';
import { WorkspaceSearch } from './WorkspaceSearch';
import { WorkspaceSwitcher } from './collab/WorkspaceSwitcher';
import { useOptionalWorkspaceCollab } from './WorkspaceCollabContext';
import { preloadWorkspacePage } from '../router/lazyPages';

const avatarSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const themeLabels = { light: 'Light', dark: 'Dark', system: 'System' } as const;

export function ApplicationHeader({ settings, atExploreHome, onSkill, openAsset, onCommunity, openSettings, ...navigation }: CreativeNavigationProps & {
  onSkill: (id: string) => void;
  atExploreHome: boolean;
  settings: SettingsSection | null;
  openSettings: (section: SettingsSection) => void;
  openAsset: (assetId: string, version: string) => void;
  onCommunity: (community: ExploreCommunity) => void;
}) {
  const { t } = useI18n();
  const { openAssets, openHome } = useWorkspaceChrome();
  const { account } = useAccountSummary();
  const collab = useOptionalWorkspaceCollab();
  const signedInHub = account?.state === 'signed-in' || Boolean(collab?.snapshot?.signedIn);
  const homeHint = atExploreHome ? undefined : t('Back to Explore');
  const header = useRef<HTMLElement>(null);
  const desktopChrome = useDesktopChrome();
  const desktopBridge = getDesktopBridge();
  const [compactActions, setCompactActions] = useState(false);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => setCompactActions(entry.contentRect.width <= 560));
    observer.observe(header.current!);
    return () => observer.disconnect();
  }, []);

  function workspaceActions(closeMenu?: () => void) {
    return <>
      <WorkspaceSearch onChoose={closeMenu} onSkill={onSkill} destination={navigation.destination} onLibrary={openAssets} onAccount={() => openSettings('account')} onAsset={openAsset} onScene={navigation.onNavigate} onStudio={navigation.onChooseStudio} onCommunity={onCommunity} />
      <WorkspaceResourceActions onBrandKit={() => openSettings('brand-kit')} brandKitOpen={settings === 'brand-kit'} closeMenu={closeMenu} />
    </>;
  }

  return <header ref={header} className="om-app-header">
    <Tooltip label={homeHint} side="bottom"><Button variant="plain" type="button" className="om-nav-item om-app-brand" onPointerEnter={() => preloadWorkspacePage('explore')} onFocus={() => preloadWorkspacePage('explore')} onClick={openHome} aria-label={homeHint ? `${brand.editorName} · ${homeHint}` : brand.editorName}><BrandLogo variant="editor" compact /></Button></Tooltip>
    <WorkspaceSwitcher />
    <CreativeNavigation {...navigation} overflowActions={compactActions ? workspaceActions : undefined} />
    <div className="om-app-header-actions">
      {!compactActions && workspaceActions()}
      <div className="om-app-header-links"><CommunityLink /><GitHubLink /></div>
      {!signedInHub && <PricingEntry trackingPage={navigation.trackingPage} />}
      <ApplicationAccountMenu settings={settings} openSettings={openSettings} />
      {desktopChrome?.customWindowControls && desktopBridge && (
        <div className="om-desktop-window-controls" role="group" aria-label={t('Window controls')}>
          <IconButton
            variant="plain"
            type="button"
            className="om-nav-item"
            aria-label={t('Minimize window')}
            onClick={() => void desktopBridge.windowMinimize()}
            icon={<RemixIcon name="subtract-line" size={14} />}
          />
          <IconButton
            variant="plain"
            type="button"
            className="om-nav-item"
            aria-label={t(desktopChrome.maximized ? 'Restore window' : 'Maximize window')}
            onClick={() => void desktopBridge.windowToggleMaximize()}
            icon={<RemixIcon name="checkbox-blank-line" size={12} />}
          />
          <IconButton
            variant="plain"
            type="button"
            className="om-nav-item om-desktop-window-close"
            aria-label={t('Close window')}
            onClick={() => void desktopBridge.windowClose()}
            icon={<RemixIcon name="close-line" size={14} />}
          />
        </div>
      )}
    </div>
  </header>;
}
export function WorkspaceUtilityActions({ openSettings }: { openSettings: (section: SettingsSection) => void }) {
  const { t } = useI18n();
  const item = (label: string, icon: string, action: () => void) => (
    <Tooltip label={t(label)} side="top">
      <IconButton variant="ghost" className="motion-icon-button" aria-label={t(label)} onPointerEnter={() => preloadWorkspacePage('settings')} onFocus={() => preloadWorkspacePage('settings')} onClick={action} icon={<RemixIcon name={icon} size={18} />} />
    </Tooltip>
  );
  return <nav className="motion-sidebar-utilities" aria-label={t('Application navigation')}>
    {item('Settings', 'settings-3-line', () => openSettings('general'))}
    {item('Model providers', 'brain-line', () => openSettings('providers'))}
    {item('Help', 'question-line', () => openSettings('help'))}
  </nav>;
}

function formatHubResetDate(iso: string | null, formatDate: (date: Date, options?: Intl.DateTimeFormatOptions) => string): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return formatDate(new Date(time), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ApplicationAccountMenu({ settings, openSettings }: { settings: SettingsSection | null; openSettings: (section: SettingsSection) => void }) {
  const { t, locale, setLocale, formatDate } = useI18n();
  const desktopApp = isDesktopApp();
  const { account } = useAccountSummary();
  const collab = useOptionalWorkspaceCollab();
  const campaign = useBlackFridayActive();
  const theme = useStudioThemePreference();
  const [refreshingQuota, setRefreshingQuota] = useState(false);

  const snapshot = collab?.snapshot;
  const signedIn = account?.state === 'signed-in' || Boolean(snapshot?.signedIn);
  const activeWs = snapshot?.activeWorkspace ?? null;
  const quota = snapshot?.quota ?? null;
  const referral = snapshot?.referral ?? null;
  const userName = account?.user?.name?.trim() || snapshot?.user?.name?.trim() || account?.user?.email?.trim() || snapshot?.user?.email?.trim() || t('Account');
  const userEmail = account?.user?.email?.trim() || snapshot?.user?.email?.trim() || '';
  const avatarInitial = avatarSegmenter.segment(userName)[Symbol.iterator]().next().value?.segment;

  const isLocked = activeWs?.lifecycleState === 'locked' || activeWs?.lifecycleState === 'billing_past_due';
  const isWarning = Boolean(quota && (isLocked || !quota.hasAvailableFunds || quota.weeklyLimitExhausted));
  const pillCredits = quota?.creditsUsd !== null && quota?.creditsUsd !== undefined ? `$${quota.creditsUsd}` : null;
  const pillSummary = quota
    ? quota.weeklyPercentLeft !== null
      ? `${quota.weeklyPercentLeft}%`
      : pillCredits ?? quota.planLabel
    : null;
  const resetText = formatHubResetDate(quota?.weeklyResetsAt ?? null, formatDate);
  const canManageBilling = Boolean(snapshot?.permissions.canManageBilling);
  const primaryDestination = isLocked ? 'billing-recovery' : 'plans';
  const openingPrimary = collab?.openingCloudDestination === primaryDestination;
  const openingBilling = collab?.openingCloudDestination === 'billing';
  const showHubSummary = Boolean(signedIn && collab && activeWs && quota);

  return <Menu
    tooltip={t('Account menu')}
    modal={false}
    side="bottom"
    align="end"
    aria-label={t('Account menu')}
    className={showHubSummary ? 'om-account-menu om-account-hub-menu om-selection-panel om-menu-panel' : 'om-account-menu om-selection-panel om-menu-panel'}
    trigger={
      <Button
        variant="plain"
        type="button"
        className={showHubSummary ? 'om-nav-item om-account-trigger om-account-hub-trigger' : 'om-nav-item om-account-trigger'}
        data-warning={isWarning || undefined}
        data-promo={campaign && !isWarning ? true : undefined}
        aria-current={settings === 'account' || settings === 'subscription' ? 'page' : undefined}
        aria-label={t('Account menu')}
        onPointerEnter={() => preloadWorkspacePage('settings')}
        onFocus={() => preloadWorkspacePage('settings')}
      >
        {showHubSummary && quota && (
          <span className="om-account-hub-pill-meta">
            <span className="om-account-hub-pill-bolt" aria-hidden="true">
              <RemixIcon name="flashlight-fill" size={13} />
            </span>
            <span className="om-account-hub-pill-plan">{quota.planLabel}</span>
            <span className="om-account-hub-pill-sep" aria-hidden="true">·</span>
            <span className="om-account-hub-pill-val">{pillSummary}</span>
            {campaign && !isWarning && (
              <span className="om-account-hub-promo-chip">50% OFF</span>
            )}
          </span>
        )}
        <span className="om-avatar" aria-hidden="true">
          {signedIn ? avatarInitial : <><RemixIcon className="om-default-avatar-icon om-default-avatar-icon-outline" name="user-3-line" size={14} /><svg className="om-default-avatar-icon om-default-avatar-icon-solid" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 22H4V20C4 17.2386 6.23858 15 9 15H15C17.7614 15 20 17.2386 20 20V22ZM12 13C8.68629 13 6 10.3137 6 7C6 3.68629 8.68629 1 12 1C15.3137 1 18 3.68629 18 7C18 10.3137 15.3137 13 12 13Z" /></svg></>}
        </span>
      </Button>
    }
  >
      <MenuItem onClick={() => openSettings('account')}>
        <span className="om-menu-label om-account-hub-identity">
          <RemixIcon name="user-3-line" size={16} />
          <span className="om-account-hub-identity-copy">
            <strong>{userName}</strong>
            {userEmail && userEmail !== userName && <span className="om-account-hub-identity-email">{userEmail}</span>}
          </span>
          {activeWs && (
            <span className="om-collab-pill">
              {t(activeWs.workspaceType === 'team' ? 'Team' : 'Personal')}
            </span>
          )}
        </span>
      </MenuItem>

      {showHubSummary && collab && activeWs && quota && (
        <div
          className="om-account-hub-card"
          data-promo={campaign && !isWarning ? true : undefined}
          data-warning={isWarning || undefined}
          data-testid="account-hub-quota"
        >
          <div className="om-account-hub-card-head">
            <span className="om-account-hub-plan-row">
              <span className="om-account-hub-plan-badge">{t('{plan} plan', { plan: quota.planLabel })}</span>
              {campaign && <span className="om-account-hub-promo-chip">50% OFF</span>}
            </span>
            <IconButton
              variant="ghost"
              size="sm"
              aria-label={t('Refresh quota')}
              disabled={refreshingQuota}
              onClick={event => {
                event.stopPropagation();
                setRefreshingQuota(true);
                void collab.refresh(true).finally(() => setRefreshingQuota(false));
              }}
              icon={
                <RemixIcon
                  name={refreshingQuota ? 'loader-4-line' : 'refresh-line'}
                  size={14}
                  className={refreshingQuota ? 'animate-spin motion-reduce:animate-none' : undefined}
                />
              }
            />
          </div>

          <div className="om-account-hub-credits-hero">
            <div className="om-account-hub-credits-meta">
              <span className="om-account-hub-credits-label">{t('Available credits')}</span>
              <span className="om-account-hub-sub">
                {t(activeWs.workspaceType === 'team' ? 'Shared workspace credits in USD' : 'Account credits in USD')}
              </span>
            </div>
            <strong className="om-account-hub-credits-amount">
              {pillCredits ?? '—'}
            </strong>
          </div>

          {quota.weeklyPercentLeft !== null && (
            <div className="om-account-hub-meter-box">
              <div className="om-ws-quota-row">
                <span>{t('Weekly usage')}</span>
                <strong className="om-account-hub-meter-val">{t('{percent}% left', { percent: quota.weeklyPercentLeft })}</strong>
              </div>
              <div className="om-ws-meter-track" role="progressbar" aria-valuenow={quota.weeklyPercentLeft} aria-valuemin={0} aria-valuemax={100}>
                <div
                  className="om-ws-meter-fill om-account-hub-meter-fill"
                  data-exhausted={quota.weeklyLimitExhausted || undefined}
                  style={{ width: `${Math.max(0, Math.min(100, quota.weeklyPercentLeft))}%` }}
                />
              </div>
              {resetText && <span className="om-account-hub-sub">{t('Resets on {date}', { date: resetText })}</span>}
            </div>
          )}

          {canManageBilling ? (
            <div className="om-ws-quota-actions">
              <Button
                variant="primary"
                type="button"
                disabled={Boolean(collab.openingCloudDestination)}
                aria-busy={openingPrimary || undefined}
                onClick={event => {
                  event.stopPropagation();
                  void collab.openCloudLink(primaryDestination);
                }}
              >
                {!isLocked && <RemixIcon name="sparkling-line" size={14} />}
                <span>{t(isLocked ? 'Restore billing' : 'Upgrade plan')}</span>
                <RemixIcon
                  name={openingPrimary ? 'loader-4-line' : 'external-link-line'}
                  size={13}
                  className={openingPrimary ? 'animate-spin motion-reduce:animate-none' : undefined}
                />
              </Button>
              <Button
                variant="plain"
                type="button"
                className="om-collab-tonal-btn"
                disabled={Boolean(collab.openingCloudDestination)}
                aria-busy={openingBilling || undefined}
                onClick={event => {
                  event.stopPropagation();
                  void collab.openCloudLink('billing');
                }}
              >
                <span>{t('Billing')}</span>
                <RemixIcon
                  name={openingBilling ? 'loader-4-line' : 'external-link-line'}
                  size={13}
                  className={openingBilling ? 'animate-spin motion-reduce:animate-none' : undefined}
                />
              </Button>
            </div>
          ) : (
            <span className="om-account-hub-sub">{t('Billing is managed by your workspace owner.')}</span>
          )}
        </div>
      )}

      {showHubSummary && collab && referral?.available && (
        <MenuItem className="om-account-hub-referral-item" onClick={() => void collab.openCloudLink('referral')}>
          <span className="om-menu-label om-account-hub-referral-row">
            <span className="om-account-hub-referral-icon" aria-hidden="true">
              <RemixIcon name="sparkling-fill" size={14} />
            </span>
            <span>{t('Share OpenDesign · Earn reset cards')}</span>
            <span className="om-collab-pill" data-tone="accent">{`${referral.invitedCount}/${referral.inviteTarget}`}</span>
          </span>
        </MenuItem>
      )}

      <MenuSeparator />
      {showHubSummary && collab && activeWs?.workspaceType === 'team' && snapshot?.permissions.canInviteMembers && (
        <MenuItem onClick={() => collab.setInviteDialogOpen(true)}>
          <span className="om-menu-label"><RemixIcon name="group-line" size={16} />{t('Invite teammates')}</span>
        </MenuItem>
      )}
      <MenuItem onClick={() => openSettings('subscription')}><span className="om-menu-label"><RemixIcon name="bank-card-line" size={16} />{t('Subscription & usage')}</span></MenuItem>
      <MenuSeparator />
      <MenuItem onClick={() => openSettings('general')}><span className="om-menu-label"><RemixIcon name="settings-3-line" size={16} />{t('Settings')}</span></MenuItem>
      <MenuSubmenu aria-label={t('Appearance')} className="om-selection-panel om-menu-panel" label={<span className="om-menu-label"><RemixIcon name="sun-line" size={16} />{t('Appearance')}</span>} detail={t(themeLabels[theme])}>
        <MenuRadioGroup value={theme}>
          {(['light', 'dark', 'system'] as const).map(value => (
            <MenuRadioItem key={value} value={value} closeOnClick onClick={event => {
              if (theme === value) return;
              trackStudioClick('settings', 'theme_toggle', undefined, clickMethod(event), clickOption(value));
              setStudioTheme(value);
            }}>
              {t(themeLabels[value])}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubmenu>
      <MenuSubmenu aria-label={t('Language')} className="om-selection-panel om-menu-panel" label={<span className="om-menu-label"><RemixIcon name="global-line" size={16} />{t('Language')}</span>} detail={languages.find(language => language.locale === locale)?.label}>
        <MenuRadioGroup value={locale} onValueChange={value => setLocale(value as Locale)}>{languages.map(language => <MenuRadioItem key={language.locale} value={language.locale} closeOnClick>{language.label}</MenuRadioItem>)}</MenuRadioGroup>
      </MenuSubmenu>
      <MenuSeparator />
      {repositorySupportLinks.map(link => <MenuItem key={link.href} render={<a href={link.href} target="_blank" rel="noopener noreferrer" />}><span className="om-menu-label"><RemixIcon name={link.icon} size={16} />{t(link.label)}<RemixIcon className="om-menu-external" name="external-link-line" size={14} /></span></MenuItem>)}
      {desktopApp && (
        <>
          <MenuItem onClick={() => { void getDesktopBridge()?.checkForUpdates(); openSettings('about'); }}>
            <span className="om-menu-label"><RemixIcon name="refresh-line" size={16} />{t('Check for updates')}</span>
          </MenuItem>
          <MenuItem onClick={() => { void exportDesktopDiagnosticBundle(); }}>
            <span className="om-menu-label"><RemixIcon name="download-2-line" size={16} />{t('Export diagnostic logs')}</span>
          </MenuItem>
        </>
      )}
      <MenuItem onClick={() => openSettings('help')}><span className="om-menu-label"><RemixIcon name="question-line" size={16} />{t('Help')}</span></MenuItem>
    </Menu>;
}
