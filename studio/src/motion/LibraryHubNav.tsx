import { Button } from 'open-design-ui/button';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { preloadWorkspacePage, type LazyPageKey } from '../router/lazyPages';
import { useOptionalWorkspaceChrome, type WorkspaceSurfaceKey } from './WorkspaceChromeContext';
import './workspaceCollab.css';

export type LibraryHubTab = 'timeline' | 'projects' | 'brand-kits';

export function LibraryHubNav({ activeTab }: { activeTab: LibraryHubTab }) {
  const { t } = useI18n();
  const chrome = useOptionalWorkspaceChrome();
  if (!chrome) return null;

  const tabs: Array<{
    id: LibraryHubTab;
    label: string;
    icon: string;
    tone: LibraryHubTab;
    lazyKey: LazyPageKey;
    surfaceKey: WorkspaceSurfaceKey;
    onSelect: () => void;
  }> = [
    {
      id: 'timeline',
      label: t('All creations'),
      icon: 'time-line',
      tone: 'timeline',
      lazyKey: 'assets',
      surfaceKey: 'assets',
      onSelect: () => chrome.openAssets(),
    },
    ...(chrome.openProjects
      ? [
          {
            id: 'projects' as const,
            label: t('Projects'),
            icon: 'folder-3-line',
            tone: 'projects' as const,
            lazyKey: 'projects' as const,
            surfaceKey: 'projects' as const,
            onSelect: () => chrome.openProjects?.(),
          },
        ]
      : []),
    ...(chrome.openBrandKit
      ? [
          {
            id: 'brand-kits' as const,
            label: t('Brand Kits'),
            icon: 'palette-fill',
            tone: 'brand-kits' as const,
            lazyKey: 'brandKit' as const,
            surfaceKey: 'brand-kit' as const,
            onSelect: () => chrome.openBrandKit?.(),
          },
        ]
      : []),
  ];

  const prefetch = (lazyKey: LazyPageKey, surfaceKey: WorkspaceSurfaceKey) => {
    preloadWorkspacePage(lazyKey);
    chrome.preloadSurface?.(surfaceKey);
  };

  return (
    <nav
      className="om-library-hub-nav"
      data-testid="library-hub-nav"
      aria-label={t('Library sections')}
    >
      {tabs.map(tab => {
        const current = activeTab === tab.id;
        return (
          <Button
            key={tab.id}
            variant="plain"
            type="button"
            className="om-library-hub-tab"
            data-testid={`library-hub-tab-${tab.id}`}
            aria-current={current ? 'page' : undefined}
            onPointerEnter={() => prefetch(tab.lazyKey, tab.surfaceKey)}
            onFocus={() => prefetch(tab.lazyKey, tab.surfaceKey)}
            onClick={() => {
              if (!current) tab.onSelect();
            }}
          >
            <span className="om-library-hub-icon" data-tone={tab.tone} aria-hidden="true">
              <RemixIcon name={tab.icon} size={13} />
            </span>
            <span>{tab.label}</span>
          </Button>
        );
      })}
    </nav>
  );
}
