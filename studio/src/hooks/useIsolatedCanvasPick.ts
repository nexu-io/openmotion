import { useEffect, useRef, type MutableRefObject } from "react";
import { inspectIsolatedElement } from "../components/editor/isolatedInspector";
import type { DomEditSelection } from "../components/editor/domEditing";
import { projectPreviewAdapter } from "../player/lib/projectPreviewAdapter";
import { onPreviewContentReplaced, previewContentGeneration } from "../player/sceneSwap";
import { usePlayerStore } from "../player/store/playerStore";
import type { UseDomSelectionParams } from "./useDomSelectionTypes";

type PickIdentity = Parameters<typeof inspectIsolatedElement>[1];
type Props = Pick<UseDomSelectionParams,
  "projectId" | "activeCompPath" | "isMasterView" | "captionEditMode" | "previewIframe" | "previewIframeRef"
> & {
  selectionSequence: MutableRefObject<number>;
  apply: (selection: DomEditSelection | null, options?: { additive: boolean }) => void;
};

export function useIsolatedCanvasPick({
  projectId, activeCompPath, isMasterView, captionEditMode, previewIframe, previewIframeRef, selectionSequence, apply,
}: Props) {
  const pending = useRef<{ identity: PickIdentity; sequence: number; additive: boolean } | null>(null);
  useEffect(() => { pending.current = null; }, [projectId, activeCompPath, captionEditMode, isMasterView]);

  useEffect(() => {
    if (captionEditMode) return;
    let disposed = false;

    // A hit is still valid while its source version is being saved. Keep the
    // latest click until the same frame can inspect it or the next frame is ready.
    async function resolvePick() {
      const pick = pending.current;
      const frame = previewIframeRef.current;
      if (!pick || pick.sequence !== selectionSequence.current || !frame) return;
      const adapter = projectPreviewAdapter(frame, projectId);
      if (!adapter) return;
      const generation = previewContentGeneration(frame);
      const next = await inspectIsolatedElement(adapter, pick.identity, isMasterView);
      if (disposed || next === undefined || pending.current !== pick || pick.sequence !== selectionSequence.current ||
          frame !== previewIframeRef.current || previewContentGeneration(frame) !== generation) return;
      pending.current = null;
      usePlayerStore.getState().setSelectionOrigin(next ? "canvas" : null);
      if (pick.additive && next) apply(next, { additive: true });
      else apply(next);
    }

    function receive(event: MessageEvent) {
      const message = event.data;
      if (message?.type !== "select-element" && message?.type !== "inspect-element") return;
      if (!projectPreviewAdapter(previewIframeRef.current, projectId)?.accepts(event)) return;
      if (message.type === "inspect-element") {
        if (pending.current && message.sourceReady === pending.current.identity.sourceFile) void resolvePick();
        return;
      }
      if (message.inspect !== true || !message.selection) return;
      const { elementId, hfId, sourceFile } = message.selection;
      pending.current = { identity: { elementId, hfId, sourceFile }, additive: message.additive === true, sequence: ++selectionSequence.current };
      void resolvePick();
    }

    window.addEventListener("message", receive);
    const stop = previewIframe && onPreviewContentReplaced(previewIframe, resolvePick);
    void resolvePick();
    return () => {
      disposed = true;
      stop?.();
      window.removeEventListener("message", receive);
    };
  }, [apply, captionEditMode, isMasterView, projectId, previewIframe, previewIframeRef, selectionSequence]);
}
