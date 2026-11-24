import { Fragment, Suspense, useMemo, type ComponentType } from 'react';
import type { ArtifactKind, SessionArtifact } from '../../../shared/session';
import { SuspenseOpeningGateMarker } from './editorOpeningGate';
import { getMotionProjectEditor } from './MotionProjectEditor';
import { useStudioHost } from './StudioHost';

// Add a viewer adapter here when a mode introduces a new artifact kind.
// The session and browser shell do not own the editor's internal state.
const viewers: Record<ArtifactKind, () => ComponentType<{ resolvedProjectId: string }>> = {
  'motion-project': getMotionProjectEditor,
};

export function ArtifactViewer({ artifact }: { artifact: SessionArtifact }) {
  const host = useStudioHost();
  // Preserve the mounted editor when a pending lazy import becomes available.
  const Viewer = useMemo(() => viewers[artifact.kind](), [artifact.kind]);
  const EditorHost = host?.EditorHost ?? Fragment;
  return (
    <Suspense fallback={<SuspenseOpeningGateMarker />}>
      <div className="motion-project-editor" data-project-id={artifact.projectId}>
        <EditorHost>
          <Viewer resolvedProjectId={artifact.projectId} />
        </EditorHost>
      </div>
    </Suspense>
  );
}
