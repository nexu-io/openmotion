import { projectPreviewAdapter } from "../../player/lib/projectPreviewAdapter";
import { useEffect, useState } from "react";
import { useDomEditActionsContext } from "../../contexts/DomEditContext";
import { useStudioShellContext } from "../../contexts/StudioContext";
import type { PreviewAdapter } from "../../player/lib/previewAdapter";
import { useLayerReorderTimelineMirror } from "../nle/useCanvasZOrderTimelineMirror";
import { runZLaneGesture } from "../nle/zLaneGesture";
import { CanvasContextMenu } from "./CanvasContextMenu";
import type { ZOrderAction } from "./canvasContextMenuZOrder";
import type { DomEditSelection } from "./domEditingTypes";
import { inspectIsolatedElement } from "./isolatedInspector";
import { isLayerFamily, planIsolatedLayerReorder, type FamilyEntry } from "./isolatedLayerReorder";

export interface CanvasMenuPick { adapter: PreviewAdapter; x: number; y: number; screenX: number; screenY: number }

export function IsolatedCanvasContextMenu({ pick, close }: { pick: CanvasMenuPick; close: () => void }) {
  const { previewIframeRef, projectId, writeBlockedReason, showToast, activeCompPath } = useStudioShellContext();
  const { commitDomEditPatchBatches, handleDomEditElementDelete } = useDomEditActionsContext();
  const isMasterView = !activeCompPath || activeCompPath === "index.html";
  const mirror = useLayerReorderTimelineMirror();
  const [snapshot, setSnapshot] = useState<{ family: FamilyEntry[]; selection: DomEditSelection } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setSnapshot(null);
      const family = await pick.adapter.request("layer-family", { x: pick.x, y: pick.y });
      if (cancelled || !isLayerFamily(family)) return;
      const target = family.find(el => el.selected);
      const selection = target && await inspectIsolatedElement(pick.adapter, target, isMasterView);
      if (!cancelled && selection) setSnapshot({ family, selection });
    };
    void load().catch(() => {});
    return () => { cancelled = true; };
  }, [pick, isMasterView]);
  const stillCurrent = () => {
    const frame = previewIframeRef.current;
    return !writeBlockedReason && frame === pick.adapter.iframe && projectPreviewAdapter(frame, projectId)?.token === pick.adapter.token;
  };
  if (!snapshot || !stillCurrent()) return null;
  const { family, selection } = snapshot;
  const actions: Partial<Record<ZOrderAction, () => void>> = {};
  for (const action of ["bring-to-front", "send-to-back", "bring-forward", "send-backward"] as const) {
    const step = action === "bring-forward" || action === "send-backward";
    const topFirst = family.filter(e => !step || e.selected || e.stepCandidate)
      .sort((a,b) => b.zIndex - a.zIndex || b.domIndex - a.domIndex);
    const from = topFirst.findIndex(e => e.selected);
    const to = action === "bring-to-front" ? 0 : action === "send-to-back" ? topFirst.length - 1 :
      from + (action === "bring-forward" ? -1 : 1);
    if (from < 0 || to < 0 || to >= topFirst.length || from === to) continue;
    const plan = planIsolatedLayerReorder(family, topFirst.map(e => e.element), from, to);
    if (!plan) continue;
    actions[action] = () => {
      const coalesceKey = "canvas-z:" + crypto.randomUUID();
      void runZLaneGesture({
        commitZ: linkedLanes => stillCurrent() ? commitDomEditPatchBatches(plan.batches, { label: "Reorder layers", coalesceKey, ...(linkedLanes && { linkedLanes }) }) :
          Promise.resolve({ durable: false, changed: false, allMatched: false }),
        mirror: commitTogether => mirror({ selectionKey: plan.selectionKey, desiredOrderKeys: plan.desiredOrderKeys, coalesceKey }, commitTogether),
      }).catch(() => showToast("Could not reorder layers", "error"));
    };
  }
  return <CanvasContextMenu x={pick.screenX} y={pick.screenY} selection={selection} onClose={close}
    isolatedZActions={actions} onDelete={sel => { close(); if (stillCurrent()) void handleDomEditElementDelete(sel); }} />;
}
