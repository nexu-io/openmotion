import { Button } from 'open-design-ui/button';
import type { CapabilityDefinition } from '../../../shared/capability-registry';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { resolveSoundTabs, type SoundTabId } from './soundTabs';

export function SoundSceneTabs({
  activeTab,
  capabilities,
  onSelectTab,
}: {
  activeTab: SoundTabId;
  capabilities?: readonly CapabilityDefinition[];
  onSelectTab: (tabId: SoundTabId) => void;
}) {
  const { t } = useI18n();
  const tabs = resolveSoundTabs(capabilities);

  return (
    <div className="om-sound-tabs-strip">
      {tabs.map(tab => {
        const active = tab.id === activeTab;
        return (
          <Button
            key={tab.id}
            type="button"
            variant="plain"
            className="om-nav-item om-sound-tab"
            data-sound-tab={tab.id}
            data-status={tab.status}
            aria-current={active ? 'page' : undefined}
            onClick={() => {
              if (!active) onSelectTab(tab.id);
            }}
          >
            <RemixIcon name={tab.icon} size={14} className="om-sound-tab-icon" />
            <span>{t(tab.label)}</span>
            {tab.status === 'soon' && (
              <span className="om-sound-soon-tag">{t('Soon')}</span>
            )}
          </Button>
        );
      })}
    </div>
  );
}
