import { Fragment, Suspense, useMemo, type ComponentType } from 'react';
import type { ArtifactKind, SessionArtifact } from '../../../shared/session';
import { EditorLoading, type EditorLoadingLayout } from './EditorLoading';
import { SuspenseOpeningGateMarker, useEditorOpeningGate } from './editorOpeningGate';
import { getMotionProjectEditor } from './MotionProjectEditor';
import { useStudioHost } from './StudioHost';

// Add a viewer adapter here when a mode introduces a new artifact kind.
// The session and browser shell do not own the editor's internal state.
const viewers: Record<ArtifactKind, () => ComponentType<{ resolvedProjectId: string }>> = {
  'motion-project': getMotionProjectEditor,
};

export function ArtifactViewer({ artifact, loadingLayout }: { artifact: SessionArtifact; loadingLayout?: EditorLoadingLayout | null }) {
  const host = useStudioHost();
  const openingGate = useEditorOpeningGate();
  // Preserve the mounted editor when a pending lazy import becomes available.
  const Viewer = useMemo(() => viewers[artifact.kind](), [artifact.kind]);
  const EditorHost = host?.EditorHost ?? Fragment;
  const fallback = openingGate
    ? <SuspenseOpeningGateMarker />
    : <EditorLoading layout={loadingLayout} />;
  return (
    <Suspense fallback={fallback}>
      <div className="motion-project-editor" data-project-id={artifact.projectId}>
        <EditorHost>
          <Viewer resolvedProjectId={artifact.projectId} />
        </EditorHost>
      </div>
    </Suspense>
  );
}
