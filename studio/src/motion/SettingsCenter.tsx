import { Button } from 'open-design-ui/button';
import * as tracking from './pageTracking';
import type { McpEntry } from './pageTracking';
import { useEffect, useState, type ReactNode } from 'react';
import type { ModelKind } from '../../../shared/provider-directory';
import { RemixIcon } from '../icons/RemixIcons';
import { languages, useI18n, type Locale } from '../i18n/I18n';
import { Select } from '../components/ui/Select';
import { AppearanceSettings } from './AppearanceSettings';
import { ModelSettings, modelKindLabel } from './ModelSettings';
import { AccountSettings } from './AccountSettings';
import { PrivacySettings } from './PrivacySettings';
import { clickMethod, clickOption, trackStudioClick } from './editorTracking';
import { ModelSwitcher } from './ModelSwitcher';
import { useProviderDirectory } from './useProviderDirectory';
import { gatewayRequest } from './gatewayClient';
import { SettingsError, SettingsLoading, Toggle } from './settingsPrimitives';
import { AgentSettings } from './AgentSettings';
import { DiagnosticExport } from './DiagnosticExport';
import { discord, feishu } from './CommunityLink';
import { GITHUB_REPOSITORY, repositorySupportLinks } from './githubRepository';
import { SettingsSurfaceBoundary } from './SettingsSurfaceBoundary';
import { DesktopReleaseNotesDialog } from './DesktopUpdatePrompt';
import {
  getDesktopHostBridge,
  isDesktopApp,
  useDesktopPreferences,
  useDesktopUpdateState,
} from '../utils/platformHost';
import { useToast } from '../hooks/useToast';
import { StudioToastViewport } from '../components/StudioToastViewport';
import type {
  DesktopPreferenceDescriptor,
  DesktopPreferenceKey,
  DesktopPreferenceValues,
  DesktopWritablePreferenceKey,
} from '../../../shared/desktop-contract';

import type { SettingsSection } from './workspacePageRouting';
export type { SettingsSection } from './workspacePageRouting';
import { settingsSectionLabel, visibleSettingsCenterSections } from './settingsMeta';
import { useCloudFeatureEnabled } from '../utils/cloudFeatures';

const cloudModelKinds: ModelKind[] = ['image', 'video', 'audio'];

export function SettingsCenter({
  section,
  onSection: onSectionRaw,
  onBack,
  openConnections,
  providerId,
  onProviderChange,
  mcp,
  hasProject = false,
}: {
  hasProject?: boolean;
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onBack?: () => void;
  openConnections: (entry: McpEntry) => void;
  providerId?: string | null;
  onProviderChange?: (id: string | null) => void;
  mcp?: ReactNode;
}) {
  const { t } = useI18n();
  const localAgentsEnabled = useCloudFeatureEnabled('localAgents');
  const modelProvidersEnabled = useCloudFeatureEnabled('modelProviders');
  const sections = visibleSettingsCenterSections(localAgentsEnabled, modelProvidersEnabled);
  const effectiveSection: SettingsSection =
    section === 'providers' && !modelProvidersEnabled
      ? 'models'
      : section === 'local' && !localAgentsEnabled
        ? (modelProvidersEnabled ? 'providers' : 'models')
        : section;
  const [search, setSearch] = useState('');
  const filtered = sections.filter(item => t(item.label).toLowerCase().includes(search.toLowerCase()));
  // One view per section shown; the section is remounted for each route.
  useEffect(() => { tracking.reportSettingsPageView(effectiveSection, hasProject); }, [effectiveSection]);
  const onSection = (next: SettingsSection) => {
    if (next !== effectiveSection) tracking.reportSettingsClick('settings_nav', 'section_select', { settings_section: next });
    onSectionRaw(next);
  };
  const openProviders = modelProvidersEnabled ? () => onSection('providers') : undefined;
  return (
    <div className="om-settings-center" onKeyDown={event => event.stopPropagation()}>
      <div className="om-settings-navigation-slot">
        <div className="om-settings-navigation-clip">
          <aside className="om-settings-navigation">
            <div className="om-settings-heading">
              {onBack
                ? <Button variant="plain" type="button" className="om-nav-item" onClick={onBack}><RemixIcon name="arrow-left-line" size={16} />{t('Go back')}</Button>
                : <h1 className="om-navigation-title">{t('Settings')}</h1>}
              <div className="om-settings-mobile-navigation">
                <Select
                  label={t('Settings')}
                  value={effectiveSection}
                  onCommit={value => onSection(value as SettingsSection)}
                  options={sections.map(item => ({ value: item.id, label: t(item.label), icon: <RemixIcon name={item.icon} size={16} /> }))}
                />
              </div>
            </div>
            <label className="om-field">
              <RemixIcon name="search-line" size={16} />
              <input
                type="search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder={t('Search settings…')}
                aria-label={t('Search settings')}
              />
            </label>
            <nav aria-label={t('Settings')} className="om-settings-sections">
              {filtered.map((item, index) => (
                <div key={item.id}>
                  {filtered[index - 1]?.group !== item.group && <p className="om-eyebrow">{t(item.group)}</p>}
                  <Button
                    variant="plain"
                    className="om-nav-item"
                    aria-current={effectiveSection === item.id ? 'page' : undefined}
                    onClick={event => {
                      if (item.id === 'privacy' && effectiveSection !== 'privacy') trackStudioClick('settings', 'privacy_settings', undefined, clickMethod(event));
                      onSection(item.id);
                    }}
                  >
                    <RemixIcon name={item.icon} size={16} />
                    <span>{t(item.label)}</span>
                  </Button>
                </div>
              ))}
              {!filtered.length && <p className="om-muted">{t('No matching settings')}</p>}
            </nav>
          </aside>
        </div>
      </div>
      <main key={effectiveSection} className="om-settings-main" aria-label={t(settingsSectionLabel(effectiveSection, localAgentsEnabled, modelProvidersEnabled))}>
        <SettingsSurfaceBoundary>
          {effectiveSection === 'mcp' ? mcp : effectiveSection === 'local' ? <AgentSettings /> : effectiveSection === 'providers' ? (
            <ModelSettings
              key={effectiveSection}
              openAccount={() => onSection('account')}
              openSubscription={() => onSection('subscription')}
              providerId={providerId}
              onProviderChange={onProviderChange}
            />
          ) : effectiveSection === 'account' || effectiveSection === 'subscription' ? (
            <AccountSettings key={effectiveSection} subscription={effectiveSection === 'subscription'} openProviders={openProviders} />
          ) : effectiveSection === 'models' ? (
            <DefaultModels openProviders={openProviders} openAccount={() => onSection('subscription')} />
          ) : effectiveSection === 'appearance' ? (
            <AppearanceSettings />
          ) : effectiveSection === 'privacy' ? (
            <div className="om-settings-page"><h1 className="om-title">{t('Privacy & data')}</h1><PrivacySettings embedded onClose={() => {}} /></div>
          ) : effectiveSection === 'general' ? (
            <GeneralSettings openConnections={() => openConnections('settings_general')} />
          ) : (
            <ResourceSettings about={effectiveSection === 'about'} openConnections={() => openConnections('settings_resources')} />
          )}
        </SettingsSurfaceBoundary>
      </main>
    </div>
  );
}

function DefaultModels({ openProviders, openAccount }: { openProviders?: () => void; openAccount: () => void }) {
  const { t, locale } = useI18n();
  const directory = useProviderDirectory();
  const hasModels = (directory.data?.models.length ?? 0) > 0;
  return (
    <div className="om-settings-page">
      <h1 className="om-title">{t('Default models')}</h1>
      <p className="om-muted">{t('Choose the workspace default model for each media capability on the OpenDesign Model Gateway.')}</p>
      {directory.error ? <SettingsError retry={directory.refresh} /> : !directory.data ? <SettingsLoading /> : (
        <>
          {!hasModels && (
            <section className="om-card om-plan-guide" data-empty-models="true">
              <div className="om-plan-guide-head">
                <h2 className="om-subtitle">{t('No media models available yet')}</h2>
                <span className="om-badge" data-active="true">{t('Plus and above')}</span>
              </div>
              <p className="om-muted">
                {t('Your OpenDesign workspace currently has no available image, video or audio models. Upgrade to Plus to unlock multimodal generation, then sync models.')}
              </p>
              <div className="om-settings-actions">
                <Button variant="ghost" className="om-button h-auto" data-primary onClick={openAccount}>
                  {t('Check account & plan')}
                </Button>
                {openProviders && (
                  <Button variant="ghost" className="om-button h-auto" onClick={openProviders}>
                    {t('Model gateway')}
                  </Button>
                )}
              </div>
            </section>
          )}
          <div className="om-card">
            {cloudModelKinds.map(kind => {
              const model = directory.data?.models.find(item => item.id === directory.data?.defaults[kind]);
              const provider = directory.data?.providers.find(item => item.id === model?.provider);
              return (
                <div className="om-preference-row" key={kind}>
                  <div>
                    <h2 className="om-subtitle">{modelKindLabel(kind, t, locale)}</h2>
                    <p className="om-muted">
                      {model
                        ? `${provider?.label ?? 'OpenDesign'} · ${model.label}${!provider?.available || !model.enabled ? ' · ' + t('Unavailable') : ''}`
                        : t(directory.data?.defaults[kind] ? 'Unavailable model' : hasModels ? 'No default selected' : 'No models available')}
                    </p>
                  </div>
                  <ModelSwitcher capability={kind} label={t('Choose model')} openSettings={openProviders} />
                </div>
              );
            })}
          </div>
        </>
      )}
      <p className="om-muted">{t('External MCP Agents use these workspace defaults when a generation request omits an explicit model.')}</p>
    </div>
  );
}

function GeneralSettings({ openConnections }: { openConnections: () => void }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <div className="om-settings-page">
      <h1 className="om-title">{t('General')}</h1>
      <div className="om-card">
        <div className="om-preference-row">
          <div>
            <h2 className="om-subtitle">{t('Language')}</h2>
            <p className="om-muted">{t('Display language for the workspace')}</p>
          </div>
          <div className="om-preference-control">
            <Select
              label={t('Language')}
              value={locale}
              onCommit={value => {
                if (value !== locale) trackStudioClick('settings', 'language_change', undefined, undefined, clickOption(value));
                setLocale(value as Locale);
              }}
              options={languages.map(item => ({ value: item.locale, label: item.label }))}
            />
          </div>
        </div>
        <div className="om-preference-row">
          <div>
            <h2 className="om-subtitle">{t('Connect Agent')}</h2>
            <p className="om-muted">{t('Connect your preferred Agent over Streamable HTTP MCP.')}</p>
          </div>
          <Button variant="ghost" className="om-button h-auto" onClick={openConnections}>{t('Set up connection')}</Button>
        </div>
      </div>
      <DesktopAppSettings />
      <section className="om-card om-card-stack">
        <h2 className="om-subtitle">{t('Keyboard shortcuts')}</h2>
        <div className="om-preference-row"><span>{t('Open settings')}</span><kbd>⌘ / Ctrl + ,</kbd></div>
        <div className="om-preference-row"><span>{t('Toggle project list')}</span><kbd>Alt + B</kbd></div>
        <div className="om-preference-row"><span>{t('Close menu or dialog')}</span><kbd>Esc</kbd></div>
      </section>
    </div>
  );
}

function DesktopAppSettings() {
  const { t } = useI18n();
  const prefs = useDesktopPreferences();
  const toast = useToast();

  if (!prefs.supported || !prefs.snapshot) return null;

  const { values, descriptors, pendingRestartKeys } = prefs.snapshot;
  const descriptorMap = new Map<DesktopPreferenceKey, DesktopPreferenceDescriptor>(
    descriptors.map(item => [item.key, item]),
  );
  const confirmQuitDesc = descriptorMap.get('confirmBeforeQuit');
  const openAtLoginDesc = descriptorMap.get('openAtLogin');
  const autoUpdatesDesc = descriptorMap.get('autoCheckUpdates');
  const hwAccelDesc = descriptorMap.get('hardwareAcceleration');
  const downloadDirDesc = descriptorMap.get('lastDownloadDir');
  const needsRestart = pendingRestartKeys.length > 0;

  async function updateBoolean<K extends Extract<DesktopWritablePreferenceKey, 'confirmBeforeQuit' | 'openAtLogin' | 'autoCheckUpdates' | 'hardwareAcceleration'>>(
    key: K,
    value: DesktopPreferenceValues[K],
  ) {
    const result = await prefs.setPreference(key, value);
    if (!result.ok) {
      toast.showToast(result.error.message || t('Could not save desktop setting.'), 'error');
      return;
    }
    toast.showToast(
      result.data.applied === 'restart-required'
        ? t('Setting saved. Restart the desktop app to apply.')
        : t('Desktop setting saved'),
      'info',
    );
  }

  async function chooseDownloadFolder() {
    const result = await prefs.pickDownloadDir();
    if (!result.ok) {
      toast.showToast(result.error.message || t('Could not update download folder.'), 'error');
      return;
    }
    if (!result.data.canceled) {
      toast.showToast(t('Download folder updated'), 'info');
    }
  }

  async function resetDownloadFolder() {
    const result = await prefs.resetPreference('lastDownloadDir');
    if (!result.ok) {
      toast.showToast(result.error.message || t('Could not reset download folder.'), 'error');
      return;
    }
    toast.showToast(t('Download folder reset to system default'), 'info');
  }

  async function restartDesktopApp() {
    const result = await prefs.relaunchApp();
    if (!result.ok) {
      toast.showToast(result.error.message || t('Could not restart the desktop app.'), 'error');
    }
  }

  return (
    <section className="om-card om-card-stack" aria-labelledby="om-desktop-settings-heading" data-desktop-preferences="true">
      <div className="om-settings-row">
        <div>
          <h2 id="om-desktop-settings-heading" className="om-subtitle">{t('Desktop app')}</h2>
          <p className="om-muted">{t('These preferences apply only to this computer.')}</p>
        </div>
        {needsRestart && (
          <Button
            variant="primary"
            className="om-button h-auto"
            disabled={prefs.busyKey === '__relaunch__'}
            onClick={() => void restartDesktopApp()}
          >
            {t('Restart to apply')}
          </Button>
        )}
      </div>

      {confirmQuitDesc && (
        <div className="om-preference-row">
          <div>
            <h3 className="om-subtitle">{t('Confirm before quitting')}</h3>
            <p className="om-muted">{t('Ask before closing the desktop app to prevent accidental exits.')}</p>
          </div>
          <Toggle
            label={t('Confirm before quitting')}
            checked={values.confirmBeforeQuit}
            disabled={!confirmQuitDesc.supported || prefs.busyKey === 'confirmBeforeQuit'}
            onChange={checked => void updateBoolean('confirmBeforeQuit', checked)}
          />
        </div>
      )}

      {openAtLoginDesc && (
        <div className="om-preference-row">
          <div>
            <h3 className="om-subtitle">{t('Launch at login')}</h3>
            <p className="om-muted">
              {openAtLoginDesc.supported
                ? t('Automatically open the desktop app when you sign in to this computer.')
                : t(openAtLoginDesc.reason || 'Launch at login is unavailable in this build.')}
            </p>
          </div>
          <Toggle
            label={t('Launch at login')}
            checked={values.openAtLogin}
            disabled={!openAtLoginDesc.supported || prefs.busyKey === 'openAtLogin'}
            onChange={checked => void updateBoolean('openAtLogin', checked)}
          />
        </div>
      )}

      {autoUpdatesDesc && (
        <div className="om-preference-row">
          <div>
            <h3 className="om-subtitle">{t('Automatically check for updates')}</h3>
            <p className="om-muted">{t('Check for new desktop releases shortly after startup.')}</p>
          </div>
          <Toggle
            label={t('Automatically check for updates')}
            checked={values.autoCheckUpdates}
            disabled={!autoUpdatesDesc.supported || prefs.busyKey === 'autoCheckUpdates'}
            onChange={checked => void updateBoolean('autoCheckUpdates', checked)}
          />
        </div>
      )}

      {hwAccelDesc && (
        <div className="om-preference-row">
          <div>
            <h3 className="om-subtitle">{t('Hardware acceleration')}</h3>
            <p className="om-muted">
              {pendingRestartKeys.includes('hardwareAcceleration')
                ? t('Restart the desktop app for the hardware acceleration change to take effect.')
                : t('Use GPU acceleration for smoother previews. Turn off if you see rendering artifacts.')}
            </p>
          </div>
          <Toggle
            label={t('Hardware acceleration')}
            checked={values.hardwareAcceleration}
            disabled={!hwAccelDesc.supported || prefs.busyKey === 'hardwareAcceleration'}
            onChange={checked => void updateBoolean('hardwareAcceleration', checked)}
          />
        </div>
      )}

      {downloadDirDesc && (
        <div className="om-preference-row">
          <div>
            <h3 className="om-subtitle">{t('Download folder')}</h3>
            <p className="om-muted">
              {values.lastDownloadDir || t('System default (Downloads)')}
            </p>
          </div>
          <div className="om-settings-actions">
            <Button
              variant="ghost"
              className="om-button h-auto"
              disabled={!downloadDirDesc.supported || prefs.busyKey === 'lastDownloadDir'}
              onClick={() => void chooseDownloadFolder()}
            >
              {t('Choose folder')}
            </Button>
            {values.lastDownloadDir && (
              <Button
                variant="plain"
                className="om-button h-auto"
                disabled={prefs.busyKey === 'lastDownloadDir'}
                onClick={() => void resetDownloadFolder()}
              >
                {t('Reset')}
              </Button>
            )}
          </div>
        </div>
      )}

      <StudioToastViewport {...toast} />
    </section>
  );
}

function ResourceSettings({ about, openConnections }: { about: boolean; openConnections: () => void }) {
  const { t, locale } = useI18n();
  const desktopApp = isDesktopApp();
  const updater = useDesktopUpdateState();
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const communityLinks = locale === 'zh-CN' ? [feishu, discord] : [discord, feishu];
  const [version, setVersion] = useState<string>();
  useEffect(() => {
    let active = true;
    if (desktopApp) {
      void getDesktopHostBridge()?.info()
        .then(info => { if (active && info?.shellVersion) setVersion(info.shellVersion); })
        .catch(() => {});
    }
    void fetch('/api/health')
      .then(async res => {
        if (!res.ok) throw new Error('unavailable');
        return (await res.json()) as { version?: string };
      })
      .catch(() => gatewayRequest<{ version?: string }>('health'))
      .then(data => { if (active && data?.version) setVersion(current => current || data.version); })
      .catch(() => {});
    return () => { active = false; };
  }, [desktopApp]);
  const links = [
    { label: 'Documentation', href: `${GITHUB_REPOSITORY}/tree/main/docs`, icon: 'file-text-line' },
    ...repositorySupportLinks,
    { label: 'View source code', href: GITHUB_REPOSITORY, icon: 'code-s-slash-line' },
  ];
  const updateStatusLabel =
    updater.state?.status === 'available'
      ? t('Update available: {version}', { version: updater.state.availableVersion || '' })
      : updater.state?.status === 'downloading'
        ? t('Downloading update… {progress}%', { progress: String(updater.state.progress ?? 0) })
        : updater.state?.status === 'downloaded'
          ? t('Update ready to install: {version}', { version: updater.state.availableVersion || '' })
          : updater.state?.status === 'up-to-date'
            ? t('You are on the latest version')
            : updater.state?.status === 'checking'
              ? t('Checking for updates…')
              : updater.state?.status === 'unsupported'
                ? t('Auto-update applies to packaged desktop releases.')
                : updater.state?.status === 'error'
                  ? updater.state.message || t('Update check failed')
                  : t('Desktop updates keep OpenDesign current.');
  return (
    <div className="om-settings-page">
      <h1 className="om-title">{t(about ? 'About OpenMotion' : 'Help')}</h1>
      {about && (
        <section className="om-card om-about-identity">
          <h2 className="om-product-brand" aria-label="OpenMotion" />
          <p className="om-muted">{t('An editable cloud workspace for AI video and motion.')}</p>
          <span className="om-badge">{version ? `${t('Version')} ${version}` : t('Version unavailable')}</span>
        </section>
      )}
      {about && desktopApp && (
        <section className="om-card om-card-stack">
          <div className="om-settings-row">
            <h2 className="om-subtitle">{t('Desktop updates')}</h2>
            {updater.state?.mandatory && (
              <span className="om-desktop-mandatory-badge">
                <RemixIcon name="alert-line" size={14} aria-hidden="true" />
                {t('Update required')}
              </span>
            )}
          </div>
          <p className="om-muted">{updateStatusLabel}</p>
          {updater.state?.status === 'downloading' && (
            <div
              className="om-desktop-update-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.max(0, Math.min(100, Math.round(updater.state.progress ?? 0)))}
            >
              <div
                className="om-desktop-update-progress-bar"
                style={{ width: `${Math.max(0, Math.min(100, Math.round(updater.state.progress ?? 0)))}%` }}
              />
            </div>
          )}
          <div className="om-settings-actions">
            {updater.state?.status === 'downloaded' ? (
              <Button variant="primary" className="om-button h-auto" disabled={updater.busy} onClick={() => void updater.installUpdateNow()}>
                {t('Restart and install update')}
              </Button>
            ) : updater.state?.status === 'available' ? (
              <Button variant="primary" className="om-button h-auto" disabled={updater.busy} onClick={() => void updater.downloadUpdate()}>
                {t('Download update')}
              </Button>
            ) : (
              <Button variant="ghost" className="om-button h-auto" disabled={updater.busy} onClick={() => void updater.checkForUpdates()}>
                {t('Check for updates')}
              </Button>
            )}
            {(updater.state?.releaseNotes || updater.state?.releaseNotesUrl) && (
              <Button variant="ghost" className="om-button h-auto" onClick={() => setReleaseNotesOpen(true)}>
                <RemixIcon name="file-text-line" size={14} />
                {t('View release notes')}
              </Button>
            )}
          </div>
          {updater.state && (
            <DesktopReleaseNotesDialog
              open={releaseNotesOpen}
              onClose={() => setReleaseNotesOpen(false)}
              state={updater.state}
              busy={updater.busy}
              onDownload={() => void updater.downloadUpdate()}
              onInstall={() => void updater.installUpdateNow()}
            />
          )}
        </section>
      )}
      <div className="om-card om-resource-links">
        {links.map((link, index) => (
          <a
            className="om-nav-item om-resource-link"
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => tracking.reportSettingsClick('help_resources', 'open_resource', { position: index + 1 })}
          >
            <span className="om-menu-label"><RemixIcon name={link.icon} size={16} />{t(link.label)}</span>
            <RemixIcon name="external-link-line" size={16} />
          </a>
        ))}
        <Button variant="plain" className="om-nav-item om-resource-link" onClick={openConnections}>
          <span className="om-menu-label"><RemixIcon name="plug-line" size={16} />{t('Connect Agent')}</span>
          <RemixIcon name="arrow-right-line" size={16} />
        </Button>
      </div>
      {!about && (
        <section className="om-card om-resource-links" aria-labelledby="om-community-heading">
          <h2 id="om-community-heading" className="om-subtitle">{t('Community')}</h2>
          {communityLinks.map((link, index) => (
            <a
              key={link.href}
              className="om-nav-item om-resource-link"
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => tracking.reportSettingsClick('help_resources', 'community', { position: index + 1 })}
            >
              <span>{link === feishu ? t('Feishu group') : link.platform}</span>
              <RemixIcon name="external-link-line" size={16} />
            </a>
          ))}
        </section>
      )}
      {!about && (
        <section className="om-card om-card-stack">
          <h2 className="om-subtitle">{t('Diagnostics & logs')}</h2>
          <DiagnosticExport />
        </section>
      )}
      {about && (
        <section className="om-card om-card-stack">
          <h2 className="om-subtitle">{t('Acknowledgements')}</h2>
          <p className="om-muted">{t('Built with Hyperframes and the OpenMotion design system. Account identity and media generation are powered by OpenDesign.')}</p>
        </section>
      )}
    </div>
  );
}
