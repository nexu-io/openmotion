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
import { getDesktopHostBridge, isDesktopApp, startDesktopBrowserLogin, useDesktopChrome, useDesktopUpdateState } from '../utils/platformHost';
import { HOST_CAPABILITIES } from '../../../shared/desktop-contract';
import { useWorkspaceChrome } from './WorkspaceFrame';
import { buildLoginUrl, invalidateAccountSummaryCache, useAccountSummary } from './AccountSettings';
import { setDiagnosticsAuthState } from './diagnostics';
import { hasEntitlementModalListeners, openEntitlementModal, useCloudWebMode } from './entitlementModalBus';
import { clearPrivateSwrCache } from './swrCache';
import { markAuthenticatedSession } from './authRecoveryStore';
import { CommunityLink } from './CommunityLink';
import { clickMethod, clickOption, trackStudioClick } from './editorTracking';
import { GitHubLink } from './GitHubLink';
import { repositorySupportLinks } from './githubRepository';
import type { SettingsSection } from './workspacePageRouting';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { setObservabilityContext } from '@openmotion/observability/browser';

import { CreativeNavigation, type CreativeNavigationProps } from './CreativeNavigation';
import { PricingEntry } from './PricingEntry';
import { WorkspaceResourceActions } from './WorkspaceResourceActions';
import { WorkspaceSearch } from './WorkspaceSearch';
import { preloadWorkspacePage } from '../router/lazyPages';
import { useCloudFeatureEnabled } from '../utils/cloudFeatures';

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
  const brandKitEnabled = useCloudFeatureEnabled('brandKit');
  const { openAssets, openHome } = useWorkspaceChrome();
  const homeHint = atExploreHome ? undefined : t('Back to Explore');
  const header = useRef<HTMLElement>(null);
  const desktopChrome = useDesktopChrome();
  const desktopBridge = getDesktopHostBridge();
  const [compactActions, setCompactActions] = useState(false);
  const desktopInsetTotal = desktopChrome ? desktopChrome.insetLeft + desktopChrome.insetRight : 0;
  const compactActionThreshold = desktopInsetTotal > 0 ? 640 : 560;
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => setCompactActions(entry.contentRect.width <= compactActionThreshold));
    observer.observe(header.current!);
    return () => observer.disconnect();
  }, [compactActionThreshold]);

  function workspaceActions(closeMenu?: () => void) {
    return <>
      <WorkspaceSearch onChoose={closeMenu} onSkill={onSkill} destination={navigation.destination} onLibrary={openAssets} onAccount={() => openSettings('account')} onAsset={openAsset} onScene={navigation.onNavigate} onStudio={navigation.onChooseStudio} onCommunity={onCommunity} />
      <WorkspaceResourceActions onBrandKit={brandKitEnabled ? () => openSettings('brand-kit') : undefined} brandKitOpen={brandKitEnabled && settings === 'brand-kit'} closeMenu={closeMenu} />
    </>;
  }

  return <header ref={header} className="om-app-header">
    <Tooltip label={homeHint} side="bottom"><Button variant="plain" type="button" className="om-nav-item om-app-brand" onPointerEnter={() => preloadWorkspacePage('explore')} onFocus={() => preloadWorkspacePage('explore')} onClick={openHome} aria-label={homeHint ? `${brand.editorName} · ${homeHint}` : brand.editorName}><BrandLogo variant="editor" compact /></Button></Tooltip>
    <CreativeNavigation {...navigation} overflowActions={compactActions ? workspaceActions : undefined} />
    <div className="om-app-header-actions">
      {!compactActions && workspaceActions()}
      <div className="om-app-header-links"><CommunityLink /><GitHubLink /></div>
      <PricingEntry trackingPage={navigation.trackingPage} />
      <ApplicationAccountMenu settings={settings} openSettings={openSettings} />
      {desktopChrome?.customWindowControls && desktopBridge && (
        <div className="om-desktop-window-controls" role="group" aria-label={t('Window controls')}>
          <IconButton
            variant="plain"
            type="button"
            className="om-nav-item"
            aria-label={t('Minimize window')}
            onClick={() => void desktopBridge.invoke(HOST_CAPABILITIES.WINDOW, 'minimize')}
            icon={<RemixIcon name="subtract-line" size={14} />}
          />
          <IconButton
            variant="plain"
            type="button"
            className="om-nav-item"
            aria-label={t(desktopChrome.maximized ? 'Restore window' : 'Maximize window')}
            onClick={() => void desktopBridge.invoke(HOST_CAPABILITIES.WINDOW, 'toggleMaximize')}
            icon={<RemixIcon name={desktopChrome.maximized ? 'checkbox-multiple-blank-line' : 'checkbox-blank-line'} size={13} />}
          />
          <IconButton
            variant="plain"
            type="button"
            className="om-nav-item om-desktop-window-close"
            aria-label={t('Close window')}
            onClick={() => void desktopBridge.invoke(HOST_CAPABILITIES.WINDOW, 'close')}
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
    {item('Model gateway', 'brain-line', () => openSettings('providers'))}
    {item('Help', 'question-line', () => openSettings('help'))}
  </nav>;
}

export function ApplicationAccountMenu({ settings, openSettings }: { settings: SettingsSection | null; openSettings: (section: SettingsSection) => void }) {
  const { t, locale, setLocale } = useI18n();
  const { account } = useAccountSummary();
  useEffect(() => {
    if (!account) return;
    setObservabilityContext({
      userId: account.state === 'signed-in' ? (account.userId ?? null) : null,
      workspaceId: account.activeWorkspace?.id ?? null,
      workspaceRole: account.activeWorkspace?.role ?? null,
      authMode: account.authMode ?? null,
    });
  }, [account]);
  const cloudWeb = useCloudWebMode();
  const theme = useStudioThemePreference();
  const desktopApp = isDesktopApp();
  const updater = useDesktopUpdateState();
  const updateState = desktopApp ? updater.state : null;
  const hasPendingDesktopUpdate = Boolean(
    updateState &&
    (updateState.mandatory ||
      updateState.status === 'downloaded' ||
      updateState.status === 'available'),
  );
  const updateMenuVersion = updateState?.availableVersion
    ? (/^v/i.test(updateState.availableVersion) ? updateState.availableVersion : `v${updateState.availableVersion}`)
    : '';
  const userName = account?.user?.name?.trim() || account?.user?.email?.trim() || t('Account');
  const workspaceLabel = account?.activeWorkspace?.name;
  const isDevMode = account?.authMode === 'dev';
  const signedIn = account?.state === 'signed-in';
  const avatarInitial = avatarSegmenter.segment(userName)[Symbol.iterator]().next().value?.segment;
  async function signOut() {
    try {
      const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Could not sign out');
      markAuthenticatedSession(false);
      setDiagnosticsAuthState(false);
      invalidateAccountSummaryCache();
      clearPrivateSwrCache();
      window.dispatchEvent(new Event('motion:account-changed'));
    } catch {
      openSettings('account');
    }
  }

  return (
    <Menu
      tooltip={t('Account menu')}
      modal={false}
      side="bottom"
      align="end"
      aria-label={t('Account menu')}
      className="om-account-menu om-selection-panel om-menu-panel"
      trigger={
        <Button
          variant="plain"
          type="button"
          className="om-nav-item om-account-trigger"
          aria-current={settings === 'account' || settings === 'subscription' ? 'page' : undefined}
          aria-label={t('Account menu')}
          onPointerEnter={() => preloadWorkspacePage('settings')}
          onFocus={() => preloadWorkspacePage('settings')}
        >
          <span className="om-avatar" aria-hidden="true">
            {signedIn ? avatarInitial : <><RemixIcon className="om-default-avatar-icon om-default-avatar-icon-outline" name="user-3-line" size={14} /><svg className="om-default-avatar-icon om-default-avatar-icon-solid" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 22H4V20C4 17.2386 6.23858 15 9 15H15C17.7614 15 20 17.2386 20 20V22ZM12 13C8.68629 13 6 10.3137 6 7C6 3.68629 8.68629 1 12 1C15.3137 1 18 3.68629 18 7C18 10.3137 15.3137 13 12 13Z" /></svg></>}
            {hasPendingDesktopUpdate && <span className="om-desktop-update-dot" />}
          </span>
          {isDevMode && <span className="om-badge" data-active="true">{t('Dev')}</span>}
        </Button>
      }
    >
      <MenuItem onClick={() => openSettings('account')}>
        <span className="om-menu-label">
          <RemixIcon name="user-3-line" size={16} />
          <strong>{userName}</strong>
        </span>
      </MenuItem>
      {workspaceLabel && (
        <MenuItem onClick={() => openSettings('account')}>
          <span className="om-menu-label">
            <RemixIcon name="apps-2-line" size={16} />
            <span>{workspaceLabel}</span>
          </span>
        </MenuItem>
      )}
      {hasPendingDesktopUpdate && updateState && (
        <>
          <MenuSeparator />
          <MenuItem
            onClick={() => {
              if (updateState.status === 'downloaded') {
                void updater.installUpdateNow();
              } else {
                openSettings('about');
              }
            }}
          >
            <span className="om-menu-label">
              <span className="om-desktop-update-menu-dot" aria-hidden="true" />
              {updateState.status === 'downloaded'
                ? updateMenuVersion
                  ? t('Restart to update ({version})', { version: updateMenuVersion })
                  : t('Restart and install update')
                : updateMenuVersion
                  ? t('Update available: {version}', { version: updateMenuVersion })
                  : t('Update available')}
            </span>
          </MenuItem>
        </>
      )}
      <MenuSeparator />
      <MenuItem onClick={() => openSettings('subscription')}>
        <span className="om-menu-label"><RemixIcon name="bank-card-line" size={16} />{t('Subscription & usage')}</span>
      </MenuItem>
      <MenuItem onClick={() => openSettings('account')}>
        <span className="om-menu-label"><RemixIcon name="lock-line" size={16} />{t('Personal access tokens')}</span>
      </MenuItem>
      <MenuSeparator />
      <MenuItem shortcut="⌘ ," onClick={() => openSettings('general')}>
        <span className="om-menu-label"><RemixIcon name="settings-3-line" size={16} />{t('Settings')}</span>
      </MenuItem>
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
      <MenuSubmenu
        aria-label={t('Language')}
        className="om-selection-panel om-menu-panel"
        label={<span className="om-menu-label"><RemixIcon name="global-line" size={16} />{t('Language')}</span>}
        detail={languages.find(language => language.locale === locale)?.label}
      >
        <MenuRadioGroup value={locale} onValueChange={value => setLocale(value as Locale)}>
          {languages.map(language => <MenuRadioItem key={language.locale} value={language.locale} closeOnClick>{language.label}</MenuRadioItem>)}
        </MenuRadioGroup>
      </MenuSubmenu>
      <MenuSeparator />
      {repositorySupportLinks.map(link => (
        <MenuItem key={link.href} render={<a href={link.href} target="_blank" rel="noopener noreferrer" />}>
          <span className="om-menu-label">
            <RemixIcon name={link.icon} size={16} />
            {t(link.label)}
            <RemixIcon className="om-menu-external" name="external-link-line" size={14} />
          </span>
        </MenuItem>
      ))}
      <MenuItem onClick={() => openSettings('help')}>
        <span className="om-menu-label"><RemixIcon name="question-line" size={16} />{t('Help')}</span>
      </MenuItem>
      {!isDevMode && (
        <>
          <MenuSeparator />
          {signedIn ? (
            <MenuItem onClick={() => void signOut()}>
              <span className="om-menu-label"><RemixIcon name="login-box-line" mirrored size={16} />{t('Sign out')}</span>
            </MenuItem>
          ) : (
            <MenuItem
              onClick={() => {
                const loginUrl = buildLoginUrl();
                if (isDesktopApp()) {
                  void startDesktopBrowserLogin({ loginUrl });
                  return;
                }
                if (cloudWeb && hasEntitlementModalListeners()) {
                  openEntitlementModal({ mode: 'guest', hookId: 'header_signin' });
                  return;
                }
                window.location.assign(loginUrl);
              }}
            >
              <span className="om-menu-label"><RemixIcon name="login-box-line" size={16} />{t('Sign in with OpenDesign')}</span>
            </MenuItem>
          )}
        </>
      )}
    </Menu>
  );
}
