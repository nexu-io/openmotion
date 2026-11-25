import { useEffect, useRef } from 'react';
import { useStudioShellContext } from '../contexts/StudioContext';
import { useI18n } from '../i18n/I18n';
import { useCaptionWorkspace } from './captionWorkspace';
import { editStudioCaptions, type StudioCaptionEdit } from './studioCaptionEdits';

export function useNativeCaptionWrite() {
  const shell = useStudioShellContext(), { t } = useI18n();
  const latest = useRef(shell), mounted = useRef(true);
  latest.current = shell;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const disabled = Boolean(shell.writeBlockedReason) || shell.renderQueue.isRendering;
  async function write(input: StudioCaptionEdit) {
    if (disabled) return false;
    const { projectId } = shell, compositionPath = shell.activeCompPath || 'index.html';
    const current = () => mounted.current && latest.current.projectId === projectId && (latest.current.activeCompPath || 'index.html') === compositionPath;
    try {
      await editStudioCaptions(shell, input, trackId => {
        if (!current()) return;
        useCaptionWorkspace.getState().open(projectId, { compositionPath, mode: 'style', trackId, selectClip: true });
        shell.showToast(t(input.textKind === 'text' ? 'Text added to the timeline' : 'Captions added to the video'), 'info');
      });
      return current();
    } catch (error) {
      if (current()) shell.showToast(t(error instanceof Error ? error.message : 'Caption update failed'), 'error');
      return false;
    }
  }
  return { write, disabled };
}
