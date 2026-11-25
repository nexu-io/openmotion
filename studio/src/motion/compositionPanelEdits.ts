import type { StudioShellValue } from '../contexts/StudioContext';
import { projectPendingStructure } from '../player/lib/peerTimeline';
import { scheduleCommittedTimelinePreview } from '../player/committedTimelinePreview';
import { supportsOrderedTextEdits } from '../utils/confirmedTextSources';
import { serializeStudioFileMutation } from '../utils/studioFileMutationCoordinator';
import { readProjectFileContent, writeProjectFilesWithHistoryInQueue } from '../utils/studioFileHistory';
import { saveOrderedTimeline } from '../utils/orderedTimelineEdits';

type PanelTarget = Pick<StudioShellValue, 'projectId' | 'activeCompPath' | 'previewIframeRef' | 'writeProjectFile' | 'recordEdit' | 'reloadPreview'>;

/** A panel edit projects from the same local file as a timeline gesture and joins its FIFO immediately. */
export function editPanelComposition(shell: PanelTarget, label: string,
  apply: (html: string) => string | Promise<string>, projected?: () => void) {
  const { projectId, recordEdit, reloadPreview, previewIframeRef } = shell;
  const path = shell.activeCompPath || 'index.html';
  const frame = previewIframeRef.current;
  if (!supportsOrderedTextEdits(projectId)) {
    // Standalone Studio's native file server offers conditional file writes and local history.
    return serializeStudioFileMutation(shell.writeProjectFile, path, async () => {
      const before = await readProjectFileContent(projectId, path);
      const after = await apply(before);
      return writeProjectFilesWithHistoryInQueue({
        projectId, label, files: { [path]: () => after }, readFile: async () => before,
        writeFile: shell.writeProjectFile, recordEdit,
        projectPending: files => projectPendingStructure(projectId, path, frame, files),
        onSaved: async () => {
          projected?.();
          if (frame?.isConnected && previewIframeRef.current === frame) reloadPreview([path]);
        },
      });
    });
  }
  return saveOrderedTimeline(projectId, [{ path, apply }], label, {
    recordEdit,
    projectPending(files) {
      const rollback = projectPendingStructure(projectId, path, frame, files);
      projected?.();
      return rollback;
    },
    async onSaved(files, previous, bases) {
      if (frame?.isConnected && previewIframeRef.current === frame) {
        scheduleCommittedTimelinePreview(frame, projectId, path, files, previous, reloadPreview, bases);
      }
    },
  });
}
