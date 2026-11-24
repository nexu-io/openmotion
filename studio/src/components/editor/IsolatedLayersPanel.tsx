import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18n";
import { trackStudioClick } from "../../motion/editorTracking";
import { createPreviewAdapter, type PreviewAdapter } from "../../player/lib/previewAdapter";
import { isolatedPreviewOrigin } from "../../player/lib/previewLease";
import { onPreviewContentReplaced } from "../../player/sceneSwap";
import { PanelEmptyState } from "../ui/PanelEmptyState";
import { useDomEditActionsContext } from "../../contexts/DomEditContext";
import { useStudioShellContext } from "../../contexts/StudioContext";
import { useLayerReorderTimelineMirror } from "../nle/useCanvasZOrderTimelineMirror";
import { runZLaneGesture } from "../nle/zLaneGesture";
import { useLayerDrag, type LayerReorderEvent } from "./useLayerDrag";
import { planIsolatedLayerReorder } from "./isolatedLayerReorder";
import { LayerRow } from "./LayerRow";
import { isPreviewLayerList, type PreviewLayer } from "../../../../shared/preview-layer";
import { getVisibleLayers, sortLayerRows } from "./layersPanelSort";

export function IsolatedLayersPanel({ iframe }: { iframe: HTMLIFrameElement | null }) {
  const { t } = useI18n();
  const [layers, setLayers] = useState<PreviewLayer[] | "loading" | "unavailable">("loading");
  const { commitDomEditPatchBatches } = useDomEditActionsContext();
  const { writeBlockedReason, showToast, projectId } = useStudioShellContext();
  const mirror = useLayerReorderTimelineMirror();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const connection = useRef<{ adapter: PreviewAdapter; subscription: string } | null>(null);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    function subscribe() {
      clearTimeout(timeout);
      setSelected(null);
      setLayers("loading");
      setCollapsed({});
      if (!iframe) return;
      const adapter = createPreviewAdapter({ iframe });
      if (!adapter.token || !adapter.projectId || adapter.targetOrigin !== isolatedPreviewOrigin()) return;
      const subscription = crypto.randomUUID();
      connection.current = { adapter, subscription };
      adapter.send("layer-tree", { subscription });
      timeout = setTimeout(() => setLayers("unavailable"), 3000);
    }
    function receive(event: MessageEvent) {
      const type = event.data?.type;
      if (!iframe || (type !== "layer-tree" && type !== "select-element" && type !== "preview-ready")) return;
      const adapter = createPreviewAdapter({ iframe });
      if (adapter.targetOrigin !== isolatedPreviewOrigin() || !adapter.accepts(event)) return;
      const { subscription, rows, layerKey } = event.data;
      if (type === "preview-ready") { subscribe(); return; }
      if (subscription !== connection.current?.subscription) return;
      if (type === "layer-tree" && isPreviewLayerList(rows)) {
        clearTimeout(timeout);
        setLayers(sortLayerRows(rows, row => row.z));
      }
      if (type === "select-element" && typeof layerKey === "string") setSelected(layerKey);
    }
    window.addEventListener("message", receive);
    const unsubscribe = iframe && onPreviewContentReplaced(iframe, subscribe);
    subscribe();
    return () => {
      clearTimeout(timeout);
      window.removeEventListener("message", receive);
      unsubscribe?.();
      const active = connection.current;
      active?.adapter.send("layer-tree", { close: true, subscription: active.subscription });
      connection.current = null;
    };
  }, [iframe]);

  const visibleLayers = Array.isArray(layers) ? getVisibleLayers(layers, collapsed) : [];
  async function reorder({ siblingLayers, fromIndex, toIndex }: LayerReorderEvent<PreviewLayer>) {
    const active = connection.current;
    if (!active || writeBlockedReason || active.adapter.projectId !== projectId) return;
    const key = siblingLayers[fromIndex].key;
    const family = await active.adapter.request<Parameters<typeof planIsolatedLayerReorder>[0]>("layer-family",
      { key, subscription: active.subscription });
    if (connection.current !== active) return;
    const plan = planIsolatedLayerReorder(family, siblingLayers.map(row => row.key), fromIndex, toIndex);
    if (!plan) return;
    const coalesceKey = "layer-drag:" + crypto.randomUUID();
    await runZLaneGesture({
      commitZ: () => connection.current === active ? commitDomEditPatchBatches(plan.batches,
        { label: "Reorder layers", coalesceKey }) : Promise.resolve({ changed: false, allMatched: false, durable: false }),
      mirror: () => mirror({ selectionKey: plan.selectionKey, desiredOrderKeys: plan.desiredOrderKeys, coalesceKey }),
    });
  }
  const drag = useLayerDrag({ visibleLayers, scrollContainerRef, isDraggable: row => !writeBlockedReason && row.draggable === true,
    onReorder: event => { void reorder(event).catch(() => showToast(t("Could not reorder layers"), "error")); } });

  if (layers === "loading" || layers === "unavailable") return <PanelEmptyState icon="stack-line"
    message={t(layers === "loading" ? "Loading preview…" : "Preview unavailable")} />;
  if (!layers.length) return <PanelEmptyState icon="stack-line" message={t("No layers")} />;
  return <div className="flex h-full min-h-0 flex-col overflow-hidden bg-panel-bg">
    <div ref={scrollContainerRef} className="relative min-h-0 flex-1 select-none overflow-y-auto py-1"
      onPointerMove={drag.handleContainerPointerMove} onPointerUp={drag.handleContainerPointerUp}>
      {visibleLayers.map((layer, index) => <LayerRow key={layer.key}
        label={layer.label} depth={layer.depth} childCount={layer.childCount} kind={layer.kind} isCompHost={layer.isCompHost} index={index} selected={selected === layer.key} isCollapsed={Boolean(collapsed[layer.key])}
        onPointerDown={event => drag.handleRowPointerDown(index, event)} isDragged={drag.dragKey === layer.key} dragging={drag.dragKey !== null}
        onToggle={() => setCollapsed(current => ({ ...current, [layer.key]: !current[layer.key] }))}
        onSelect={(additive) => {
          const active = connection.current;
          if (!active || active.adapter.iframe !== iframe) return;
          active.adapter.send("layer-select", { key: layer.key, subscription: active.subscription, ...(additive && { additive: true }) });
          trackStudioClick("layers", "locate_layer");
        }}
      />)}
      {drag.insertionLineY !== null && <div className="pointer-events-none absolute inset-x-0 h-0.5 bg-studio-accent"
        style={{ top: drag.insertionLineY }} />}
    </div>
  </div>;
}
