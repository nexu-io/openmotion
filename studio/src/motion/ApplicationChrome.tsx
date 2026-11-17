import { BrandLogo } from '../../../packages/design-system/react/BrandLogo';
import { RemixIcon } from '../icons/RemixIcons';
import { Menu, MenuItem, MenuSeparator, MenuSubmenu, MenuRadioGroup, MenuRadioItem } from '../components/ui/Menu';
import { Tooltip } from '../components/ui/Tooltip';
import { languages, useI18n, type Locale } from '../i18n/I18n';
import { useWorkspaceChrome } from './WorkspaceFrame';
import { useAccountSummary } from './AccountSettings';
import { ModelSwitcher } from './ModelSwitcher';
import { CommunityLink } from './CommunityLink';
import { GitHubLink } from './GitHubLink';
import { repositorySupportLinks } from './githubRepository';
import type { SettingsSection } from './SettingsCenter';
import type { ReactNode } from 'react';
import type { MouseEvent } from 'react';
import { WorkspaceHistoryNavigation } from './WorkspaceHistoryNavigation';

export function ApplicationHeader({ settings }: { settings: SettingsSection | null }) {
  const { t } = useI18n();
  const { openHome, openModelSettings, navigationCollapsed, toggleNavigation } = useWorkspaceChrome();
  return <header className="om-app-header">
    <div className="om-app-leading">
      <Tooltip label={t(navigationCollapsed ? 'Expand sidebar' : 'Collapse sidebar')}><button className="om-nav-item om-app-sidebar-toggle" onClick={toggleNavigation} aria-expanded={!navigationCollapsed} aria-controls="om-application-navigation" aria-label={t(navigationCollapsed ? 'Expand sidebar' : 'Collapse sidebar')}><RemixIcon name="side-bar-line" size={16} /></button></Tooltip>
      <WorkspaceHistoryNavigation />
      <Tooltip label={t('Back to home')}><button type="button" className="om-nav-item om-app-brand" onClick={openHome} aria-label={t('Back to home')}><BrandLogo compact /></button></Tooltip>
    </div>
    <div className="om-app-navigation">{settings ? <button className="om-nav-item" onClick={openHome} aria-label={t('Back to home')}><RemixIcon name="arrow-left-line" size={16} /><span>{t('Back to home')}</span></button> : null}</div>
    <div className="om-app-header-actions"><div className="om-app-header-links"><CommunityLink /><GitHubLink /></div>{!settings && <ModelSwitcher openSettings={openModelSettings} />}{settings && <button className="motion-icon-button" aria-label={t(settings === 'brand-kit' ? 'Close Brand Kit' : 'Close settings')} onClick={openHome}><RemixIcon name="close-line" size={20} /></button>}</div>
  </header>;
}
export function ApplicationRail({ settings, openSettings, home }: { settings: SettingsSection | null; openSettings: (section: SettingsSection) => void; home: ReactNode }) {
  const { t, locale, setLocale } = useI18n(), { account } = useAccountSummary();
  const { openLibrary, openConnections, openAssets, assetsOpen, openSkills, skillsOpen, switchingDisabled, navigationCollapsed } = useWorkspaceChrome();
  const userName = account?.user?.name || account?.user?.email || t('Account');
  const item = (label: string, icon: string, action: (event: MouseEvent<HTMLButtonElement>) => void, active = false, disabled = false) => <Tooltip label={t(label)} side="right"><button className="om-nav-item om-rail-button" aria-label={t(label)} aria-pressed={active} onClick={action} disabled={disabled}><RemixIcon name={icon} size={18} /></button></Tooltip>;
  return <nav id="om-application-navigation" className="om-app-rail om-collapsible" data-collapsed={navigationCollapsed} aria-label={t('Application navigation')} aria-hidden={navigationCollapsed} inert={navigationCollapsed}>
    {home}
    {item('Workspace assets', 'folder-open-line', openAssets, assetsOpen)}
    {item('Template library', 'apps-2-line', event => openLibrary(event.currentTarget), false, switchingDisabled)}
    {item('Brand Kit', 'palette-line', () => openSettings('brand-kit'), settings === 'brand-kit')}
    {item('Skills', 'flashlight-line', openSkills, skillsOpen)}
    {item('MCP · Connect Agent', 'plug-line', openConnections, settings === 'mcp')}
    <div className="om-rail-spacer" />
    {item('Help', 'question-line', () => openSettings('help'), settings === 'help')}
    {item('Settings', 'settings-3-line', () => openSettings('general'), Boolean(settings && !['mcp', 'brand-kit', 'providers', 'help', 'account', 'subscription'].includes(settings)))}
    {item('Model providers', 'sparkling-line', () => openSettings('providers'), settings === 'providers')}
    <Menu tooltip={t('Account menu')} modal={false} side="top" align="start" aria-label={t('Account menu')} className="om-account-menu om-selection-panel om-menu-panel" trigger={<button className="om-nav-item om-rail-button om-account-trigger" aria-current={settings === 'account' || settings === 'subscription' ? 'page' : undefined} aria-label={t('Account menu')}><span className="om-avatar">{account?.state === 'signed-in' ? userName.slice(0, 2).toUpperCase() : <RemixIcon name="user-3-line" size={18} />}</span></button>}>
      <MenuItem onClick={() => openSettings('account')}><span className="om-menu-label"><RemixIcon name="user-3-line" size={16} /><strong>{userName}</strong></span></MenuItem><MenuSeparator />
      <MenuItem onClick={() => openSettings('subscription')}><span className="om-menu-label"><RemixIcon name="bank-card-line" size={16} />{t('Subscription & usage')}</span></MenuItem>
      <MenuSeparator />
      <MenuItem shortcut="⌘ ," onClick={() => openSettings('general')}><span className="om-menu-label"><RemixIcon name="settings-3-line" size={16} />{t('Settings')}</span></MenuItem>
      <MenuItem onClick={() => openSettings('appearance')}><span className="om-menu-label"><RemixIcon name="sun-line" size={16} />{t('Appearance')}</span></MenuItem>
      <MenuSubmenu aria-label={t('Language')} className="om-selection-panel om-menu-panel" label={<span className="om-menu-label"><RemixIcon name="global-line" size={16} />{t('Language')}</span>} detail={languages.find(language => language.locale === locale)?.label}>
        <MenuRadioGroup value={locale} onValueChange={value => setLocale(value as Locale)}>{languages.map(language => <MenuRadioItem key={language.locale} value={language.locale} closeOnClick>{language.label}</MenuRadioItem>)}</MenuRadioGroup>
      </MenuSubmenu>
      <MenuSeparator />
      {repositorySupportLinks.map(link => <MenuItem key={link.href} render={<a href={link.href} target="_blank" rel="noopener noreferrer" />}><span className="om-menu-label"><RemixIcon name={link.icon} size={16} />{t(link.label)}<RemixIcon className="om-menu-external" name="external-link-line" size={14} /></span></MenuItem>)}
      <MenuItem onClick={() => openSettings('help')}><span className="om-menu-label"><RemixIcon name="question-line" size={16} />{t('Help')}</span></MenuItem>
    </Menu>
  </nav>;
}
