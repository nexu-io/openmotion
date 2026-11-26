import { useEffect, useState } from 'react';
import { useDockLayoutStore } from '../components/dock/dockLayoutStore';
import { PANEL_DEFINITIONS } from '../components/dock/panelRegistry';
import { useOptionalWorkspaceChrome } from './WorkspaceChromeContext';

/** Hidden dock tabs retain editing state without doing background discovery. */
export function useCaptionSurfaceActive(panel: 'transcript' | 'captions' | 'timeline') {
  const zone = PANEL_DEFINITIONS[panel].zone;
  const visible = useDockLayoutStore(
    state => state.visiblePanels.has(panel) && !(state.collapsedZones?.includes(zone) ?? false),
  );
  const chrome = useOptionalWorkspaceChrome();
  const [foreground, setForeground] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const update = () => setForeground(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible && foreground && !chrome?.settingsOpen && !chrome?.assetsOpen && !chrome?.skillsOpen;
}
