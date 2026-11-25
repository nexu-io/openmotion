import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import type { SuperAgentArtifact, SuperAgentResourceAttachment } from '../../../shared/super-agent';
import { useI18n } from '../i18n/I18n';
import {
  motionSnapshotToAttachment,
  type MotionBridgeIframeMessage,
  type MotionBridgeParentCommand,
  type MotionSelectionSnapshot,
} from '../motion/superAgentMotionBridge';
import { uploadSuperAgentAnnotationImage } from './superAgentClient';

export type MotionProjectArtifactHandle = {
  attachSelection: (sendImmediately?: boolean) => void;
  captureFrame: () => Promise<void>;
  attachConsoleErrors: (sendImmediately?: boolean) => void;
  openFile: (filePath: string) => void;
};

type MotionProjectArtifactViewProps = {
  artifact: SuperAgentArtifact;
  chatId: string | null;
  reloadKey: number;
  requestedFile?: { path: string; seq: number } | null;
  onSnapshotChange?: (snapshot: MotionSelectionSnapshot | null) => void;
  onAttachAnnotation?: (attachment: SuperAgentResourceAttachment, sendImmediately?: boolean) => void;
  onNotify?: (message: string, tone?: 'info' | 'error') => void;
};

function currentHostMotionTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'paper' ? 'light' : 'dark';
}

export const MotionProjectArtifactView = forwardRef<
  MotionProjectArtifactHandle,
  MotionProjectArtifactViewProps
>(function MotionProjectArtifactView(
  {
    artifact,
    chatId,
    reloadKey,
    requestedFile,
    onSnapshotChange,
    onAttachAnnotation,
    onNotify,
  },
  ref,
) {
  const { t } = useI18n();
  const projectId = artifact.projectId || '';
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const queuedFileRef = useRef<string | null>(null);
  const latestSnapshotRef = useRef<MotionSelectionSnapshot | null>(null);
  const frameResolversRef = useRef(
    new Map<string, (res: { dataUrl: string | null; currentTime: number; compositionPath: string | null }) => void>(),
  );
  const bridgeTokenRef = useRef(`sa_motion_${Math.random().toString(36).slice(2, 12)}`);

  const onSnapshotChangeRef = useRef(onSnapshotChange);
  onSnapshotChangeRef.current = onSnapshotChange;
  const onAttachRef = useRef(onAttachAnnotation);
  onAttachRef.current = onAttachAnnotation;
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  const artifactRef = useRef(artifact);
  artifactRef.current = artifact;
  const tRef = useRef(t);
  tRef.current = t;

  const postCommand = useCallback((cmd: MotionBridgeParentCommand) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return false;
    try {
      win.postMessage(cmd, window.location.origin);
      return true;
    } catch {
      return false;
    }
  }, []);

  const syncThemeToIframe = useCallback(() => {
    postCommand({
      type: 'om:sa-motion-command',
      token: bridgeTokenRef.current,
      command: 'sync-theme',
      theme: currentHostMotionTheme(),
    });
  }, [postCommand]);

  const sendOpenFile = useCallback((filePath: string) => {
    if (!filePath.trim()) return;
    if (!readyRef.current) {
      queuedFileRef.current = filePath;
      return;
    }
    postCommand({
      type: 'om:sa-motion-command',
      token: bridgeTokenRef.current,
      command: 'open-file',
      filePath,
    });
  }, [postCommand]);

  useEffect(() => {
    readyRef.current = false;
    latestSnapshotRef.current = null;
    queuedFileRef.current = null;
  }, [projectId, reloadKey]);

  useEffect(() => {
    if (requestedFile?.path) {
      sendOpenFile(requestedFile.path);
    }
  }, [requestedFile?.path, requestedFile?.seq, sendOpenFile]);

  // Keep embedded Motion Studio theme synced with Super Agent host theme (paper -> light, default -> dark).
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      syncThemeToIframe();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, [syncThemeToIframe]);

  // Handle incoming bridge messages from embedded Motion Studio iframe.
  useEffect(() => {
    const uploadAndAttach = async ({
      snapshot,
      kind,
      comment,
      sendImmediately,
      frameDataUrl,
    }: {
      snapshot: MotionSelectionSnapshot;
      kind: 'selection' | 'frame' | 'console' | 'project';
      comment?: string;
      sendImmediately?: boolean;
      frameDataUrl?: string | null;
    }) => {
      let screenshotUrl: string | undefined;
      let screenshotPath: string | undefined;
      const cid = chatIdRef.current;
      if (frameDataUrl && cid) {
        try {
          const uploaded = await uploadSuperAgentAnnotationImage(cid, frameDataUrl);
          screenshotUrl = uploaded.screenshotUrl;
          screenshotPath = uploaded.screenshotPath;
        } catch {
          // Graceful fallback: keep rich selection/time metadata even if screenshot upload fails.
        }
      }
      const curArt = artifactRef.current;
      const att = motionSnapshotToAttachment({
        snapshot,
        artifactId: curArt.id,
        artifactTitle: curArt.title,
        kind,
        comment,
        screenshotUrl,
        screenshotPath,
      });
      onAttachRef.current?.(att, Boolean(sendImmediately));
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const msg = event.data as MotionBridgeIframeMessage | undefined;
      if (!msg || typeof msg !== 'object' || msg.token !== bridgeTokenRef.current) return;

      if (msg.type === 'om:sa-motion-ready') {
        readyRef.current = true;
        syncThemeToIframe();
        if (queuedFileRef.current) {
          const pendingPath = queuedFileRef.current;
          queuedFileRef.current = null;
          sendOpenFile(pendingPath);
        }
        return;
      }

      if (msg.type === 'om:sa-motion-selection') {
        latestSnapshotRef.current = msg.snapshot;
        onSnapshotChangeRef.current?.(msg.snapshot);
        return;
      }

      if (msg.type === 'om:sa-motion-attach') {
        latestSnapshotRef.current = msg.snapshot;
        onSnapshotChangeRef.current?.(msg.snapshot);
        void uploadAndAttach({
          snapshot: msg.snapshot,
          kind: msg.kind,
          comment: msg.comment,
          sendImmediately: msg.sendImmediately,
          frameDataUrl: msg.frameDataUrl,
        });
        return;
      }

      if (msg.type === 'om:sa-motion-frame-result') {
        const resolver = frameResolversRef.current.get(msg.requestId);
        if (resolver) {
          frameResolversRef.current.delete(msg.requestId);
          resolver({
            dataUrl: msg.dataUrl,
            currentTime: msg.currentTime,
            compositionPath: msg.compositionPath,
          });
        }
      }
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      frameResolversRef.current.clear();
    };
  }, [syncThemeToIframe, sendOpenFile]);

  const attachSelection = useCallback((sendImmediately = false) => {
    const sent = postCommand({
      type: 'om:sa-motion-command',
      token: bridgeTokenRef.current,
      command: 'attach-selection',
      kind: 'selection',
      sendImmediately,
    });
    if (!sent && latestSnapshotRef.current) {
      const att = motionSnapshotToAttachment({
        snapshot: latestSnapshotRef.current,
        artifactId: artifactRef.current.id,
        artifactTitle: artifactRef.current.title,
        kind: 'selection',
      });
      onAttachRef.current?.(att, sendImmediately);
    }
  }, [postCommand]);

  const attachConsoleErrors = useCallback((sendImmediately = false) => {
    postCommand({
      type: 'om:sa-motion-command',
      token: bridgeTokenRef.current,
      command: 'attach-selection',
      kind: 'console',
      ...(sendImmediately
        ? { comment: tRef.current('Fix these runtime console errors from the Motion preview.') }
        : {}),
      sendImmediately,
    });
  }, [postCommand]);

  const captureFrame = useCallback(async () => {
    const requestId = `mcap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const result = await new Promise<{ dataUrl: string | null; currentTime: number; compositionPath: string | null }>(resolve => {
      const timer = setTimeout(() => {
        frameResolversRef.current.delete(requestId);
        resolve({
          dataUrl: null,
          currentTime: latestSnapshotRef.current?.currentTime ?? 0,
          compositionPath: latestSnapshotRef.current?.activeCompPath ?? null,
        });
      }, 15_000);
      frameResolversRef.current.set(requestId, res => {
        clearTimeout(timer);
        resolve(res);
      });
      const sent = postCommand({
        type: 'om:sa-motion-command',
        token: bridgeTokenRef.current,
        command: 'capture-frame',
        requestId,
      });
      if (!sent) {
        clearTimeout(timer);
        frameResolversRef.current.delete(requestId);
        resolve({
          dataUrl: null,
          currentTime: latestSnapshotRef.current?.currentTime ?? 0,
          compositionPath: latestSnapshotRef.current?.activeCompPath ?? null,
        });
      }
    });

    if (!result.dataUrl) {
      onNotifyRef.current?.(tRef.current('Could not capture screenshot'), 'error');
      return;
    }

    let screenshotUrl: string | undefined;
    let screenshotPath: string | undefined;
    const cid = chatIdRef.current;
    if (cid) {
      try {
        const uploaded = await uploadSuperAgentAnnotationImage(cid, result.dataUrl);
        screenshotUrl = uploaded.screenshotUrl;
        screenshotPath = uploaded.screenshotPath;
      } catch {
        // Proceed with frame metadata even if upload fails.
      }
    }

    const curArt = artifactRef.current;
    const baseSnapshot: MotionSelectionSnapshot = latestSnapshotRef.current ?? {
      projectId,
      activeCompPath: result.compositionPath,
      editingFile: null,
      currentTime: result.currentTime,
      duration: 0,
      fps: 30,
      inPoint: null,
      outPoint: null,
      rangeSelection: null,
      domSelection: null,
      groupSelections: [],
      timelineClips: [],
      keyframeCount: 0,
      consoleErrors: [],
    };
    const att = motionSnapshotToAttachment({
      snapshot: {
        ...baseSnapshot,
        currentTime: result.currentTime,
        activeCompPath: result.compositionPath ?? baseSnapshot.activeCompPath,
      },
      artifactId: curArt.id,
      artifactTitle: curArt.title,
      kind: 'frame',
      screenshotUrl,
      screenshotPath,
    });
    onAttachRef.current?.(att, false);
  }, [postCommand, projectId]);

  useImperativeHandle(ref, () => ({
    attachSelection,
    captureFrame,
    attachConsoleErrors,
    openFile: sendOpenFile,
  }), [attachSelection, captureFrame, attachConsoleErrors, sendOpenFile]);

  const iframeSrc = useMemo(() => {
    const sessionPart = artifact.sessionId ? `session=${encodeURIComponent(artifact.sessionId)}&` : '';
    const pid = encodeURIComponent(projectId);
    const token = encodeURIComponent(bridgeTokenRef.current);
    return `/?${sessionPart}project=${pid}&embed=1&hostChrome=1&superAgent=1&saBridge=${token}#project/${pid}`;
  }, [artifact.sessionId, projectId]);

  return (
    <div className="om-sa-iframe-stage om-sa-motion-editor-stage" data-viewport="desktop">
      <div className="om-sa-iframe-frame">
        <iframe
          ref={iframeRef}
          key={`${projectId}:${reloadKey}`}
          title={artifact.title}
          src={iframeSrc}
          onLoad={syncThemeToIframe}
        />
      </div>
    </div>
  );
});
