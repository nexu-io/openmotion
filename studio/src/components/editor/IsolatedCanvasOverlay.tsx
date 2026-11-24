import { IsolatedCanvasContextMenu, type CanvasMenuPick } from "./IsolatedCanvasContextMenu";
import { useIsolatedInlineText } from "./useIsolatedInlineText";
import { isIsolatedSourceTarget, isolatedPatchTarget, isolatedSourceVersion, type IsolatedSourceTarget } from "./isolatedSourceTarget";
import { usePreviewOverlayContext } from "./PreviewOverlayProvider";
import { relativeLayerBounds, type LayerBounds } from "./isolatedLayerBounds";
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { useDomEditActionsContext, useDomEditSelectionContext } from "../../contexts/DomEditContext";
import { useStudioShellContext } from "../../contexts/StudioContext";
import { useI18n } from "../../i18n/I18n";
import { createPreviewAdapter, type PreviewAdapter } from "../../player/lib/previewAdapter";
import { projectPreviewAdapter } from "../../player/lib/projectPreviewAdapter";
import { onPreviewPromoted } from "../../player/sceneSwap";
import { usePlayerStore } from "../../player/store/playerStore";
import { canvasBoxOperations, type CanvasBox, type MeasuredCanvasPosition } from "../../../../packages/edit-core/canvas-box";
import { useCanvasClipVisibility } from "./useCanvasClipVisibility";
import { beginStudioManualEditGesture, endStudioManualEditGesture } from "./manualEditsDom";
import { supportsOrderedTextEdits, supportsProjectTextEdits } from "../../utils/confirmedTextSources";
import { watchCanvasTarget } from "./remoteCanvasTargets";
import { saveCanvasDrag } from "./saveCanvasDrag";

interface Drag {
  pointer: number;
  gestureId: string;
  batchWrites: boolean;
  optimistic: boolean;
  hold?: string;
  unwatch?: () => void;
  adapter: PreviewAdapter;
  startX: number;
  startY: number;
  frame: DOMRect;
  pickSettled: boolean;
  finishSettled: boolean;
  waitingForSource?: boolean;
  corner?: Corner;
  liveResizeBounds?: boolean;
  bounds?: LayerBounds;
  offset?: { x: number; y: number };
}

type Corner = "nw" | "ne" | "sw" | "se";
const corners: Corner[] = ["nw", "ne", "sw", "se"];

interface DragResult extends IsolatedSourceTarget {
  predecessor?: string;
  left: number;
  top: number;
  makeRelative: boolean;
  position?: MeasuredCanvasPosition;
  corner?: Corner;
  width?: number;
  height?: number;
  extraAxes?: CanvasBox["extraAxes"];
  geometry?: LayerBounds;
  viewport?: { width: number; height: number };
}

interface Pick { target?: IsolatedSourceTarget; geometry: LayerBounds; viewport: { width: number; height: number }; liveResizeBounds?: boolean }

function validResult(result: DragResult | null): result is DragResult {
  return isIsolatedSourceTarget(result) && Number.isFinite(result.left) && Number.isFinite(result.top);
}

function positionPatch(result: DragResult) {
  const { sourceFile, ifMatch, target } = isolatedPatchTarget(result);
  const {left, top, width, height, makeRelative, corner, extraAxes} = result;
  const box = {left, top, width, height, makeRelative, corner, ...(extraAxes && {extraAxes})};
  return { sourceFile, ifMatch, patches: [{ target, operations:canvasBoxOperations(box) }], box, ...(result.position && {position:result.position}) };
}

/** Input and persistence stay in Studio. The scoped frame only measures and previews layout. */
export function IsolatedCanvasOverlay() {
  const { t } = useI18n();
  const { commitDomEditPatchBatches, clearDomSelection } = useDomEditActionsContext();
  const { previewIframeRef, projectId, showToast, writeBlockedReason } = useStudioShellContext();
  const select = usePlayerStore(state => state.activeTool === "select");
  const text = useIsolatedInlineText(previewIframeRef, projectId, select && !writeBlockedReason);
  const drag = useRef<Drag | null>(null);
  const lastPick = useRef<Drag | null>(null);
  const [menu, setMenu] = useState<CanvasMenuPick | null>(null);
  const { domEditSelection } = useDomEditSelectionContext();
  const inFrame = useCanvasClipVisibility(domEditSelection);
  const [draft, setDraft] = useState<{ frame: HTMLIFrameElement; bounds: LayerBounds } | null>(null);
  const box = draft && draft.frame === previewIframeRef.current ? draft.bounds : domEditSelection?.isolatedBounds;
  const { state: { compositionRect } } = usePreviewOverlayContext();
  useEffect(() => {
    function resizeBounds(event: MessageEvent) {
      const active = drag.current;
      if (!active?.corner || event.data?.type !== "canvas-drag" || event.data.phase !== "bounds" ||
          event.data.gestureId !== active.gestureId || !active.adapter.accepts(event)) return;
      const bounds = relativeLayerBounds(event.data);
      if (bounds) setDraft({ frame: active.adapter.iframe, bounds });
    }
    window.addEventListener("message", resizeBounds);
    return () => window.removeEventListener("message", resizeBounds);
  }, []);
  useEffect(() => {
    if (!lastPick.current) setDraft(null);
  }, [domEditSelection]);

  const session = useRef(0);
  const frameLoad = useRef(0);
  const reportUnapplied = useCallback(() => showToast(t("This canvas edit was not saved. Try again when the preview is ready."), "error"), [showToast, t]);
  const observedFrame = useRef<HTMLIFrameElement | null>(null);
  const cancel = useCallback(() => {
    const active = drag.current;
    active?.unwatch?.();
    active?.adapter.send("canvas-drag", { phase: "cancel", gestureId: active.gestureId });
    if (active?.hold) endStudioManualEditGesture(active.adapter.iframe, active.hold);
    drag.current = null;
    setMenu(null);
    lastPick.current = null;
    setDraft(null);
  }, []);

  const notifyUnapplied = useRef(reportUnapplied);
  notifyUnapplied.current = reportUnapplied;
  const handleFrameLoad = useCallback(() => {
    frameLoad.current++;
    if (drag.current?.offset) notifyUnapplied.current();
    cancel();
  }, [cancel]);

  useEffect(() => {
    const releaseRetired = ({ retired }: { retired: HTMLIFrameElement | null }) => {
      if (!retired) return;
      if (observedFrame.current === retired) {
        retired.removeEventListener("load", handleFrameLoad);
        observedFrame.current = null;
      }
      if (lastPick.current?.adapter.iframe === retired) {
        lastPick.current = null;
      }
      setMenu((current) => (current?.adapter.iframe === retired ? null : current));
    };
    const stopPromoted = onPreviewPromoted(document, releaseRetired);
    return () => {
      session.current++;
      stopPromoted();
      observedFrame.current?.removeEventListener("load", handleFrameLoad);
      observedFrame.current = null;
      cancel();
    };
  }, [projectId, select, writeBlockedReason, cancel, handleFrameLoad]);

  function showBounds(active: Drag) {
    if (!active.bounds) return;
    const x = (active.offset?.x ?? 0) / active.frame.width;
    const y = (active.offset?.y ?? 0) / active.frame.height;
    const rect = active.bounds, corner = active.corner;
    const west = corner?.endsWith("w"), north = corner?.startsWith("n");
    setDraft({ frame: active.adapter.iframe, bounds: { x: rect.x + (corner && !west ? 0 : x), y: rect.y + (corner && !north ? 0 : y),
      width: Math.max(1 / active.frame.width, rect.width + (corner ? west ? -x : x : 0)),
      height: Math.max(1 / active.frame.height, rect.height + (corner ? north ? -y : y : 0)) } });
  }

  function begin(event: PointerEvent<HTMLDivElement>) {
    const iframe = previewIframeRef.current;
    if (!iframe || drag.current || event.button !== 0 || !event.isPrimary) return;
    const adapter = projectPreviewAdapter(iframe, projectId);
    if (!adapter) return;
    const frame = iframe.getBoundingClientRect();
    if (!frame.width || !frame.height) return;
    const { clientX: startX, clientY: startY } = event;
    const insideFrame = startX >= frame.left && startX <= frame.right && startY >= frame.top && startY <= frame.bottom;
    const hit = event.target as HTMLElement;
    const handle = hit.closest<HTMLElement>("[data-resize-corner]");
    const corner = handle?.dataset.resizeCorner as Corner | undefined;
    const target = (corner || !insideFrame) ? domEditSelection?.isolatedTarget : undefined;
    if (!insideFrame && (writeBlockedReason || !target || !hit.closest("[data-isolated-selection]"))) return;
    // The whole handle is clickable, even where it straddles the frame edge.
    const x = corner && box ? box.x + (corner.endsWith("e") ? box.width : 0) : (startX - frame.left) / frame.width;
    const y = corner && box ? box.y + (corner.startsWith("s") ? box.height : 0) : (startY - frame.top) / frame.height;
    if (writeBlockedReason) {
      adapter.send("layer-select", { x, y });
      return;
    }
    if (observedFrame.current !== iframe) {
      observedFrame.current?.removeEventListener("load", handleFrameLoad);
      observedFrame.current = iframe;
      iframe.addEventListener("load", handleFrameLoad);
    }
    const batchWrites = !!projectId && supportsOrderedTextEdits(projectId);
    const active: Drag = {
      corner,
      pointer: event.pointerId,
      gestureId: crypto.randomUUID(),
      batchWrites,
      // Single-edit servers can render every gesture locally too. Only their writes need a receipt chain.
      optimistic: batchWrites || (!!projectId && supportsProjectTextEdits(projectId)),
      adapter,
      frame,
      startX,
      startY,
      pickSettled: false,
      finishSettled: false,
    };
    if (active.optimistic) active.hold = beginStudioManualEditGesture(iframe, corner ? "resize" : "move");
    drag.current = lastPick.current = active;
    // Keep the last visible bounds until the new hit has been measured.
    event.currentTarget.setPointerCapture(event.pointerId);
    void adapter.request<Pick | { waitingForSource: true } | null>("canvas-drag", { phase: "start", gestureId: active.gestureId, x, y, corner, ...(event.shiftKey && { additive: true }), ...(active.optimistic && { ordered: true }),
      ...(target && { target: { sourceFile: target.sourceFile, elementId: target.elementId, hfId: target.hfId } }) })
      .then(pick => {
        if (lastPick.current !== active || !pick) return;
        if ("waitingForSource" in pick) { active.waitingForSource = true; return; }
        if (active.optimistic && !active.finishSettled && pick.target && isIsolatedSourceTarget(pick.target)) {
          active.unwatch = watchCanvasTarget(iframe, pick.target, () => {
            active.unwatch?.();
            if (previewIframeRef.current !== iframe) return;
            const wasDragging = drag.current === active;
            active.adapter.send("canvas-drag", { phase: "removed", gestureId: active.gestureId });
            if (active.hold) endStudioManualEditGesture(iframe, active.hold);
            if (wasDragging) drag.current = null;
            if (lastPick.current === active) {
              lastPick.current = null;
              setDraft(null);
              clearDomSelection();
              // An already-submitted gesture receives its conflict message from the save coordinator.
              if (wasDragging) showToast(t("The project changed elsewhere. Changes were not saved."), "error");
            }
          });
        }
        const bounds = relativeLayerBounds(pick);
        if (!bounds) return;
        active.bounds = bounds;
        active.liveResizeBounds = pick.liveResizeBounds;
        if (!active.liveResizeBounds) showBounds(active);
      }).catch(() => { if (drag.current === active) setDraft(null); })
      .finally(() => {
        active.pickSettled = true;
        if (active.finishSettled && lastPick.current === active) {
          lastPick.current = null;
        }
      });
  }

  function update(event: PointerEvent<HTMLDivElement>, phase: "move" | "finish" | "cancel") {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    const dx = event.clientX - active.startX, dy = event.clientY - active.startY;
    const payload = { phase, dx: dx / active.frame.width, dy: dy / active.frame.height, gestureId: active.gestureId };
    if (phase !== "cancel" && (active.offset || Math.hypot(dx, dy) >= 3)) {
      active.offset = { x: dx, y: dy };
      if (!active.liveResizeBounds) showBounds(active);
    }
    if (phase === "move") {
      if (active.offset) active.adapter.send("canvas-drag", payload);
      return;
    }
    if (phase === "cancel" || !active.offset) {
      active.unwatch?.();
      active.finishSettled = true;
      if (phase === "cancel") { setDraft(null); lastPick.current = null; }
      else if (active.pickSettled && lastPick.current === active) { lastPick.current = null; }
      active.adapter.send("canvas-drag", { ...payload, phase: "cancel" });
      if (active.hold) endStudioManualEditGesture(active.adapter.iframe, active.hold);
      drag.current = null;
      return;
    }
    // postMessage preserves finish/start ordering. Free the pointer here even
    // when the previous frame measurement or its source write is still in flight.
    drag.current = null;
    let committed = false;
    let changed = false;
    const gestureSession = session.current;
    const issuedAtLoad = frameLoad.current;
    const wholePath = event.altKey || !usePlayerStore.getState().autoKeyframeEnabled;
    void active.adapter.request<DragResult | null>("canvas-drag", { ...payload, wholePath }).then(async result => {
      if (gestureSession !== session.current) return;
      if (frameLoad.current !== issuedAtLoad || previewIframeRef.current !== active.adapter.iframe || createPreviewAdapter({ iframe: active.adapter.iframe }).token !== active.adapter.token) {
        reportUnapplied();
        return;
      }
      if (!validResult(result) || result.corner !== active.corner || (active.corner &&
        !(Number.isFinite(result.width) && Number.isFinite(result.height) && result.width! > 0 && result.height! > 0))) {
        if (active.waitingForSource || active.bounds || result) reportUnapplied();
        return;
      }
      const frame = active.adapter.iframe;
      const finalBounds = active.corner && relativeLayerBounds(result);
      if (lastPick.current === active && finalBounds) setDraft({ frame, bounds: finalBounds });
      const write = async (version?: string) => {
        const patch = positionPatch(result);
        // The authenticated measurement is complete. A preview swap while a prior
        // write settles cannot invalidate its target and conditional source version.
        if (gestureSession !== session.current) return;
        if (version) patch.ifMatch = version;
        return commitDomEditPatchBatches([patch], { label: active.corner ? "Resize layer" : "Move layer", coalesceKey: active.gestureId });
      };
      const saved = active.batchWrites ? await write()
        : await saveCanvasDrag(frame, result.sourceFile, active.gestureId, result.predecessor, write, active.optimistic ? isolatedSourceVersion(result) : undefined);
      if (!saved && gestureSession === session.current) reportUnapplied();
      committed = saved?.durable === true;
      changed = saved?.changed === true;
    }, () => { if (gestureSession === session.current) showToast(t("Preview unavailable"), "error"); }).catch(() => {
      // The shared save queue reports the error and reloads the authoritative preview.
    }).finally(() => {
      active.unwatch?.();
      active.finishSettled = true;
      if (active.hold) endStudioManualEditGesture(active.adapter.iframe, active.hold);
      active.adapter.send("canvas-drag", { phase: committed ? "commit" : "cancel", changed, gestureId: active.gestureId });
      if (drag.current === active) drag.current = null;
      if (lastPick.current === active) {
        if (!committed) {
          lastPick.current = null;
          setDraft(null);
        } else if (active.pickSettled) {
          lastPick.current = null;
        }
      }
    });
  }

  function lostCapture(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    const { currentTarget, clientX, clientY } = event;
    // Chromium may drop capture on the first move with the primary button still down.
    // Continue this gesture only while the pointer is still over its own overlay.
    if ((event.buttons & 1) && currentTarget.contains(document.elementFromPoint(clientX, clientY))) {
      try {
        currentTarget.setPointerCapture(event.pointerId);
        return;
      } catch {
        // The pointer was already released or the overlay detached.
      }
    }
    update(event, "cancel");
  }

  if (!select) return null;
  return <div className="absolute inset-0 z-10 touch-none pointer-events-auto" aria-label={t("Composition canvas")}
    style={text.editing ? { pointerEvents: "none" } : undefined} onDoubleClick={text.open}
    onContextMenu={event => {
      event.preventDefault();
      const iframe = previewIframeRef.current;
      if (!iframe || !projectId || writeBlockedReason) return;
      const adapter = projectPreviewAdapter(iframe, projectId);
      if (!adapter) return;
      const frame = iframe.getBoundingClientRect();
      setMenu({ adapter, x: (event.clientX - frame.x) / frame.width, y: (event.clientY - frame.y) / frame.height,
        screenX: event.clientX, screenY: event.clientY });
    }}
    onPointerDown={begin} onPointerMove={event => update(event, "move")}
    onPointerUp={event => update(event, "finish")} onPointerCancel={event => update(event, "cancel")}
    onLostPointerCapture={lostCapture}>
    {menu && <IsolatedCanvasContextMenu pick={menu} close={() => setMenu(null)} />}
    {inFrame && box && compositionRect.width > 0 && compositionRect.height > 0 && <div data-isolated-selection="" className="absolute border border-studio-accent"
      style={{ left: compositionRect.left + box.x * compositionRect.width,
        top: compositionRect.top + box.y * compositionRect.height,
        width: box.width * compositionRect.width, height: box.height * compositionRect.height }}>
      {!writeBlockedReason && corners.map(corner => <span key={corner} data-resize-corner={corner} aria-label={t("Resize layer")}
        className="absolute size-2 rounded-sm border border-studio-accent bg-white pointer-events-auto"
        style={{ left: corner.endsWith("w") ? 0 : "100%", top: corner.startsWith("n") ? 0 : "100%",
          transform: "translate(-50%, -50%)", cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize" }} />)}
    </div>}
  </div>;
}
