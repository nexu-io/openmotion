import { useEffect, useSyncExternalStore } from 'react';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { Tooltip } from '../components/ui/Tooltip';
import { initializeWorkspaceHistory, traverseWorkspaceHistory, workspaceHistoryAvailability, WORKSPACE_LOCATION_CHANGED } from '../utils/workspaceHistory';

function subscribe(listener: () => void) {
  window.addEventListener(WORKSPACE_LOCATION_CHANGED, listener);
  window.addEventListener('popstate', listener);
  return () => {
    window.removeEventListener(WORKSPACE_LOCATION_CHANGED, listener);
    window.removeEventListener('popstate', listener);
  };
}

/** Shared by the shell and modal pages, which make the shell itself inert. */
export function WorkspaceHistoryNavigation({ tooltips = true }: { tooltips?: boolean } = {}) {
  const { t } = useI18n();
  useEffect(initializeWorkspaceHistory, []);
  const available = useSyncExternalStore(subscribe, workspaceHistoryAvailability);
  const back = <button type="button" className="om-nav-item" aria-label={t('Back')} disabled={!(available & 1)} onClick={() => traverseWorkspaceHistory(-1)}><RemixIcon name="arrow-left-line" size={18} /></button>;
  const forward = <button type="button" className="om-nav-item" aria-label={t('Forward')} disabled={!(available & 2)} onClick={() => traverseWorkspaceHistory(1)}><RemixIcon name="arrow-right-line" size={18} /></button>;
  return <nav className="om-history-navigation" aria-label={t('Page navigation')}>
    {tooltips ? <Tooltip label={t('Back')} withinDialog>{back}</Tooltip> : back}
    {tooltips ? <Tooltip label={t('Forward')} withinDialog>{forward}</Tooltip> : forward}
  </nav>;
}
