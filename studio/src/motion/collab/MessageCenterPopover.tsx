import { useEffect, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import type { MessageCenterMessage } from '../../../../shared/growth-surfaces';
import { Popover } from '../../components/ui/Popover';
import { Skeleton } from '../../components/ui/Skeleton';
import { Tooltip } from '../../components/ui/Tooltip';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';
import { openExternalUrl } from '../../utils/platformHost';
import { WORKSPACE_LOCATION_CHANGED } from '../../utils/workspaceHistory';
import { useOptionalGrowthSurfaces } from './GrowthSurfacesContext';

type Shelf = 'inbox' | 'archived';

function MessageCenterRow({
  item,
  archived,
  expanded,
  onToggleExpand,
  onToggleArchive,
  formatDate,
}: {
  item: MessageCenterMessage;
  archived: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleArchive: () => void;
  formatDate: (date: Date, options?: Intl.DateTimeFormatOptions) => string;
}) {
  const { t } = useI18n();
  const [imageError, setImageError] = useState(false);
  const unread = item.readAt == null;
  const publishedMs = Date.parse(item.publishedAt);
  const dateLabel = Number.isFinite(publishedMs)
    ? formatDate(new Date(publishedMs), { month: 'short', day: 'numeric' })
    : '';

  return (
    <li
      className="om-message-center-item"
      data-unread={unread || undefined}
      data-expanded={expanded || undefined}
      data-testid="message-center-item"
    >
      <div className="om-message-center-row-head">
        <Button
          variant="plain"
          type="button"
          className="om-message-center-row-btn"
          aria-expanded={expanded}
          onClick={onToggleExpand}
        >
          <span className="om-message-center-row-top">
            <span className="om-message-center-row-meta">
              {unread && <span className="om-message-center-unread-dot" aria-hidden="true" />}
              <span className="om-message-center-type">{item.typeName}</span>
            </span>
            {dateLabel && <span className="om-message-center-date">{dateLabel}</span>}
          </span>
          <strong className="om-message-center-item-title">{item.title}</strong>
          {!expanded && item.body && <span className="om-message-center-item-preview">{item.body}</span>}
        </Button>

        <Tooltip label={t(archived ? 'Restore notification' : 'Archive notification')} side="left">
          <IconButton
            variant="ghost"
            size="sm"
            type="button"
            className="om-message-center-archive-btn"
            aria-label={t(archived ? 'Restore notification' : 'Archive notification')}
            onClick={onToggleArchive}
            icon={<RemixIcon name={archived ? 'inbox-unarchive-line' : 'inbox-archive-line'} size={14} />}
          />
        </Tooltip>
      </div>

      {expanded && (
        <div className="om-message-center-item-detail">
          {item.imageUrl && !imageError && (
            <img
              src={item.imageUrl}
              alt=""
              className="om-message-center-item-cover"
              onError={() => setImageError(true)}
            />
          )}
          {item.body && <p className="om-message-center-item-body">{item.body}</p>}
          {item.ctaUrl && (
            <div className="om-message-center-item-actions">
              <Button
                variant="plain"
                size="sm"
                type="button"
                className="om-collab-tonal-btn"
                data-compact="true"
                onClick={() => void openExternalUrl(item.ctaUrl!)}
              >
                <span>{item.ctaLabel || t('Learn more')}</span>
                <RemixIcon name="external-link-line" size={12} />
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function MessageCenterPopover() {
  const { t, formatDate } = useI18n();
  const growth = useOptionalGrowthSurfaces();
  const [shelf, setShelf] = useState<Shelf>('inbox');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const open = growth?.messageCenterOpen ?? false;
  const setOpen = growth?.setMessageCenterOpen;

  useEffect(() => {
    if (!open || !setOpen) return;
    const dismissOnNav = () => setOpen(false);
    window.addEventListener(WORKSPACE_LOCATION_CHANGED, dismissOnNav);
    window.addEventListener('popstate', dismissOnNav);
    return () => {
      window.removeEventListener(WORKSPACE_LOCATION_CHANGED, dismissOnNav);
      window.removeEventListener('popstate', dismissOnNav);
    };
  }, [open, setOpen]);

  if (!growth) return null;

  const {
    messages,
    archivedIds,
    unreadCount,
    messagesLoading,
    messagesError,
    refreshMessages,
    markMessageRead,
    markAllMessagesRead,
    toggleArchiveMessage,
  } = growth;

  const inboxMessages = messages.filter(item => !archivedIds.has(item.id));
  const archivedMessages = messages.filter(item => archivedIds.has(item.id));
  const visibleMessages = shelf === 'archived' ? archivedMessages : inboxMessages;

  const triggerLabel =
    unreadCount > 0 ? t('Notifications ({count} unread)', { count: unreadCount }) : t('Notifications');
  const badgeText = unreadCount > 9 ? '9+' : String(unreadCount);

  return (
    <Popover
      open={open}
      onOpenChange={next => setOpen?.(next)}
      side="bottom"
      align="end"
      modal={false}
      initialFocus={false}
      tooltip={triggerLabel}
      aria-label={t('Notifications')}
      className="om-message-center-popover om-selection-panel"
      trigger={
        <Button
          variant="plain"
          type="button"
          className="om-nav-item om-message-center-trigger"
          data-unread={unreadCount > 0 || undefined}
          data-testid="message-center-trigger"
          aria-label={triggerLabel}
          aria-expanded={open}
        >
          <RemixIcon name="notification-3-line" size={16} />
          {unreadCount > 0 && (
            <span className="om-message-center-badge" data-testid="message-center-unread" aria-hidden="true">
              {badgeText}
            </span>
          )}
        </Button>
      }
    >
      <div className="om-message-center-panel" data-testid="message-center-panel">
        <header className="om-message-center-head">
          <strong>{t('Notifications')}</strong>
          {shelf === 'inbox' && unreadCount > 0 && (
            <Button
              variant="plain"
              size="sm"
              type="button"
              className="om-collab-tonal-btn"
              data-compact="true"
              data-testid="message-center-mark-all"
              onClick={() => void markAllMessagesRead()}
            >
              <RemixIcon name="check-double-line" size={13} />
              <span>{t('Mark all read')}</span>
            </Button>
          )}
        </header>

        <div className="om-message-center-tabs" role="tablist" aria-label={t('Notification shelves')}>
          <Button
            variant="plain"
            size="sm"
            type="button"
            role="tab"
            aria-selected={shelf === 'inbox'}
            className="om-message-center-tab"
            data-active={shelf === 'inbox' || undefined}
            data-testid="message-center-tab-inbox"
            onClick={() => setShelf('inbox')}
          >
            <span>{t('Inbox')}</span>
            <span className="om-message-center-tab-count">{inboxMessages.length}</span>
          </Button>
          <Button
            variant="plain"
            size="sm"
            type="button"
            role="tab"
            aria-selected={shelf === 'archived'}
            className="om-message-center-tab"
            data-active={shelf === 'archived' || undefined}
            data-testid="message-center-tab-archived"
            onClick={() => setShelf('archived')}
          >
            <span>{t('Archived')}</span>
            <span className="om-message-center-tab-count">{archivedMessages.length}</span>
          </Button>
        </div>

        <div className="om-message-center-body">
          {messagesLoading && visibleMessages.length === 0 ? (
            <div className="om-message-center-skeletons" aria-busy="true">
              <Skeleton style={{ width: '100%', height: '56px' }} />
              <Skeleton style={{ width: '100%', height: '56px' }} />
              <Skeleton style={{ width: '85%', height: 'var(--motion-space-40)' }} />
            </div>
          ) : messagesError && visibleMessages.length === 0 ? (
            <div className="om-collab-tonal-card" data-tone="danger" data-testid="message-center-error">
              <p className="om-collab-dialog-copy">{t('Could not load notifications.')}</p>
              <div className="om-message-center-item-actions">
                <Button
                  variant="plain"
                  size="sm"
                  type="button"
                  className="om-collab-tonal-btn"
                  data-compact="true"
                  onClick={() => void refreshMessages()}
                >
                  <RemixIcon name="refresh-line" size={13} />
                  <span>{t('Retry')}</span>
                </Button>
              </div>
            </div>
          ) : visibleMessages.length === 0 ? (
            <p className="om-message-center-empty" data-testid="message-center-empty">
              {t(shelf === 'archived' ? 'No archived notifications.' : 'No notifications yet.')}
            </p>
          ) : (
            <ul className="om-message-center-list">
              {visibleMessages.map(item => {
                const isExpanded = expandedId === item.id;
                return (
                  <MessageCenterRow
                    key={item.id}
                    item={item}
                    archived={archivedIds.has(item.id)}
                    expanded={isExpanded}
                    formatDate={formatDate}
                    onToggleExpand={() => {
                      setExpandedId(prev => (prev === item.id ? null : item.id));
                      if (item.readAt == null) {
                        void markMessageRead(item.id).catch(() => {});
                      }
                    }}
                    onToggleArchive={() => {
                      toggleArchiveMessage(item.id);
                      if (isExpanded) setExpandedId(null);
                    }}
                  />
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Popover>
  );
}
