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
import { openOpenDesignConsole, useAccountSummary } from './AccountSettings';
import { CommunityLink, useCommunityLink } from './CommunityLink';
import { clickMethod, clickOption, trackStudioClick } from './editorTracking';
import { GitHubLink } from './GitHubLink';
import { repositorySupportLinks } from './githubRepository';
import type { DesignSceneTarget, SettingsSection } from './workspacePageRouting';
import { useLayoutEffect, useRef, useState } from 'react';

import { CreativeNavigation, type CreativeNavigationProps } from './CreativeNavigation';
import { PricingEntry } from './PricingEntry';
import { useBlackFridayActive } from './campaignAttribution';
import { WorkspaceSearch } from './WorkspaceSearch';
import { useOptionalWorkspaceCollab } from './WorkspaceCollabContext';
import { MessageCenterPopover } from './collab/MessageCenterPopover';
import { ProductionCampaignBadge } from './collab/ProductionCampaignBadge';
import { useOptionalGrowthSurfaces } from './collab/GrowthSurfacesContext';
import { preloadWorkspacePage } from '../router/lazyPages';

const avatarSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const themeLabels = { light: 'Light', dark: 'Dark', system: 'System' } as const;

function workspaceInitialFor(name: string): string {
  return (avatarSegmenter.segment(name.trim() || 'W')[Symbol.iterator]().next().value?.segment ?? 'W').toUpperCase();
}

export function ApplicationHeader({
  settings,
  atExploreHome,
  onSkill,
  openAsset,
  onCommunity,
  openSettings,
  onNewAgentChat,
  onAgentChat,
  onOpenDesignScene,
  onOpenDesignProject,
  onOpenMotionProject,
  onOpenGame,
  onOpenBrandKit,
  onOpenMcp,
  onNotify,
  ...navigation
}: CreativeNavigationProps & {
  onSkill: (id: string) => void;
  atExploreHome: boolean;
  settings: SettingsSection | null;
  openSettings: (section: SettingsSection) => void;
  openAsset: (assetId: string, version: string) => void;
  onCommunity: (community: ExploreCommunity) => void;
  onNewAgentChat?: () => void;
  onAgentChat?: (chatId: string) => void;
  onOpenDesignScene?: (scene: DesignSceneTarget) => void;
  onOpenDesignProject?: (id: string, scenario?: DesignSceneTarget) => void;
  onOpenMotionProject?: (id: string) => void;
  onOpenGame?: (gameId: string) => void;
  onOpenBrandKit?: (kitId?: string | null) => void;
  onOpenMcp?: () => void;
  onNotify?: (message: string, tone?: 'info' | 'error') => void;
}) {
  const { t } = useI18n();
  const { openAssets, openHome, assetsOpen, projectsOpen } = useWorkspaceChrome();
  const { account } = useAccountSummary();
  const collab = useOptionalWorkspaceCollab();
  const signedInHub = collab ? Boolean(collab.snapshot?.signedIn) : account?.state === 'signed-in';
  const homeHint = atExploreHome ? undefined : t('Back to Explore');
  const header = useRef<HTMLElement>(null);
  const desktopChrome = useDesktopChrome();
  const desktopBridge = getDesktopBridge();
  const [compactActions, setCompactActions] = useState(false);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setCompactActions(width > 0 && width <= 780);
    });
    observer.observe(header.current!);
    return () => observer.disconnect();
  }, []);

  function workspaceSearchControl() {
    return (
      <WorkspaceSearch
        onSkill={onSkill}
        destination={navigation.destination}
        onLibrary={openAssets}
        onAccount={() => openSettings('account')}
        onAsset={openAsset}
        onScene={navigation.onNavigate}
        onStudio={navigation.onChooseStudio}
        onCommunity={onCommunity}
        onNewAgentChat={onNewAgentChat}
        onAgentChat={onAgentChat}
        onOpenDesignScene={onOpenDesignScene}
        onOpenDesignProject={onOpenDesignProject}
        onOpenMotionProject={onOpenMotionProject}
        onOpenGame={onOpenGame}
        onOpenBrandKit={onOpenBrandKit}
        onOpenMcp={onOpenMcp}
        onOpenSettings={openSettings}
        onOpenScenario={id => navigation.onOpenScenario?.(id)}
        onOpenScenarioHub={navigation.onOpenScenarioHub}
        onNotify={onNotify}
      />
    );
  }

  const libraryActive = Boolean(assetsOpen || projectsOpen || settings === 'brand-kit');

  return <header ref={header} className="om-app-header">
    <Tooltip label={homeHint} side="bottom"><Button variant="plain" type="button" className="om-nav-item om-app-brand" onPointerEnter={() => preloadWorkspacePage('explore')} onFocus={() => preloadWorkspacePage('explore')} onClick={openHome} aria-label={homeHint ? `${brand.editorName} · ${homeHint}` : brand.editorName}><BrandLogo variant="editor" compact /></Button></Tooltip>
    <CreativeNavigation {...navigation} libraryActive={libraryActive} onOpenLibrary={openAssets} />
    <div className="om-app-header-actions">
      {workspaceSearchControl()}
      {!signedInHub && <div className="om-app-header-links"><CommunityLink /><GitHubLink /></div>}
      {signedInHub && !compactActions && <span className="om-header-actions-divider" aria-hidden="true" />}
      {signedInHub && <GitHubLink className="om-header-github-pill" />}
      {signedInHub && collab?.snapshot && (
        <Tooltip label={collab.snapshot.referral?.available ? t('Share OpenDesign · Earn reset cards') : t('Invite teammates')} side="bottom">
          <Button
            variant="plain"
            type="button"
            className="om-nav-item om-header-invite-pill"
            data-has-reward={collab.snapshot.referral?.available ? true : undefined}
            data-testid="header-viral-invite"
            aria-label={collab.snapshot.referral?.available ? t('Share OpenDesign · Earn reset cards') : t('Invite teammates')}
            onClick={() => collab.setInviteDialogOpen(true)}
          >
            <RemixIcon name="group-line" size={14} />
            <span className="om-header-invite-label">{t('Invite')}</span>
            {collab.snapshot.referral?.available && (
              <>
                <span className="om-header-invite-reward" aria-hidden="true">
                  {t('Reset card')}
                </span>
                <span className="om-header-invite-dot" aria-hidden="true" />
              </>
            )}
          </Button>
        </Tooltip>
      )}
      {!signedInHub && <PricingEntry trackingPage={navigation.trackingPage} />}
      {signedInHub && <ProductionCampaignBadge />}
      <MessageCenterPopover />
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
  const growth = useOptionalGrowthSurfaces();
  const campaign = useBlackFridayActive();
  const community = useCommunityLink();
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
  const openingCreateWs = collab?.openingCloudDestination === 'create-workspace';
  const showHubSummary = Boolean(signedIn && collab && activeWs && quota);
  const workspaces = snapshot?.workspaces ?? [];
  const roleLabel = (role: string) =>
    role === 'owner' ? t('Owner') : role === 'admin' ? t('Admin') : t('Member');
  const menuTooltip = activeWs?.workspaceType === 'team' ? `${t('Account menu')} · ${activeWs.workspaceName}` : t('Account menu');

  return <Menu
    tooltip={menuTooltip}
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
            <span className="om-account-hub-status-dot" data-warning={isWarning || undefined} aria-hidden="true" />
            <span className="om-account-hub-pill-plan-tag">{quota.planLabel}</span>
            <span className="om-account-hub-pill-val">{pillSummary}</span>
          </span>
        )}
        <span className="om-avatar" aria-hidden="true">
          {signedIn ? avatarInitial : <><RemixIcon className="om-default-avatar-icon om-default-avatar-icon-outline" name="user-3-line" size={14} /><svg className="om-default-avatar-icon om-default-avatar-icon-solid" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 22H4V20C4 17.2386 6.23858 15 9 15H15C17.7614 15 20 17.2386 20 20V22ZM12 13C8.68629 13 6 10.3137 6 7C6 3.68629 8.68629 1 12 1C15.3137 1 18 3.68629 18 7C18 10.3137 15.3137 13 12 13Z" /></svg></>}
        </span>
      </Button>
    }
  >
      <MenuItem className="om-account-hub-identity-item" onClick={() => openSettings('account')}>
        <span className="om-menu-label om-account-hub-identity">
          {signedIn ? (
            <span className="om-account-hub-avatar" aria-hidden="true">{avatarInitial}</span>
          ) : (
            <RemixIcon name="user-3-line" size={16} />
          )}
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

      {showHubSummary && collab && activeWs && workspaces.length > 0 && (
        <div className="om-account-hub-workspaces" data-testid="account-hub-workspaces">
          <div className="om-account-hub-ws-head">
            <span className="om-account-hub-ws-label">{t('Workspace')}</span>
            <Button
              variant="plain"
              type="button"
              className="om-account-hub-ws-new-btn"
              disabled={Boolean(collab.openingCloudDestination)}
              aria-busy={openingCreateWs || undefined}
              onClick={event => {
                event.stopPropagation();
                void collab.openCloudLink('create-workspace');
              }}
            >
              <RemixIcon
                name={openingCreateWs ? 'loader-4-line' : 'add-line'}
                size={12}
                className={openingCreateWs ? 'animate-spin motion-reduce:animate-none' : undefined}
              />
              <span>{t('Create team workspace')}</span>
              <RemixIcon name="external-link-line" size={11} />
            </Button>
          </div>
          <div className="om-account-hub-ws-list" role="group" aria-label={t('Switch workspace')}>
            {workspaces.map(ws => {
              const isCurrent = ws.workspaceId === activeWs.workspaceId;
              const wsLocked = ws.lifecycleState === 'locked' || ws.lifecycleState === 'billing_past_due';
              const meta = ws.workspaceType === 'personal'
                ? t('Personal')
                : `${roleLabel(ws.role)}${wsLocked ? ` · ${t('Paused')}` : ''}`;
              return (
                <Button
                  key={ws.workspaceId}
                  variant="plain"
                  type="button"
                  className="om-account-hub-ws-item"
                  data-active={isCurrent || undefined}
                  disabled={collab.switching}
                  onClick={event => {
                    event.stopPropagation();
                    if (!isCurrent) collab.requestSwitchWorkspace(ws.workspaceId);
                  }}
                >
                  <span className="om-ws-avatar-dot" data-type={ws.workspaceType} aria-hidden="true">
                    {workspaceInitialFor(ws.workspaceName)}
                  </span>
                  <span className="om-account-hub-ws-name">{ws.workspaceName}</span>
                  <span className="om-account-hub-ws-meta">{meta}</span>
                  {wsLocked ? (
                    <RemixIcon name="lock-line" size={13} className="om-account-hub-ws-check" />
                  ) : isCurrent ? (
                    <RemixIcon name="check-line" size={14} className="om-account-hub-ws-check" />
                  ) : null}
                </Button>
              );
            })}
          </div>
        </div>
      )}

      {showHubSummary && collab && activeWs && quota && (
        <div
          className="om-account-hub-card"
          data-promo={campaign && !isWarning ? true : undefined}
          data-warning={isWarning || undefined}
          data-testid="account-hub-quota"
        >
          <div className="om-account-hub-card-head">
            <span className="om-account-hub-plan-row">
              <span className="om-account-hub-plan-emblem">{quota.planLabel}</span>
              {campaign && <span className="om-account-hub-promo-chip">50% OFF</span>}
            </span>
            <span className="om-account-hub-head-actions">
              <IconButton
                variant="ghost"
                size="sm"
                className="om-account-hub-refresh-btn"
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
                    size={13}
                    className={refreshingQuota ? 'animate-spin motion-reduce:animate-none' : undefined}
                  />
                }
              />
              {canManageBilling && (
                <Button
                  variant="plain"
                  type="button"
                  className="om-account-hub-upgrade-pill"
                  disabled={Boolean(collab.openingCloudDestination)}
                  aria-busy={openingPrimary || undefined}
                  onClick={event => {
                    event.stopPropagation();
                    void collab.openCloudLink(primaryDestination);
                  }}
                >
                  <span>{t(isLocked ? 'Restore billing' : 'Upgrade')}</span>
                  {openingPrimary && <RemixIcon name="loader-4-line" size={12} className="animate-spin motion-reduce:animate-none" />}
                </Button>
              )}
            </span>
          </div>

          {quota.weeklyPercentLeft !== null && (
            <div className="om-account-hub-meter-box">
              <div className="om-account-hub-meter-row">
                <span className="om-account-hub-card-muted">{t('Weekly usage')}</span>
                <strong className="om-account-hub-meter-val">{t('{percent}% left', { percent: quota.weeklyPercentLeft })}</strong>
              </div>
              <div className="om-account-hub-meter-track" role="progressbar" aria-valuenow={quota.weeklyPercentLeft} aria-valuemin={0} aria-valuemax={100}>
                <div
                  className="om-ws-meter-fill om-account-hub-meter-fill"
                  data-exhausted={quota.weeklyLimitExhausted || undefined}
                  style={{ width: `${Math.max(0, Math.min(100, quota.weeklyPercentLeft))}%` }}
                />
              </div>
              {resetText && <span className="om-account-hub-card-dim">{t('Resets on {date}', { date: resetText })}</span>}
            </div>
          )}

          <div className="om-account-hub-credits-row">
            <div className="om-account-hub-credits-meta">
              <span className="om-account-hub-card-muted">{t('Available credits')}</span>
              <span className="om-account-hub-card-dim">
                {t(activeWs.workspaceType === 'team' ? 'Shared workspace credits in USD' : 'Account credits in USD')}
              </span>
            </div>
            {canManageBilling ? (
              <Button
                variant="plain"
                type="button"
                className="om-account-hub-credits-btn"
                disabled={Boolean(collab.openingCloudDestination)}
                aria-busy={openingBilling || undefined}
                onClick={event => {
                  event.stopPropagation();
                  void collab.openCloudLink('billing');
                }}
              >
                <strong className="om-account-hub-credits-amount">{pillCredits ?? '—'}</strong>
                <RemixIcon
                  name={openingBilling ? 'loader-4-line' : 'arrow-right-s-line'}
                  size={15}
                  className={openingBilling ? 'animate-spin motion-reduce:animate-none' : undefined}
                />
              </Button>
            ) : (
              <strong className="om-account-hub-credits-amount">{pillCredits ?? '—'}</strong>
            )}
          </div>

          {!canManageBilling && (
            <span className="om-account-hub-card-dim">{t('Billing is managed by your workspace owner.')}</span>
          )}
        </div>
      )}

      {showHubSummary && collab && referral?.available && (
        <MenuItem className="om-account-hub-reset-item" onClick={() => void collab.openCloudLink('referral')}>
          <span className="om-account-hub-reset-card">
            <span className="om-account-hub-reset-keycap" aria-hidden="true">reset</span>
            <span className="om-account-hub-reset-copy">
              <strong>{t('Share OpenDesign · Earn reset cards')}</strong>
              <span>
                {t('{invited}/{target} teammates joined · {cards} reset cards ready', {
                  invited: referral.invitedCount,
                  target: referral.inviteTarget,
                  cards: referral.resetCardsAvailable,
                })}
              </span>
            </span>
            <RemixIcon name="external-link-line" size={14} className="om-account-hub-reset-arrow" />
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
      {account?.state === 'signed-in' && <MenuItem onClick={() => { trackStudioClick('settings', 'open_console'); void openOpenDesignConsole().then(opened => { if (!opened) openSettings('subscription'); }); }}><span className="om-menu-label"><RemixIcon name="layout-2-line" size={16} />{t('Console')}<RemixIcon className="om-menu-external" name="external-link-line" size={14} /></span></MenuItem>}
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
      {growth && (
        <MenuItem onClick={() => growth.openSupportDialog({ source: 'Account menu' })}>
          <span className="om-menu-label"><RemixIcon name="customer-service-2-line" size={16} />{t('Contact support')}</span>
        </MenuItem>
      )}
      {showHubSummary && (
        <>
          <MenuSeparator />
          <div className="om-account-hub-footer">
            <a
              className="om-account-hub-footer-link"
              href={community.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={community.label}
            >
              <img src={community.icon} width="15" height="15" alt="" />
              <span>{community.platform}</span>
            </a>
            <GitHubLink className="om-account-hub-footer-github" />
          </div>
        </>
      )}
    </Menu>;
}
