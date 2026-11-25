import { createStyleDrafts, findBlockColorRule } from '../../../../shared/preview-style-draft';
import { createPreviewAdapter } from '../../player/lib/previewAdapter';
import { confirmedSource } from '../../utils/confirmedTextSources';
import { compositionPathOfPreviewUrl } from '../../utils/projectCompositionPath';

const showStyleDraft = createStyleDrafts();

export function previewBlockColor(frame: HTMLIFrameElement | null | undefined, sourceFile: string, key: string, value: string) {
  if (!frame) return;
  const adapter = createPreviewAdapter({ iframe: frame });
  const doc = adapter.document();
  if (doc) {
    const style = findBlockColorRule(doc, sourceFile, key, value, compositionPathOfPreviewUrl(doc.URL));
    return style && showStyleDraft(style, key, value);
  }
  const fileVersion = adapter.projectId && confirmedSource(adapter.projectId, sourceFile)?.version;
  if (!fileVersion) return;
  const editId = crypto.randomUUID();
  adapter.send('inspector-styles', { phase: 'show', editId, sourceFile, fileVersion, blockColor: { key, value } });
  return (saved: boolean) => adapter.send('inspector-styles', { phase: 'settle', editId, saved });
}
