import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptionTrack } from '../../../shared/transcript-captions';
import type { CaptionSettings } from '../../../shared/caption-style';
import { useStudioShellContext } from '../contexts/StudioContext';
import { addExternalFileReloadListener } from '../hooks/externalFileReloadBus';
import type { RemoteFileRead } from '../hooks/remoteFileReads';
import { useI18n } from '../i18n/I18n';
import { editStudioCaptions, readStudioCaptionTracks, type StudioCaptionEdit } from './studioCaptionEdits';
import { useCaptionWorkspace } from './captionWorkspace';

export function useCaptionTracks(visible: boolean, previewRevision?: number) {
  const shell = useStudioShellContext(), { t } = useI18n();
  const projectId = shell.projectId, compositionPath = shell.activeCompPath || 'index.html';
  const epoch = useCaptionWorkspace(s => s.epoch);
  const [tracks, setTracks] = useState<CaptionTrack[]>([]), [loading, setLoading] = useState(true), [failed, setFailed] = useState(false);
  const mounted = useRef(true), sequence = useRef(0), latest = useRef(shell); latest.current = shell;
  const refresh = useCallback(async (read?: RemoteFileRead) => {
    const request = ++sequence.current;
    try {
      const result = await readStudioCaptionTracks(projectId, compositionPath, read);
      if (mounted.current && request === sequence.current) { setTracks(result); setFailed(false); setLoading(false); }
    } catch { if (mounted.current && request === sequence.current) { setFailed(true); setLoading(false); } }
  }, [projectId, compositionPath]);
  useEffect(() => { mounted.current = true; setTracks([]); setLoading(true); return () => { mounted.current = false; sequence.current++; }; }, [refresh]);
  useEffect(() => { if (visible) void refresh(); }, [visible, refresh, epoch, previewRevision]);
  useEffect(() => {
    if (!visible) return;
    return addExternalFileReloadListener((changed, read) => {
      if (changed === compositionPath || changed === '.') void refresh(read);
    });
  }, [visible, refresh, compositionPath]);
  const disabled = Boolean(shell.writeBlockedReason) || shell.renderQueue.isRendering;
  const mutate = async (input: StudioCaptionEdit) => {
    if (disabled) return false;
    const valid = () => mounted.current && latest.current.projectId === projectId && (latest.current.activeCompPath || 'index.html') === compositionPath && !latest.current.writeBlockedReason && !latest.current.renderQueue.isRendering;
    try {
      await editStudioCaptions(shell, input);
      if (valid()) shell.showToast(t(input.remove ? 'Caption track removed' : 'Captions updated'), 'info');
      return true;
    } catch (error) {
      if (valid()) shell.showToast(t(error instanceof Error ? error.message : 'Caption update failed'), 'error');
      return false;
    }
  };
  const change = (id: string, settings?: Partial<CaptionSettings>, remove = false) => mutate({ command: 'caption_update', transcriptId: id, captionSettings: settings, remove });
  const toggle = (visible: boolean) => mutate({ command: 'caption_toggle', visible });
  return { tracks, loading, failed, refresh, change, toggle, disabled };
}
