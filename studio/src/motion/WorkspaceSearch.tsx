import { Button } from 'open-design-ui/button';
import { Suspense, useState } from 'react';
import type { CreativeStudio, ExploreCommunity } from '../../../shared/studio-catalog';
import { Popover } from '../components/ui/Popover';
import { Skeleton } from '../components/ui/Skeleton';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import type { StudioDestination } from './creativeStudios';

import { WorkspaceSearchResults, loadWorkspaceSearchResults, preloadOnIntent } from './workspaceFeatureImports';

const warmResults = () => preloadOnIntent(loadWorkspaceSearchResults);

export type WorkspaceSearchProps = {
  onChoose?: () => void;
  onSkill: (id: string) => void; onScene: (scene: StudioDestination) => void; onStudio: (studio: CreativeStudio) => void;
  onAsset: (id: string, version: string) => void; onCommunity: (community: ExploreCommunity) => void;
  destination: StudioDestination | null; onLibrary: () => void; onAccount: () => void;
};

export function WorkspaceSearch(props: WorkspaceSearchProps) {
  const { t } = useI18n();
  const { onChoose } = props;
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [offset, setOffset] = useState(0);
  return <Popover tooltip={onChoose ? undefined : t('Search workspace')} modal={false} open={open} onOpenChange={setOpen} align="end" aria-label={t('Search workspace')} className="om-selection-panel om-workspace-search"
    trigger={<Button onPointerEnter={warmResults} onFocus={warmResults} variant="plain" className={onChoose ? 'om-nav-item om-workspace-search-trigger' : 'om-nav-item om-workspace-search-trigger om-header-icon'} aria-label={t('Search workspace')}><RemixIcon name="search-line" size={17} />{onChoose && t('Search workspace')}</Button>}>
    {open && <>
      <label className="om-field"><RemixIcon name="search-line" size={16} /><input autoFocus type="search" maxLength={180} value={input} onChange={event => { setInput(event.target.value); setOffset(0); }} placeholder={t('Search workspace')} aria-label={t('Search workspace')} /></label>
      <Suspense fallback={<Skeleton className="om-creative-model-skeleton" />}>
        <WorkspaceSearchResults {...props} query={input.trim().toLocaleLowerCase()} offset={offset} setOffset={setOffset}
          onChoose={() => { setOpen(false); onChoose?.(); }} />
      </Suspense>
    </>}
  </Popover>;
}
