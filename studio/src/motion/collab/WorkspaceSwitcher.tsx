import { useEffect, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { Popover } from '../../components/ui/Popover';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { WORKSPACE_LOCATION_CHANGED } from '../../utils/workspaceHistory';
import { useOptionalWorkspaceCollab } from '../WorkspaceCollabContext';

const avatarSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function initialFor(name: string): string {
  return (avatarSegmenter.segment(name.trim() || 'W')[Symbol.iterator]().next().value?.segment ?? 'W').toUpperCase();
}

export function WorkspaceSwitcher() {
  const { t } = useI18n();
  const collab = useOptionalWorkspaceCollab();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener(WORKSPACE_LOCATION_CHANGED, close);
    return () => window.removeEventListener(WORKSPACE_LOCATION_CHANGED, close);
  }, []);

  const snapshot = collab?.snapshot;
  const active = snapshot?.activeWorkspace;
  if (!collab || !snapshot?.signedIn || !active) return null;

  const personal = snapshot.workspaces.filter(item => item.workspaceType === 'personal');
  const teams = snapshot.workspaces.filter(item => item.workspaceType === 'team');

  const roleLabel = (role: string) =>
    role === 'owner' ? t('Owner') : role === 'admin' ? t('Admin') : t('Member');

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="start"
      initialFocus={false}
      aria-label={t('Switch workspace')}
      className="om-ws-switcher-popover"
      trigger={
        <Button
          variant="plain"
          type="button"
          className="om-nav-item om-ws-switcher-trigger"
          data-testid="workspace-switcher-trigger"
          aria-label={t('Switch workspace')}
          aria-expanded={open}
        >
          <span className="om-ws-avatar-dot" data-type={active.workspaceType} aria-hidden="true">
            {initialFor(active.workspaceName)}
          </span>
          <span className="om-ws-switcher-name">{active.workspaceName}</span>
          <span className="om-ws-scope-pill">
            {t(active.workspaceType === 'team' ? 'Team' : 'Personal')}
          </span>
          <RemixIcon name="arrow-down-s-line" size={14} />
        </Button>
      }
    >
      {personal.length > 0 && (
        <>
          <div className="om-ws-popover-section-label">{t('Personal')}</div>
          {personal.map(ws => {
            const isCurrent = ws.workspaceId === active.workspaceId;
            return (
              <Button
                key={ws.workspaceId}
                variant="plain"
                type="button"
                className="om-ws-popover-option"
                data-active={isCurrent || undefined}
                disabled={collab.switching}
                onClick={() => {
                  setOpen(false);
                  if (!isCurrent) collab.requestSwitchWorkspace(ws.workspaceId);
                }}
              >
                <span className="om-ws-popover-option-main">
                  <span className="om-ws-avatar-dot" data-type="personal" aria-hidden="true">
                    {initialFor(ws.workspaceName)}
                  </span>
                  <span className="om-ws-popover-option-copy">
                    <strong>{ws.workspaceName}</strong>
                    <span>{t('Personal workspace')}</span>
                  </span>
                </span>
                {isCurrent && <RemixIcon name="check-line" size={15} />}
              </Button>
            );
          })}
        </>
      )}

      {teams.length > 0 && (
        <>
          <div className="om-ws-popover-section-label">{t('Teams')}</div>
          {teams.map(ws => {
            const isCurrent = ws.workspaceId === active.workspaceId;
            const locked = ws.lifecycleState === 'locked' || ws.lifecycleState === 'billing_past_due';
            return (
              <Button
                key={ws.workspaceId}
                variant="plain"
                type="button"
                className="om-ws-popover-option"
                data-active={isCurrent || undefined}
                disabled={collab.switching}
                onClick={() => {
                  setOpen(false);
                  if (!isCurrent) collab.requestSwitchWorkspace(ws.workspaceId);
                }}
              >
                <span className="om-ws-popover-option-main">
                  <span className="om-ws-avatar-dot" data-type="team" aria-hidden="true">
                    {initialFor(ws.workspaceName)}
                  </span>
                  <span className="om-ws-popover-option-copy">
                    <strong>{ws.workspaceName}</strong>
                    <span>
                      {roleLabel(ws.role)}
                      {locked ? ` · ${t('Paused')}` : ''}
                    </span>
                  </span>
                </span>
                {locked ? <RemixIcon name="lock-line" size={14} /> : isCurrent ? <RemixIcon name="check-line" size={15} /> : null}
              </Button>
            );
          })}
        </>
      )}

      <div className="om-ws-popover-divider" />
      <Button
        variant="plain"
        type="button"
        className="om-ws-popover-option"
        onClick={() => {
          setOpen(false);
          collab.setInviteDialogOpen(true);
        }}
      >
        <span className="om-ws-popover-option-main">
          <RemixIcon name="group-line" size={15} />
          <span className="om-ws-popover-option-copy">
            <strong>{t('Invite teammates')}</strong>
          </span>
        </span>
        {snapshot.referral?.available && (
          <span className="om-header-invite-reward">
            <RemixIcon name="sparkling-fill" size={11} />
            <span>{t('Reset card')}</span>
          </span>
        )}
      </Button>
      <Button
        variant="plain"
        type="button"
        className="om-ws-popover-option"
        disabled={Boolean(collab.openingCloudDestination)}
        aria-busy={collab.openingCloudDestination === 'create-workspace' || undefined}
        onClick={() => {
          void collab.openCloudLink('create-workspace').finally(() => setOpen(false));
        }}
      >
        <span className="om-ws-popover-option-main">
          <RemixIcon name="add-line" size={15} />
          <span className="om-ws-popover-option-copy">
            <strong>{t('Create team workspace')}</strong>
          </span>
        </span>
        <RemixIcon
          name={collab.openingCloudDestination === 'create-workspace' ? 'loader-4-line' : 'external-link-line'}
          size={14}
          className={collab.openingCloudDestination === 'create-workspace' ? 'animate-spin motion-reduce:animate-none' : undefined}
        />
      </Button>
    </Popover>
  );
}
