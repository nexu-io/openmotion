import { Dialog } from '@base-ui/react/dialog';
import type { ReactNode } from 'react';
import { IconButton } from 'open-design-ui/icon-button';
import { useI18n } from '../../i18n/I18n';
import { RemixIcon } from '../../icons/RemixIcons';

export function CollabDialog({
  open,
  title,
  description,
  onClose,
  children,
  className = '',
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  if (!open) return null;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="om-collab-dialog-backdrop" />
        <Dialog.Popup
          data-feedback-modal
          className={`om-dialog om-collab-dialog ${className}`.trim()}
          onKeyDown={event => event.stopPropagation()}
        >
          <header className="om-collab-dialog-head">
            <div className="om-collab-dialog-head-copy">
              <Dialog.Title className="om-collab-dialog-title">{title}</Dialog.Title>
              {description && <Dialog.Description className="om-collab-dialog-desc">{description}</Dialog.Description>}
            </div>
            <Dialog.Close
              render={
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={t('Close')}
                  icon={<RemixIcon name="close-line" size={16} />}
                />
              }
            />
          </header>
          <div className="om-collab-dialog-body">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
