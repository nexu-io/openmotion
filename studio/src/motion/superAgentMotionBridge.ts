import type { BrowserPickedElement } from '../../../shared/browser';
import type {
  SuperAgentEditorElementSelection,
  SuperAgentMotionClipSelection,
  SuperAgentResourceAttachment,
} from '../../../shared/super-agent';

export const SA_MOTION_REQUEST_ATTACH_EVENT = 'om:sa-motion-request-attach';

export type MotionClipSummary = SuperAgentMotionClipSelection;

export interface MotionDomElementSummary {
  label: string;
  tagName: string;
  selector: string;
  hfId?: string;
  sourceFile?: string;
  text?: string;
  htmlPreview?: string;
  rect?: { x: number; y: number; width: number; height: number };
  styles?: Record<string, string>;
}

export interface MotionSelectionSnapshot {
  projectId: string;
  activeCompPath: string | null;
  editingFile: string | null;
  currentTime: number;
  duration: number;
  fps: number;
  inPoint: number | null;
  outPoint: number | null;
  rangeSelection: { start: number; end: number } | null;
  domSelection: MotionDomElementSummary | null;
  groupSelections: MotionDomElementSummary[];
  timelineClips: MotionClipSummary[];
  keyframeCount: number;
  consoleErrors: string[];
}

export interface MotionAttachRequestDetail {
  comment?: string;
  sendImmediately?: boolean;
  includeFrame?: boolean;
  mode?: 'selection' | 'frame' | 'console' | 'project';
}

export type MotionBridgeIframeMessage =
  | { type: 'om:sa-motion-ready'; token: string; projectId: string }
  | { type: 'om:sa-motion-selection'; token: string; snapshot: MotionSelectionSnapshot }
  | {
      type: 'om:sa-motion-attach';
      token: string;
      snapshot: MotionSelectionSnapshot;
      kind: 'selection' | 'frame' | 'console' | 'project';
      comment?: string;
      sendImmediately?: boolean;
      frameDataUrl?: string | null;
    }
  | {
      type: 'om:sa-motion-frame-result';
      token: string;
      requestId: string;
      dataUrl: string | null;
      currentTime: number;
      compositionPath: string | null;
    };

export type MotionBridgeParentCommand =
  | {
      type: 'om:sa-motion-command';
      token: string;
      command: 'attach-selection';
      kind?: 'selection' | 'project' | 'console';
      comment?: string;
      sendImmediately?: boolean;
    }
  | {
      type: 'om:sa-motion-command';
      token: string;
      command: 'capture-frame';
      requestId: string;
    }
  | {
      type: 'om:sa-motion-command';
      token: string;
      command: 'open-file';
      filePath: string;
    }
  | {
      type: 'om:sa-motion-command';
      token: string;
      command: 'sync-theme';
      theme: 'light' | 'dark';
    };

export function getSuperAgentMotionEmbedConfig(
  search = typeof window !== 'undefined' ? window.location.search : '',
): { enabled: true; token: string } | null {
  if (typeof window === 'undefined' || window.parent === window) return null;
  const sp = new URLSearchParams(search);
  if (sp.get('superAgent') !== '1') return null;
  const token = sp.get('saBridge')?.trim() || '';
  if (!token) return null;
  return { enabled: true, token };
}

export function postMotionBridgeMessage(message: MotionBridgeIframeMessage): void {
  if (typeof window === 'undefined' || window.parent === window) return;
  try {
    window.parent.postMessage(message, window.location.origin);
  } catch {
    // Ignore detached parent frame.
  }
}

export function requestMotionAttachToSuperAgent(detail: MotionAttachRequestDetail = {}): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<MotionAttachRequestDetail>(SA_MOTION_REQUEST_ATTACH_EVENT, { detail }));
}

export function formatTimeShort(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0.0s';
  return `${seconds.toFixed(1)}s`;
}

export function formatMotionSelectionLabel(snapshot: MotionSelectionSnapshot | null): string {
  if (!snapshot) return 'Attach selection';
  const timePart = formatTimeShort(snapshot.currentTime);
  if (snapshot.domSelection) {
    const label = snapshot.domSelection.label || snapshot.domSelection.selector;
    const countSuffix = snapshot.groupSelections.length > 1 ? ` (+${snapshot.groupSelections.length - 1})` : '';
    return `${label}${countSuffix} · ${timePart}`;
  }
  if (snapshot.timelineClips.length === 1) {
    const c = snapshot.timelineClips[0];
    return `${c.label} · ${formatTimeShort(c.start)}–${formatTimeShort(c.start + c.duration)}`;
  }
  if (snapshot.timelineClips.length > 1) {
    const start = Math.min(...snapshot.timelineClips.map(c => c.start));
    const end = Math.max(...snapshot.timelineClips.map(c => c.start + c.duration));
    return `${snapshot.timelineClips.length} clips · ${formatTimeShort(start)}–${formatTimeShort(end)}`;
  }
  if (snapshot.rangeSelection) {
    return `${formatTimeShort(snapshot.rangeSelection.start)}–${formatTimeShort(snapshot.rangeSelection.end)}`;
  }
  if (snapshot.inPoint !== null || snapshot.outPoint !== null) {
    const start = snapshot.inPoint ?? 0;
    const end = snapshot.outPoint ?? snapshot.duration;
    return `${formatTimeShort(start)}–${formatTimeShort(end)}`;
  }
  if (snapshot.duration > 0) {
    return `${timePart} / ${formatTimeShort(snapshot.duration)}`;
  }
  return timePart;
}

export function hasRichMotionSelection(snapshot: MotionSelectionSnapshot | null): boolean {
  if (!snapshot) return false;
  return Boolean(
    snapshot.domSelection
    || snapshot.groupSelections.length > 0
    || snapshot.timelineClips.length > 0
    || snapshot.rangeSelection
    || snapshot.keyframeCount > 0,
  );
}

function toBrowserPickedElement(
  dom: MotionDomElementSummary,
  pageUrl: string,
  pageTitle: string,
): BrowserPickedElement {
  return {
    tagName: dom.tagName,
    selector: dom.selector,
    ...(dom.hfId ? { id: dom.hfId } : {}),
    label: dom.label,
    ...(dom.text ? { text: dom.text } : {}),
    htmlPreview: dom.htmlPreview || `<${dom.tagName}>`,
    styles: dom.styles ?? {},
    rect: dom.rect ?? { x: 0, y: 0, width: 120, height: 48 },
    viewport: { width: 1280, height: 720 },
    pageUrl,
    pageTitle,
    ...(dom.sourceFile ? { sourceFile: dom.sourceFile } : {}),
  };
}

export function motionSnapshotToAttachment({
  snapshot,
  artifactId,
  artifactTitle,
  kind,
  comment,
  screenshotUrl,
  screenshotPath,
}: {
  snapshot: MotionSelectionSnapshot;
  artifactId: string;
  artifactTitle: string;
  kind: 'selection' | 'frame' | 'console' | 'project';
  comment?: string;
  screenshotUrl?: string;
  screenshotPath?: string;
}): SuperAgentResourceAttachment {
  const pageUrl = `/#project/${encodeURIComponent(snapshot.projectId)}`;
  const effectiveRange = snapshot.rangeSelection
    ?? (snapshot.inPoint !== null || snapshot.outPoint !== null
      ? { start: snapshot.inPoint ?? 0, end: snapshot.outPoint ?? snapshot.duration }
      : undefined);

  const selectedElements: SuperAgentEditorElementSelection[] = snapshot.groupSelections.length > 0
    ? snapshot.groupSelections.map(item => ({
        label: item.label,
        tagName: item.tagName,
        selector: item.selector,
        ...(item.hfId ? { hfId: item.hfId } : {}),
        ...(item.sourceFile ? { sourceFile: item.sourceFile } : {}),
        ...(item.text ? { text: item.text } : {}),
      }))
    : snapshot.domSelection
      ? [{
          label: snapshot.domSelection.label,
          tagName: snapshot.domSelection.tagName,
          selector: snapshot.domSelection.selector,
          ...(snapshot.domSelection.hfId ? { hfId: snapshot.domSelection.hfId } : {}),
          ...(snapshot.domSelection.sourceFile ? { sourceFile: snapshot.domSelection.sourceFile } : {}),
          ...(snapshot.domSelection.text ? { text: snapshot.domSelection.text } : {}),
        }]
      : [];

  const title = kind === 'frame'
    ? `Frame @ ${formatTimeShort(snapshot.currentTime)}`
    : kind === 'console'
      ? `${snapshot.consoleErrors.length} Motion console errors`
      : formatMotionSelectionLabel(snapshot);

  const mode = kind === 'frame'
    ? 'screenshot'
    : kind === 'console'
      ? 'console'
      : 'motion-selection';

  return {
    id: `motion-sel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: 'browser-annotation',
    title,
    subtitle: [artifactTitle, snapshot.activeCompPath || 'index.html'].filter(Boolean).join(' · '),
    ...(screenshotUrl ? { previewUrl: screenshotUrl } : {}),
    annotation: {
      mode,
      pageUrl,
      pageTitle: artifactTitle,
      ...(comment?.trim() ? { comment: comment.trim() } : {}),
      ...(snapshot.domSelection
        ? { element: toBrowserPickedElement(snapshot.domSelection, pageUrl, artifactTitle) }
        : {}),
      ...(selectedElements.length ? { selectedElements } : {}),
      ...(snapshot.timelineClips.length ? { timelineClips: snapshot.timelineClips } : {}),
      ...(typeof snapshot.currentTime === 'number' ? { timeSec: Number(snapshot.currentTime.toFixed(2)) } : {}),
      ...(typeof snapshot.duration === 'number' && snapshot.duration > 0 ? { durationSec: Number(snapshot.duration.toFixed(2)) } : {}),
      ...(typeof snapshot.fps === 'number' && snapshot.fps > 0 ? { fps: snapshot.fps } : {}),
      ...(effectiveRange ? { timeRange: { start: Number(effectiveRange.start.toFixed(2)), end: Number(effectiveRange.end.toFixed(2)) } } : {}),
      ...(snapshot.activeCompPath ? { compositionPath: snapshot.activeCompPath } : {}),
      ...(snapshot.editingFile ? { filePath: snapshot.editingFile } : snapshot.domSelection?.sourceFile ? { filePath: snapshot.domSelection.sourceFile } : {}),
      ...(snapshot.keyframeCount > 0 ? { keyframeCount: snapshot.keyframeCount } : {}),
      ...(snapshot.consoleErrors.length ? { consoleErrors: snapshot.consoleErrors.slice(0, 15) } : {}),
      ...(screenshotUrl ? { screenshotUrl } : {}),
      ...(screenshotPath ? { screenshotPath } : {}),
      artifactId,
      artifactKind: 'motion-project',
      projectId: snapshot.projectId,
    },
  };
}
