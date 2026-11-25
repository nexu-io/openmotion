import { useCallback, useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { useDomEditActionsContext } from "../../contexts/DomEditContext";
import { createPreviewAdapter, onPreviewDocumentLeft, type PreviewAdapter } from "../../player/lib/previewAdapter";
import { isolatedPreviewOrigin } from "../../player/lib/previewLease";
import { SCENE_GESTURE_REPLY_MS } from "../../player/sceneSwap";
import { useLivePreviewIframe } from "../../player/store/previewIframeStore";
import { useStudioShellContext } from "../../contexts/StudioContext";
import { inlineTextBatches, isInlineTextTarget, type InlineTextTarget } from "./isolatedInlineTextPatch";
import { beginStudioManualEditGesture, endStudioManualEditGesture, countStudioManualEditSave } from "./manualEditsDom";

interface TextSession {
  id: string;
  adapter: PreviewAdapter;
  target?: InlineTextTarget;
  hold?: string;
}

function isCurrentFrame(session: TextSession, frame: HTMLIFrameElement | null) {
  return frame === session.adapter.iframe && createPreviewAdapter({ iframe: frame }).token === session.adapter.token;
}

export function useIsolatedInlineText(
  preview: RefObject<HTMLIFrameElement | null>, projectId: string | null, enabled: boolean,
) {
  const { commitDomEditPatchBatches } = useDomEditActionsContext();
  const { showToast } = useStudioShellContext();
  const liveFrame = useLivePreviewIframe();
  const active = useRef<TextSession | null>(null);
  const [editing, setEditing] = useState(false);

  const close = useCallback((session: TextSession, committed: boolean) => {
    session.adapter.send("inline-text", { phase: committed ? "commit" : "cancel", editId: session.id });
    if (session.hold) endStudioManualEditGesture(session.adapter.iframe, session.hold);
    if (active.current === session) {
      active.current = null;
      setEditing(false);
    }
  }, []);
  useEffect(() => {
    const cancel = () => { if (active.current) close(active.current, false); };
    const frame = preview.current;
    const stop = frame && onPreviewDocumentLeft(frame, cancel);
    return () => { stop?.(); cancel(); };
  }, [close, enabled, projectId, liveFrame, preview]);

  useEffect(() => {
    function finish(event: MessageEvent) {
      const session = active.current;
      if (!enabled || !projectId || !session?.target || !isCurrentFrame(session, preview.current) ||
          !session.adapter.accepts(event) || event.data.type !== "inline-text-finished" ||
          event.data.editId !== session.id || typeof event.data.html !== "string") return;
      const target = session.target;
      // Consume this user-opened session once. Only the new text comes from the closing message.
      session.target = undefined;
      if (!event.data.changed) { close(session, true); return; }
      void countStudioManualEditSave(session.adapter.iframe, async () => {
        const batches = await inlineTextBatches(projectId, target, event.data.html, event.data.text);
        if (active.current !== session || !isCurrentFrame(session, preview.current)) return;
        const result = await commitDomEditPatchBatches(batches, { label: "Edit text", coalesceKey: session.id });
        close(session, result.durable);
      }).catch(error => {
        if (active.current !== session) return;
        showToast(error instanceof Error ? error.message : "Could not save text", "error");
        close(session, false);
      });
    }
    window.addEventListener("message", finish);
    return () => window.removeEventListener("message", finish);
  }, [close, commitDomEditPatchBatches, enabled, preview, projectId, showToast]);

  async function open(event: MouseEvent) {
    const iframe = preview.current;
    if (!enabled || !iframe || active.current) return;
    const adapter = createPreviewAdapter({ iframe });
    if (!adapter.token || adapter.projectId !== projectId || adapter.targetOrigin !== isolatedPreviewOrigin()) return;
    const frame = iframe.getBoundingClientRect();
    const x = (event.clientX - frame.left) / frame.width, y = (event.clientY - frame.top) / frame.height;
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return;
    const session: TextSession = { adapter, id: crypto.randomUUID() };
    active.current = session;
    try {
      const target = await adapter.request<InlineTextTarget | null>("inline-text", { phase: "pick", editId: session.id, x, y }, SCENE_GESTURE_REPLY_MS);
      if (active.current !== session || !isCurrentFrame(session, preview.current) || !isInlineTextTarget(target)) {
        close(session, false); return;
      }
      session.target = target;
      session.hold = beginStudioManualEditGesture(iframe, "edit");
      setEditing(true);
      adapter.send("inline-text", { phase: "open", editId: session.id });
    } catch { close(session, false); }
  }
  return { editing, open };
}
