import { useCallback, useEffect, useMemo, useRef } from "react";
import type { DomEditSelection } from "../components/editor/domEditingTypes";
import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import type { LintFinding } from "../components/LintModal";
import { liveTime, usePlayerStore } from "../player";
import { buildFrameCaptureUrl } from "../utils/frameCapture";
import { studioApiFetch } from "../utils/studioApiFetch";
import type { EditingFile } from "../utils/studioHelpers";
import { setStudioTheme } from "../utils/studioTheme";
import { liveMarkupWithoutPreviewMarks } from "../utils/authoredSource";
import {
  getSuperAgentMotionEmbedConfig,
  postMotionBridgeMessage,
  SA_MOTION_REQUEST_ATTACH_EVENT,
  type MotionAttachRequestDetail,
  type MotionBridgeParentCommand,
  type MotionDomElementSummary,
  type MotionSelectionSnapshot,
} from "../motion/superAgentMotionBridge";

export interface UseSuperAgentMotionBridgeParams {
  projectId: string | null;
  activeCompPath: string | null;
  compositions: string[];
  editingFile: EditingFile | null;
  domEditSelection: DomEditSelection | null;
  domEditGroupSelections: DomEditSelection[];
  consoleErrors: LintFinding[] | null;
  waitForPendingDomEditSaves: () => Promise<void>;
  onOpenFile: (filePath: string) => void;
  onSelectComposition: (compPath: string) => void;
}

function summarizeDomSelection(sel: DomEditSelection): MotionDomElementSummary {
  const styles: Record<string, string> = {};
  for (const [k, v] of Object.entries(sel.inlineStyles ?? {})) {
    if (v) styles[k] = v;
  }
  const htmlPreview = sel.element ? liveMarkupWithoutPreviewMarks(sel.element).slice(0, 320) : undefined;
  return {
    label: sel.label,
    tagName: sel.tagName,
    selector: sel.selector ?? "",
    ...(sel.hfId ? { hfId: sel.hfId } : {}),
    ...(sel.sourceFile ? { sourceFile: sel.sourceFile } : {}),
    ...(sel.textContent ? { text: sel.textContent.slice(0, 240) } : {}),
    ...(htmlPreview ? { htmlPreview } : {}),
    ...(sel.boundingBox
      ? {
          rect: {
            x: Math.round(sel.boundingBox.x),
            y: Math.round(sel.boundingBox.y),
            width: Math.max(1, Math.round(sel.boundingBox.width)),
            height: Math.max(1, Math.round(sel.boundingBox.height)),
          },
        }
      : {}),
    ...(Object.keys(styles).length ? { styles } : {}),
  };
}

async function blobToDataUrl(blob: Blob): Promise<string | null> {
  if (typeof FileReader === "undefined") return null;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === "string" && reader.result.startsWith("data:image/") ? reader.result : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

export function useSuperAgentMotionBridge({
  projectId,
  activeCompPath,
  compositions,
  editingFile,
  domEditSelection,
  domEditGroupSelections,
  consoleErrors,
  waitForPendingDomEditSaves,
  onOpenFile,
  onSelectComposition,
}: UseSuperAgentMotionBridgeParams) {
  const config = useMemo(() => getSuperAgentMotionEmbedConfig(), []);
  const latestRef = useRef({
    projectId,
    activeCompPath,
    compositions,
    editingFile,
    domEditSelection,
    domEditGroupSelections,
    consoleErrors,
    waitForPendingDomEditSaves,
    onOpenFile,
    onSelectComposition,
  });
  latestRef.current = {
    projectId,
    activeCompPath,
    compositions,
    editingFile,
    domEditSelection,
    domEditGroupSelections,
    consoleErrors,
    waitForPendingDomEditSaves,
    onOpenFile,
    onSelectComposition,
  };

  const buildSnapshot = useCallback((): MotionSelectionSnapshot | null => {
    const cur = latestRef.current;
    if (!cur.projectId) return null;
    const player = usePlayerStore.getState();
    const selectedIds = new Set(player.selectedElementIds);
    if (player.selectedElementId) selectedIds.add(player.selectedElementId);
    const timelineClips = player.elements
      .filter((el) => selectedIds.has(el.id))
      .slice(0, 30)
      .map((el) => ({
        id: el.id,
        label: el.label || el.id || el.tag,
        kind: el.kind || el.tag,
        tag: el.tag,
        start: Number(el.start.toFixed(2)),
        duration: Number(el.duration.toFixed(2)),
        track: el.track,
        ...(el.sourceFile ? { sourceFile: el.sourceFile } : {}),
        ...(el.selector ? { selector: el.selector } : {}),
        ...(el.hfId ? { hfId: el.hfId } : {}),
        ...(el.src ? { src: el.src } : {}),
      }));

    const timeVal = player.isPlaying ? liveTime.latest() : player.currentTime;
    return {
      projectId: cur.projectId,
      activeCompPath: cur.activeCompPath,
      editingFile: cur.editingFile?.path ?? null,
      currentTime: Number((Number.isFinite(timeVal) ? timeVal : 0).toFixed(2)),
      duration: Number((Number.isFinite(player.duration) ? player.duration : 0).toFixed(2)),
      fps: 30,
      inPoint: player.inPoint !== null ? Number(player.inPoint.toFixed(2)) : null,
      outPoint: player.outPoint !== null ? Number(player.outPoint.toFixed(2)) : null,
      rangeSelection: player.rangeSelection
        ? { start: Number(player.rangeSelection.t0.toFixed(2)), end: Number(player.rangeSelection.t1.toFixed(2)) }
        : null,
      domSelection: cur.domEditSelection ? summarizeDomSelection(cur.domEditSelection) : null,
      groupSelections: (cur.domEditGroupSelections ?? []).slice(0, 20).map(summarizeDomSelection),
      timelineClips,
      keyframeCount: player.selectedKeyframes?.size ?? 0,
      consoleErrors: (cur.consoleErrors ?? []).slice(0, 15).map((item) => item.message),
    };
  }, []);

  const captureCurrentFrameDataUrl = useCallback(async (): Promise<{
    dataUrl: string | null;
    currentTime: number;
    compositionPath: string | null;
  }> => {
    const cur = latestRef.current;
    const player = usePlayerStore.getState();
    const time = Number((player.isPlaying ? liveTime.latest() : player.currentTime).toFixed(3));
    if (!cur.projectId) {
      return { dataUrl: null, currentTime: time, compositionPath: cur.activeCompPath };
    }
    try {
      await Promise.race([
        cur.waitForPendingDomEditSaves(),
        new Promise<void>((resolve) => setTimeout(resolve, 2500)),
      ]);
      const href = buildFrameCaptureUrl({
        projectId: cur.projectId,
        compositionPath: cur.activeCompPath,
        currentTime: time,
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await studioApiFetch(href, { cache: "no-store", signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) return { dataUrl: null, currentTime: time, compositionPath: cur.activeCompPath };
        const blob = await res.blob();
        const dataUrl = await blobToDataUrl(blob);
        return { dataUrl, currentTime: time, compositionPath: cur.activeCompPath };
      } catch {
        clearTimeout(timeout);
        return { dataUrl: null, currentTime: time, compositionPath: cur.activeCompPath };
      }
    } catch {
      return { dataUrl: null, currentTime: time, compositionPath: cur.activeCompPath };
    }
  }, []);

  // Announce readiness when project connects
  useEffect(() => {
    if (!config || !projectId) return;
    postMotionBridgeMessage({ type: "om:sa-motion-ready", token: config.token, projectId });
  }, [config, projectId]);

  // Publish selection snapshots when Motion editor state changes
  const publishTimerRef = useRef<number | null>(null);
  const lastJsonRef = useRef<string>("");

  const schedulePublish = useCallback(() => {
    if (!config) return;
    if (publishTimerRef.current !== null) window.clearTimeout(publishTimerRef.current);
    publishTimerRef.current = window.setTimeout(() => {
      publishTimerRef.current = null;
      const snap = buildSnapshot();
      if (!snap) return;
      const serialized = JSON.stringify(snap);
      if (serialized === lastJsonRef.current) return;
      lastJsonRef.current = serialized;
      postMotionBridgeMessage({ type: "om:sa-motion-selection", token: config.token, snapshot: snap });
    }, 90);
  }, [config, buildSnapshot]);

  useEffect(() => {
    if (!config) return;
    schedulePublish();
  }, [config, schedulePublish, projectId, activeCompPath, editingFile?.path, domEditSelection, domEditGroupSelections, consoleErrors]);

  useEffect(() => {
    if (!config) return;
    const unsubStore = usePlayerStore.subscribe(schedulePublish);
    let lastBucket = -1;
    const unsubTime = liveTime.subscribe((sec) => {
      const bucket = Math.round(sec * 5); // 200ms resolution prevents 60fps postMessage spam
      if (bucket !== lastBucket) {
        lastBucket = bucket;
        schedulePublish();
      }
    });
    return () => {
      unsubStore();
      unsubTime();
      if (publishTimerRef.current !== null) {
        window.clearTimeout(publishTimerRef.current);
        publishTimerRef.current = null;
      }
    };
  }, [config, schedulePublish]);

  // Listen to parent commands + internal UI attach triggers
  useEffect(() => {
    if (!config) return;

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const msg = event.data as MotionBridgeParentCommand | undefined;
      if (!msg || typeof msg !== "object" || msg.type !== "om:sa-motion-command" || msg.token !== config.token) {
        return;
      }
      if (msg.command === "attach-selection") {
        const snap = buildSnapshot();
        if (!snap) return;
        postMotionBridgeMessage({
          type: "om:sa-motion-attach",
          token: config.token,
          snapshot: snap,
          kind: msg.kind ?? "selection",
          ...(msg.comment ? { comment: msg.comment } : {}),
          ...(typeof msg.sendImmediately === "boolean" ? { sendImmediately: msg.sendImmediately } : {}),
        });
      } else if (msg.command === "capture-frame") {
        void captureCurrentFrameDataUrl().then((res) => {
          postMotionBridgeMessage({
            type: "om:sa-motion-frame-result",
            token: config.token,
            requestId: msg.requestId,
            dataUrl: res.dataUrl,
            currentTime: res.currentTime,
            compositionPath: res.compositionPath,
          });
        });
      } else if (msg.command === "open-file" && typeof msg.filePath === "string" && msg.filePath.trim()) {
        const cur = latestRef.current;
        cur.onOpenFile(msg.filePath);
        if (cur.compositions.includes(msg.filePath)) {
          cur.onSelectComposition(msg.filePath);
        }
        const dock = useDockLayoutStore.getState();
        if (dock.panels.includes("code")) {
          dock.activatePanel("code");
        }
      } else if (msg.command === "sync-theme" && (msg.theme === "light" || msg.theme === "dark")) {
        setStudioTheme(msg.theme);
      }
    };

    const onRequestAttach = (event: Event) => {
      const detail = (event as CustomEvent<MotionAttachRequestDetail>).detail ?? {};
      const snap = buildSnapshot();
      if (!snap) return;
      if (detail.includeFrame) {
        void captureCurrentFrameDataUrl().then((res) => {
          postMotionBridgeMessage({
            type: "om:sa-motion-attach",
            token: config.token,
            snapshot: snap,
            kind: detail.mode ?? "frame",
            ...(detail.comment ? { comment: detail.comment } : {}),
            ...(typeof detail.sendImmediately === "boolean" ? { sendImmediately: detail.sendImmediately } : {}),
            frameDataUrl: res.dataUrl,
          });
        });
        return;
      }
      postMotionBridgeMessage({
        type: "om:sa-motion-attach",
        token: config.token,
        snapshot: snap,
        kind: detail.mode ?? "selection",
        ...(detail.comment ? { comment: detail.comment } : {}),
        ...(typeof detail.sendImmediately === "boolean" ? { sendImmediately: detail.sendImmediately } : {}),
      });
    };

    window.addEventListener("message", onMessage);
    window.addEventListener(SA_MOTION_REQUEST_ATTACH_EVENT, onRequestAttach);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener(SA_MOTION_REQUEST_ATTACH_EVENT, onRequestAttach);
    };
  }, [config, buildSnapshot, captureCurrentFrameDataUrl]);
}
