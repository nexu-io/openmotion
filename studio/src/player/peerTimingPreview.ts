import { diffGroupChange } from "./visualGroupChange";
import { isLiveMediaMove } from "../../../shared/preview-live-media";
import { takeInsertedClip, takeRemovedClip } from "./visualClipStructure";
import { STUDIO_ORIGINAL_INLINE_TRANSLATE_ATTR } from "../../../packages/edit-core/canvas-position";
import { createPreviewAdapter } from "./lib/previewAdapter";
import { capturePresentedTimelineChanges } from "./lib/isolatedTimelineEdits";
import { setPreviewMediaMuted } from "./lib/timelineIframeHelpers";
import { usePlayerStore } from "./store/playerStore";
import { PREVIEW_ATTRIBUTES, canPatchPreviewAttribute, PRESENTATION_STYLES, PRESENTATION_TAGS, MAX_PREVIEW_TEXT_LENGTH, type PreviewChange, type PreviewLiveEdits, isPaintOnlyChange, isMediaBoxChange, isLivePositionEdit, canPatchPresentationValue } from "../../../shared/preview-timing";

type FileSnapshot = { content: string; version: string };

// A WindowProxy survives navigation. Bind a request to the document that acknowledged the handshake.
const documents = new WeakMap<HTMLIFrameElement, { token: string; id: string; canRebind: boolean; canRefreshParked: boolean; mountedVersions: Map<string, string>; liveEdits: PreviewLiveEdits; timingFile?: { path: string; version: string } }>();
export function rememberPeerTimingDocument(frame: HTMLIFrameElement, token: string | null, timingId: unknown, styleId?: unknown, liveEdits: PreviewLiveEdits = {}, canRefreshParked = false, mountedVersions?: Record<string, string>): void {
  const id = timingId ?? styleId;
  if (token && typeof id === "string" && id.length > 0 && id.length <= 64) {
    const known = documents.get(frame);
    if (known?.id !== id || known.token !== token) documents.set(frame, {
      token, id, canRebind: id === timingId, canRefreshParked, liveEdits, mountedVersions: new Map(Object.entries(mountedVersions ?? {})),
    });
  }
  else documents.delete(frame);
}

export async function tryRefreshParkedPeerScene(frame: HTMLIFrameElement, path: string, version: string, isCurrent: () => boolean) {
  return refreshPeerScenes(frame, [[path, version]], isCurrent);
}

export async function refreshPeerScenes(frame: HTMLIFrameElement, files: [string, string][], isCurrent: () => boolean) {
  const doc = documents.get(frame);
  if (!doc?.canRefreshParked || !isCurrent()) return false;
  const adapter = createPreviewAdapter({ iframe: frame });
  if (adapter.token !== doc.token) return false;
  const timeout = 5000;
  const applied = await adapter.request<boolean>("refresh-parked-scene", {
    ...(files.length === 1 ? {path: files[0]![0], fileVersion: files[0]![1]} : {files}),
    documentId: doc.id, expiresAt: Date.now() + timeout,
  }, timeout).catch(() => false);
  if (applied !== true || documents.get(frame) !== doc || !isCurrent()) return false;
  for (const [path, version] of files) doc.mountedVersions.set(path, version);
  return true;
}

/** A scripted or older document can start rebuilding in parallel with the source read. */
export function hasPeerTimingDocument(frame: HTMLIFrameElement): boolean {
  return documents.get(frame)?.canRebind === true;
}

export function hasPeerLiveEdit(frame: HTMLIFrameElement, capability: keyof PreviewLiveEdits): boolean {
  return documents.get(frame)?.liveEdits?.[capability] === true;
}

/** A queued clip list can outlive the verified in-place edit that replaced its timings. */
export function acceptsTimingManifest(frame: HTMLIFrameElement, path: unknown, version: unknown): boolean {
  const expected = documents.get(frame)?.timingFile;
  return !expected || path !== expected.path || version === expected.version;
}

/** Only child files compiled into this document have a pinned baseline. */
export function mountedPeerFileVersion(frame: HTMLIFrameElement, path: string) {
  return documents.get(frame)?.mountedVersions.get(path);
}

export function hasScriptedStylePreview(frame: HTMLIFrameElement) {
  return documents.get(frame)?.canRebind === false;
}

export interface PeerTimingUpdate {
  path: string;
  previous: FileSnapshot;
  current: FileSnapshot;
}

function elements(doc: Document | DocumentFragment): Element[] {
  return [...doc.querySelectorAll("*")].flatMap(node =>
    node instanceof HTMLTemplateElement ? [node, ...elements(node.content)] : [node]);
}

const presentationTags = new Set<string>(PRESENTATION_TAGS);

function simpleText(element: Element): Text | null {
  const node = element.firstChild;
  return node?.nodeType === Node.TEXT_NODE && !node.nextSibling ? node as Text : null;
}

/** Compare the browser's CSS declarations, including fallback order and shorthands. */
function changedStyles(left: HTMLElement, right: HTMLElement): PreviewChange["styles"] | null {
  const next = right.style;
  const projected = left.cloneNode(false) as HTMLElement;
  const styles: NonNullable<PreviewChange["styles"]> = [];
  for (const name of PRESENTATION_STYLES) {
    const from = left.style.getPropertyValue(name);
    const to = next.getPropertyValue(name);
    if (from === to) continue;
    if (!canPatchPresentationValue(name, to) || left.style.getPropertyPriority(name) || next.getPropertyPriority(name)) return null;
    styles.push([name, from, to]);
    if (to) projected.style.setProperty(name, to);
    else projected.style.removeProperty(name);
  }
  return styles.length && projected.style.cssText === next.cssText ? styles : null;
}

/** Strip only supported changes, then compare the entire remaining document before touching the player. */
export function diffPreviewChanges(previous: string, current: string, measured = false): PreviewChange[] | null {
  if (previous === current) return null;
  const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
  const before = parse(previous);
  const after = parse(current);
  if (before.compatMode !== after.compatMode || before.doctype?.publicId !== after.doctype?.publicId ||
      before.doctype?.systemId !== after.doctype?.systemId || before.doctype?.name !== after.doctype?.name) return null;
  const a = elements(before);
  const b = elements(after);
  const changes: PreviewChange[] = [];
  if (a.length !== b.length) {
    const structural = a.length === b.length + 1 ? takeRemovedClip(before, after, a, presentationTags)
      : b.length === a.length + 1 && takeInsertedClip(before, after, b, presentationTags);
    if (!structural) {
      if (Math.abs(a.length - b.length) !== 1) return null;
      const group = diffGroupChange(before, after, b.length > a.length, presentationTags);
      return group ? [group] : null;
    }
    changes.push(structural);
  }
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.localName !== right.localName) return null;
    const attributes: PreviewChange["attributes"] = [];
    for (const name of PREVIEW_ATTRIBUTES) {
      const from = left.getAttribute(name);
      const to = right.getAttribute(name);
      if (from === to) continue;
      if ([from, to].some(value => !canPatchPreviewAttribute(name, value, left.localName))) return null;
      attributes.push([name, from, to]);
      left.removeAttribute(name);
      right.removeAttribute(name);
    }
    let styles: PreviewChange["styles"];
    let text: PreviewChange["text"];
    let captureOriginalTranslate: boolean | undefined;
    if ((presentationTags.has(left.localName) || ["canvas", "img", "video"].includes(left.localName)) && left instanceof HTMLElement && right instanceof HTMLElement) {
      if (left.getAttribute("style") !== right.getAttribute("style")) {
        styles = changedStyles(left, right) ?? undefined;
        if (!styles) return null;
        const from = left.getAttribute(STUDIO_ORIGINAL_INLINE_TRANSLATE_ATTR);
        const to = right.getAttribute(STUDIO_ORIGINAL_INLINE_TRANSLATE_ATTR);
        if (from !== to) {
          const move = styles.find(([name]) => name === "translate");
          if (!move || !(from === null && to === move[1] || to === null && from === move[2])) return null;
          captureOriginalTranslate = from === null;
          left.removeAttribute(STUDIO_ORIGINAL_INLINE_TRANSLATE_ATTR);
          right.removeAttribute(STUDIO_ORIGINAL_INLINE_TRANSLATE_ATTR);
        }
        left.removeAttribute("style");
        right.removeAttribute("style");
      }
      const from = simpleText(left), to = simpleText(right);
      if (from && to && from.data !== to.data) {
        if (Math.max(from.length, to.length) > MAX_PREVIEW_TEXT_LENGTH) return null;
        text = [from.data, to.data];
        from.data = to.data;
      }
    }
    if (!attributes.length && !styles && !text) continue;
    const hfId = left.getAttribute("data-hf-id");
    const compositionId = left.getAttribute("data-composition-id");
    if (!hfId && !left.id && !compositionId) return null;
    const change = { hfId, id: left.id, compositionId, tag: left.localName, attributes, styles, text, captureOriginalTranslate };
    // Moving the canvas DOM box preserves its drawing buffer. Its content and dimensions are owned by the renderer.
    if (!presentationTags.has(change.tag) && (styles || text) && !isPaintOnlyChange(change) && !(measured && isMediaBoxChange(change)) &&
        !(change.tag === "canvas" && isLivePositionEdit([change]))) return null;
    changes.push(change);
  }
  if (!changes.length || before.documentElement.outerHTML !== after.documentElement.outerHTML) return null;
  return changes;
}

/** The first visual edit can persist the exact IDs already mounted by the compiler. */
export async function diffMountedPreview(previous: string, current: string, measured = false) {
  const changes = diffPreviewChanges(previous, current, measured);
  if (changes || current.split("data-hf-id=").length <= previous.split("data-hf-id=").length) return changes;
  const { ensureHfIds } = await import("@hyperframes/parsers/hf-ids");
  return diffPreviewChanges(ensureHfIds(previous), current, measured);
}

function onlyStyles(changes: PreviewChange[]) {
  return changes.every(change => change.styles && !change.attributes.length && !change.text);
}

export async function diffScriptedPreviewStyles(previous: string, current: string) {
  const changes = await diffMountedPreview(previous, current);
  return changes && onlyStyles(changes) ? changes : null;
}

export async function tryApplyPeerChanges(
  frame: HTMLIFrameElement | null,
  update: PeerTimingUpdate,
  isCurrent: () => boolean,
  options?: "paint-only" | "temporary" | "keep-visible" | { gestureId?: string } | { structureDraftId: string; onGroup?: (group: import("../../../shared/preview-group").GroupChange) => void },
): Promise<boolean> {
  if (!frame || !isCurrent()) return false;
  const adapter = createPreviewAdapter({ iframe: frame });
  const document = documents.get(frame);
  if (adapter.sameOrigin || !document || document.token !== adapter.token || !adapter.projectId) return false;
  const { previous, current } = update;
  const releasePresented = capturePresentedTimelineChanges(frame, update.path);
  // Several accepted toggles can bring the file back to the exact source already on screen.
  const sameContent = !options && document.canRebind && previous.content === current.content;
  const measured = typeof options === "object" && "gestureId" in options && !!options.gestureId;
  const changes = sameContent ? [] : options === "temporary" ? await diffScriptedPreviewStyles(previous.content, current.content) :
    await diffMountedPreview(previous.content, current.content, measured);
  if (!changes || !isCurrent() || (options === "paint-only" && !changes.every(isPaintOnlyChange))) return false;
  const canAdvance = document.canRebind || (measured && changes.length === 1 && isMediaBoxChange(changes[0]!)) || (document.liveEdits.position && (isLivePositionEdit(changes) || changes.every(isPaintOnlyChange))) ||
    (document.liveEdits.mediaTiming && isLiveMediaMove(changes));
  const temporary = options === "temporary" || (!canAdvance && options === "keep-visible");
  if (temporary && (document.canRebind || !onlyStyles(changes))) return false;
  if (!temporary && !canAdvance) return false;
  const draftId = typeof options === "object" && "structureDraftId" in options ? options.structureDraftId : undefined;
  if (draftId && (!document.canRebind || !changes.some(change => change.removeFromComposition || change.insert || change.group))) return false;
  const localSave = typeof options === "object" && !("structureDraftId" in options) ? options : undefined;
  const presentation = changes.some(c => c.styles || c.text);
  const mediaControl = !presentation && !!document.canRebind && changes.length > 0 && changes.every(c =>
    (c.tag === "audio" || c.tag === "video") && c.attributes.length > 0 &&
    c.attributes.every(([name]) => ["data-media-start", "data-playback-start", "loop", "data-playback-rate"].includes(name)));
  if (localSave && !mediaControl && (!presentation || changes.some(c => c.attributes.length))) return false;
  const timeout = 350;
  const sentFrom = document.mountedVersions.get(update.path);
  try {
    const paint = adapter.request<boolean>(presentation ? "peer-presentation" : "peer-timing", {
      documentId: document.id, path: update.path, before: update.previous.version, after: update.current.version,
      changes, ...(sameContent && { sameContent: true }), ...(draftId && { structureDraftId: draftId }),
      ...(temporary && { temporary: true }), ...(localSave && { localSave: true, gestureId: localSave.gestureId }), expiresAt: Date.now() + timeout,
    }, timeout);
    // A provisional style can paint in parallel with the authoritative script rebuild.
    if (temporary && options === "keep-visible") {
      void paint.catch(() => {});
      return false;
    }
    // A busy player can apply an edit before Studio receives its reply. Verify the
    // mounted revision without performing the mutation a second time.
    const applied = await paint.catch(async () => {
      if (temporary || draftId || previous.version === current.version || documents.get(frame) !== document) return false;
      const version = await adapter.request<string | null>("mounted-file-version", { documentId: document.id, path: update.path });
      return version === current.version;
    });
    if (applied !== true || documents.get(frame) !== document) return false;
    // A newer gesture supersedes an old paint's UI side effects, but its next
    // patch still needs to know which source the live frame actually accepted.
    const lastKnown = document.mountedVersions.get(update.path);
    if (!temporary && !draftId && (lastKnown === sentFrom || lastKnown === previous.version)) {
      document.mountedVersions.set(update.path, current.version);
    }
    if (!isCurrent()) return false;
    if (draftId) {
      const group = changes[0]?.group;
      if (group && typeof options === "object" && "structureDraftId" in options) options.onGroup?.(group);
      return true;
    }
    // The HTML attribute changes defaultMuted. The runtime combines per-clip mute
    // with this window's independent monitor preference on a set-muted message.
    if (changes.some(change => change.attributes.some(([name]) => name === "muted"))) {
      setPreviewMediaMuted(frame, usePlayerStore.getState().audioMuted);
    }
    if (!temporary && changes.some(change => change.attributes.length || change.removeFromComposition || change.insert || change.group)) releasePresented?.();
    if (!temporary && (!presentation || document.timingFile?.path === update.path)) {
      document.timingFile = { path: update.path, version: current.version };
    }
    return true;
  } catch { return false; }
}

/** Paint the same structural delta that its receipt will confirm. The draft never advances the file version. */
export function stageStructurePreview(frame: HTMLIFrameElement, path: string, previous: FileSnapshot, content: string, onGroup?: (group: import("../../../shared/preview-group").GroupChange) => void) {
  const doc = documents.get(frame);
  if (!doc?.canRebind) return;
  const adapter = createPreviewAdapter({ iframe: frame });
  const id = crypto.randomUUID();
  let active = true;
  const current = () => active && frame.isConnected && documents.get(frame) === doc;
  void tryApplyPeerChanges(frame, { path, previous, current: { content, version: previous.version } }, current,
    { structureDraftId: id, onGroup }).catch(() => {});
  return () => {
    active = false;
    if (frame.isConnected && documents.get(frame) === doc) {
      adapter.send("peer-timing", { documentId: doc.id, path, discardDraftId: id });
    }
  };
}
