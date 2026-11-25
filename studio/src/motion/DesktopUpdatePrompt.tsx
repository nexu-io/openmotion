import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { DEFAULT_DESKTOP_DOWNLOAD_URL } from '../../../shared/desktop-builtin-rules';
import type { DesktopUpdateState } from '../../../shared/platform-host';
import { RemixIcon } from '../icons/RemixIcons';
import { useI18n } from '../i18n/I18n';
import { isDesktopApp, openExternalUrl, useDesktopUpdateState } from '../utils/platformHost';

export type ReleaseNotesBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'paragraph'; text: string };

/**
 * Splits sanitized plain-text release notes into structured semantic blocks so
 * Studio renders headings, bullets, and paragraphs cleanly without ever using
 * `dangerouslySetInnerHTML`.
 */
export function parseReleaseNotesBlocks(raw: string): ReleaseNotesBlock[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReleaseNotesBlock[] = [];
  let pendingItems: string[] = [];

  const flushList = () => {
    if (pendingItems.length > 0) {
      blocks.push({ kind: 'list', items: pendingItems });
      pendingItems = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }
    const bulletMatch = /^(?:[-*•]\s+)(.+)$/.exec(line);
    if (bulletMatch?.[1]) {
      pendingItems.push(bulletMatch[1].trim());
      continue;
    }
    flushList();
    const headingMatch = /^#{1,6}\s+(.+)$/.exec(line);
    if (headingMatch?.[1]) {
      blocks.push({ kind: 'heading', text: headingMatch[1].trim() });
      continue;
    }
    if (/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/i.test(line)) {
      blocks.push({ kind: 'heading', text: line });
      continue;
    }
    blocks.push({ kind: 'paragraph', text: line });
  }
  flushList();
  return blocks;
}

function formatVersionLabel(version?: string): string {
  if (!version) return '';
  const trimmed = version.trim();
  if (!trimmed) return '';
  return /^v/i.test(trimmed) ? trimmed : `v${trimmed}`;
}

function ReleaseNotesBody({ notes, hasExternalUrl }: { notes?: string; hasExternalUrl: boolean }) {
  const { t } = useI18n();
  const blocks = notes ? parseReleaseNotesBlocks(notes) : [];
  if (blocks.length === 0) {
    return (
      <p className="om-muted om-desktop-update-notes-paragraph">
        {hasExternalUrl
          ? t('Release notes are available online for this version.')
          : t('No release notes were provided for this version.')}
      </p>
    );
  }
  return (
    <div className="om-desktop-update-notes">
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          return (
            <h3 key={`h-${index}`} className="om-desktop-update-notes-heading">
              {block.text}
            </h3>
          );
        }
        if (block.kind === 'list') {
          return (
            <ul key={`l-${index}`} className="om-desktop-update-notes-list">
              {block.items.map((item, itemIdx) => (
                <li key={`i-${itemIdx}`}>{item}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={`p-${index}`} className="om-desktop-update-notes-paragraph">
            {block.text}
          </p>
        );
      })}
    </div>
  );
}

export function DesktopReleaseNotesDialog({
  open,
  onClose,
  state,
  busy = false,
  onDownload,
  onInstall,
}: {
  open: boolean;
  onClose: () => void;
  state: DesktopUpdateState;
  busy?: boolean;
  onDownload?: () => void;
  onInstall?: () => void;
}) {
  const { t } = useI18n();
  if (!open) return null;

  const targetVersion = formatVersionLabel(state.availableVersion);
  const currentVersion = formatVersionLabel(state.currentVersion);
  const title = targetVersion
    ? t("What's new in {version}", { version: targetVersion })
    : t('Release notes');

  return (
    <Dialog.Root open onOpenChange={nextOpen => { if (!nextOpen) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop forceRender className="hf-overlay-backdrop om-settings-backdrop" />
        <Dialog.Popup
          data-feedback-modal
          className="om-dialog om-settings-dialog om-desktop-update-dialog"
          onKeyDown={event => event.stopPropagation()}
        >
          <header className="om-settings-row">
            <Dialog.Title className="om-subtitle">{title}</Dialog.Title>
            <Dialog.Close className="motion-icon-button" aria-label={t('Close')}>
              <RemixIcon name="close-line" size={20} />
            </Dialog.Close>
          </header>

          {(currentVersion || targetVersion) && (
            <div className="om-desktop-update-meta">
              {currentVersion && <span className="om-badge">{currentVersion}</span>}
              {currentVersion && targetVersion && (
                <RemixIcon name="arrow-right-line" size={14} aria-hidden="true" />
              )}
              {targetVersion && <span className="om-badge">{targetVersion}</span>}
            </div>
          )}

          <ReleaseNotesBody
            notes={state.releaseNotes}
            hasExternalUrl={Boolean(state.releaseNotesUrl)}
          />

          <footer className="om-dialog-actions">
            {state.releaseNotesUrl && (
              <Button
                variant="ghost"
                className="om-button h-auto"
                onClick={() => void openExternalUrl(state.releaseNotesUrl!)}
              >
                <RemixIcon name="external-link-line" size={14} />
                {t('View full release notes')}
              </Button>
            )}
            <Button variant="ghost" className="om-button h-auto" onClick={onClose}>
              {t('Close')}
            </Button>
            {state.status === 'downloaded' && onInstall && (
              <Button
                variant="primary"
                className="om-button h-auto"
                disabled={busy}
                onClick={onInstall}
              >
                {t('Restart and install update')}
              </Button>
            )}
            {state.status === 'available' && onDownload && (
              <Button
                variant="primary"
                className="om-button h-auto"
                disabled={busy}
                onClick={onDownload}
              >
                {t('Download update')}
              </Button>
            )}
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DesktopMandatoryUpdateGate({
  state,
  busy,
  onCheck,
  onDownload,
  onInstall,
}: {
  state: DesktopUpdateState;
  busy: boolean;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const [showNotes, setShowNotes] = useState(false);

  const currentVersion = formatVersionLabel(state.currentVersion) || state.currentVersion;
  const requiredVersion = formatVersionLabel(state.minRequiredVersion) || state.minRequiredVersion || '';
  const availableVersion = formatVersionLabel(state.availableVersion);
  const progress = Math.max(0, Math.min(100, Math.round(state.progress ?? 0)));
  const manualDownloadUrl = state.downloadUrl || state.releaseNotesUrl || DEFAULT_DESKTOP_DOWNLOAD_URL;

  const statusText =
    state.status === 'downloaded'
      ? t('Update ready to install: {version}', { version: availableVersion || requiredVersion })
      : state.status === 'downloading'
        ? t('Downloading update… {progress}%', { progress: String(progress) })
        : state.status === 'checking'
          ? t('Checking for updates…')
          : state.status === 'available'
            ? t('Update available: {version}', { version: availableVersion || requiredVersion })
            : state.status === 'error'
              ? state.message || t('Update check failed')
              : t('Automatic update is currently unavailable. Download the latest installer manually to continue.');

  return (
    <Dialog.Root open disablePointerDismissal onOpenChange={() => {}}>
      <Dialog.Portal>
        <Dialog.Backdrop forceRender className="hf-overlay-backdrop om-desktop-mandatory-backdrop" />
        <Dialog.Popup
          role="alertdialog"
          aria-modal="true"
          data-feedback-modal
          className="om-dialog om-settings-dialog om-desktop-mandatory-dialog"
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault();
            }
            event.stopPropagation();
          }}
        >
          <div className="om-desktop-mandatory-badge">
            <RemixIcon name="alert-line" size={14} aria-hidden="true" />
            <span>{t('Update required')}</span>
          </div>

          <Dialog.Title className="om-subtitle">
            {t('Please update OpenDesign to continue')}
          </Dialog.Title>

          <p className="om-muted om-desktop-update-notes-paragraph">
            {t('This version ({current}) is no longer supported. Update to {required} or later to keep using OpenDesign.', {
              current: currentVersion,
              required: requiredVersion || availableVersion || t('the latest version'),
            })}
          </p>

          {state.mandatoryReason && (
            <div className="om-desktop-mandatory-reason">
              {state.mandatoryReason}
            </div>
          )}

          <div className="om-desktop-mandatory-status" role="status" aria-live="polite">
            <p className="om-muted om-desktop-update-notes-paragraph">{statusText}</p>
            {state.status === 'downloading' && (
              <div
                className="om-desktop-update-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
              >
                <div
                  className="om-desktop-update-progress-bar"
                  style={{ width: `${progress}%` }}
                />
              </div>
            )}
          </div>

          {state.releaseNotes && (
            <div>
              <Button
                variant="plain"
                className="om-button h-auto"
                onClick={() => setShowNotes(prev => !prev)}
              >
                <RemixIcon name="file-text-line" size={14} />
                {showNotes ? t('Hide release notes') : t('View release notes')}
              </Button>
              {showNotes && (
                <ReleaseNotesBody
                  notes={state.releaseNotes}
                  hasExternalUrl={Boolean(state.releaseNotesUrl)}
                />
              )}
            </div>
          )}

          <footer className="om-dialog-actions">
            <Button
              variant="ghost"
              className="om-button h-auto"
              onClick={() => void openExternalUrl(manualDownloadUrl)}
            >
              <RemixIcon name="external-link-line" size={14} />
              {t('Download manually')}
            </Button>

            {state.status === 'downloaded' ? (
              <Button
                variant="primary"
                className="om-button h-auto"
                disabled={busy}
                onClick={onInstall}
              >
                {t('Restart and install update')}
              </Button>
            ) : state.status === 'available' ? (
              <Button
                variant="primary"
                className="om-button h-auto"
                disabled={busy}
                onClick={onDownload}
              >
                {t('Download update')}
              </Button>
            ) : state.status === 'downloading' || state.status === 'checking' ? (
              <Button variant="primary" className="om-button h-auto" disabled>
                {state.status === 'downloading'
                  ? t('Downloading update… {progress}%', { progress: String(progress) })
                  : t('Checking for updates…')}
              </Button>
            ) : (
              <Button
                variant="primary"
                className="om-button h-auto"
                disabled={busy}
                onClick={onCheck}
              >
                <RemixIcon name="refresh-fill" size={14} />
                {t('Check for updates')}
              </Button>
            )}
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * In-app desktop update prompt mounted in WorkspaceFrame:
 * 1. Mandatory update blocking modal when `state.mandatory` is active.
 * 2. Non-intrusive floating update banner for downloading / available / ready states.
 * 3. Release notes preview dialog accessible directly from the banner.
 *
 * Always renders nothing on Web (when no Electron host bridge is present).
 */
export function DesktopUpdatePrompt() {
  const desktopApp = isDesktopApp();
  const { t } = useI18n();
  const updater = useDesktopUpdateState();
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);

  if (!desktopApp || !updater.state) return null;

  const state = updater.state;

  if (state.mandatory) {
    return (
      <DesktopMandatoryUpdateGate
        state={state}
        busy={updater.busy}
        onCheck={() => void updater.checkForUpdates()}
        onDownload={() => void updater.downloadUpdate()}
        onInstall={() => void updater.installUpdateNow()}
      />
    );
  }

  const showBannerStatus =
    state.status === 'downloaded' ||
    state.status === 'downloading' ||
    state.status === 'available';

  if (!showBannerStatus) return null;

  const stage = state.status === 'downloaded' ? 'ready' : 'progress';
  const currentDismissKey = `${stage}:${state.availableVersion ?? ''}`;
  const isDismissed = dismissedKey === currentDismissKey;
  const versionLabel = formatVersionLabel(state.availableVersion);
  const progress = Math.max(0, Math.min(100, Math.round(state.progress ?? 0)));
  const hasNotes = Boolean(state.releaseNotes || state.releaseNotesUrl);

  return (
    <>
      {!isDismissed && (
        <aside
          className="om-desktop-update-banner"
          role="status"
          aria-live="polite"
          aria-label={t('Desktop updates')}
        >
          <div className="om-desktop-update-banner-head">
            <span className="om-desktop-update-banner-icon" aria-hidden="true">
              <RemixIcon
                name={state.status === 'downloaded' ? 'sparkling-line' : 'download-2-fill'}
                size={16}
              />
            </span>
            <div className="om-desktop-update-banner-copy">
              <strong className="om-desktop-update-banner-title">
                {state.status === 'downloaded'
                  ? versionLabel
                    ? t('OpenDesign {version} is ready', { version: versionLabel })
                    : t('Update ready to install')
                  : state.status === 'downloading'
                    ? t('Downloading update… {progress}%', { progress: String(progress) })
                    : versionLabel
                      ? t('Update available: {version}', { version: versionLabel })
                      : t('Update available')}
              </strong>
              <span className="om-desktop-update-banner-desc">
                {state.status === 'downloaded'
                  ? t('Restart now to apply the latest desktop update.')
                  : state.status === 'downloading'
                    ? t('The update is downloading in the background.')
                    : t('A newer desktop version is ready to download.')}
              </span>
            </div>
            <IconButton
              variant="plain"
              type="button"
              className="motion-icon-button"
              aria-label={t('Later')}
              onClick={() => setDismissedKey(currentDismissKey)}
              icon={<RemixIcon name="close-line" size={16} />}
            />
          </div>

          {state.status === 'downloading' && (
            <div
              className="om-desktop-update-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <div
                className="om-desktop-update-progress-bar"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          {state.status !== 'downloading' && (
            <div className="om-desktop-update-banner-actions">
              {state.status === 'downloaded' ? (
                <Button
                  variant="primary"
                  className="om-button h-auto"
                  disabled={updater.busy}
                  onClick={() => void updater.installUpdateNow()}
                >
                  {t('Restart and install update')}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  className="om-button h-auto"
                  disabled={updater.busy}
                  onClick={() => void updater.downloadUpdate()}
                >
                  {t('Download update')}
                </Button>
              )}
              {hasNotes && (
                <Button
                  variant="ghost"
                  className="om-button h-auto"
                  onClick={() => setNotesOpen(true)}
                >
                  {t("What's new")}
                </Button>
              )}
              <Button
                variant="plain"
                className="om-button h-auto"
                onClick={() => setDismissedKey(currentDismissKey)}
              >
                {t('Later')}
              </Button>
            </div>
          )}
        </aside>
      )}

      <DesktopReleaseNotesDialog
        open={notesOpen}
        onClose={() => setNotesOpen(false)}
        state={state}
        busy={updater.busy}
        onDownload={() => void updater.downloadUpdate()}
        onInstall={() => void updater.installUpdateNow()}
      />
    </>
  );
}
