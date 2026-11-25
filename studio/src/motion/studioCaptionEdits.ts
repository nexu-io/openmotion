import type { CaptionSourceCommand, CaptionSourceOptions } from '../../../packages/edit-core/captions';
import type { StudioShellValue } from '../contexts/StudioContext';
import type { RemoteFileRead } from '../hooks/remoteFileReads';
import { projectedTimelineText } from '../utils/orderedTimelineEdits';
import { readStudioEditSource } from '../utils/studioTextEdits';
import { editPanelComposition } from './compositionPanelEdits';
import { useCaptionWorkspace } from './captionWorkspace';

export type StudioCaptionEdit = CaptionSourceOptions & { command: CaptionSourceCommand; transcriptId?: string };

let operations: ReturnType<typeof loadOperations> | undefined;
function loadOperations() {
  return Promise.all([
    import('../../../packages/edit-core/captions'), import('@hyperframes/parsers/html-attribute-spans'), import('htmlparser2'),
  ]).then(([core, parser, dom]) => core.createCaptionSourceOperations(parser, dom.parseDocument));
}
function captionOperations() {
  return operations ??= loadOperations().catch(error => { operations = undefined; throw error; });
}

export async function readStudioCaptionTracks(project: string, path: string, remote?: RemoteFileRead) {
  const [ops, html] = await Promise.all([
    captionOperations(), projectedTimelineText(project, path) ?? (remote?.(project, path) ?? readStudioEditSource(project, path)).then(file => file.content ?? ''),
  ]);
  return ops.captionTracks(html);
}

export function editStudioCaptions(shell: StudioShellValue, edit: StudioCaptionEdit, onProjected?: (id: string) => void) {
  // Re-preparing a queued add must refer to the same track shown to the user.
  const id = edit.transcriptId ?? crypto.randomUUID();
  const label = edit.command === 'caption_add' ? edit.textKind === 'text' ? 'Add text' : 'Add captions'
    : edit.remove ? 'Remove caption track' : 'Update captions';
  return editPanelComposition(shell, label, async html =>
    (await captionOperations()).editCaptionSource(html, edit.command, id, edit).content, () => {
    useCaptionWorkspace.getState().changed();
    onProjected?.(id);
  }).catch(error => {
    useCaptionWorkspace.getState().changed();
    throw error;
  });
}
