import { diffGroupChange } from "./visualGroupChange";
import { isLiveAudioTrim, isLiveMediaMove } from "../../../shared/preview-live-media";
import { takeInsertedClip, takeRemovedClip } from "./visualClipStructure";
import { STUDIO_ORIGINAL_INLINE_TRANSLATE_ATTR } from "../../../packages/edit-core/canvas-position";
import { createPreviewAdapter } from "./lib/previewAdapter";
import { capturePresentedTimelineChanges } from "./lib/isolatedTimelineEdits";
import { setPreviewMediaMuted } from "./lib/timelineIframeHelpers";
import { usePlayerStore } from "./store/playerStore";
import { isHistoryGeometry } from "../../../shared/preview-timing";
import { PREVIEW_ATTRIBUTES, canPatchPreviewAttribute, PRESENTATION_STYLES, PRESENTATION_TAGS, readPreviewText, samePreviewText, isMountedCaptionBatch, type PreviewChange, type PreviewLiveEdits, isGradeOnlyChange, isAuthoredPresentation, isPaintOnlyChange, isPixelBoxChange, isMediaBoxChange, isLivePositionEdit, canPatchPresentationValue } from "../../../shared/preview-timing";

type FileSnapshot = { content: string; version: string };

// A WindowProxy survives navigation. Bind a request to the document that acknowledged the handshake.
const documents = new WeakMap<HTMLIFrameElement, { token: string; id: string; canRebind: boolean; canRefreshParked: boolean; mountedVersions: Map<string, string>; liveEdits: PreviewLiveEdits; timingFile?: { path: string; version: string } }>();
const historyDrafts = new WeakMap<HTMLIFrameElement, {documentId: string; path: string; mounted: string; visible: string; alternative: string}>();
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

export async function tryRefreshParkedPeerScene(frame: HTMLIFrameElement, path: string, version: string, isCurrent: () => boolean, parkedOnly = false) {
  return refreshPeerScenes(frame, [[path, version]], isCurrent, parkedOnly);
}

export async function refreshPeerScenes(frame: HTMLIFrameElement, files: [string, string][], isCurrent: () => boolean, parkedOnly = false) {
  const doc = documents.get(frame);
  if (!doc?.canRefreshParked || !isCurrent()) return false;
  const adapter = createPreviewAdapter({ iframe: frame });
  if (adapter.token !== doc.token) return false;
  const bases = files.map(([path]) => doc.mountedVersions.get(path));
  const timeout = 5000;
  const applied = await adapter.request<boolean>("refresh-parked-scene", {
    ...(files.length === 1 ? {path: files[0]![0], fileVersion: files[0]![1]} : {files}),
    documentId: doc.id, expiresAt: Date.now() + timeout, ...(parkedOnly && { parkedOnly }),
  }, timeout).catch(() => false);
  if (applied !== true || documents.get(frame) !== doc) return false;
  // A gesture may supersede the UI callback while the player is mounting this scene.
  // Keep the version it accepted, unless newer evidence already replaced that base.
  files.forEach(([path, version], index) => {
    if (doc.mountedVersions.get(path) === bases[index]) doc.mountedVersions.set(path, version);
  });
  return isCurrent();
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

/** A peer can bring storage back to the mounted version while a draft still overlays its pixels. */
export function reconcileMountedHistoryDraft(frame: HTMLIFrameElement, path: string, version: string, isCurrent: () => boolean) {
  const draft = historyDrafts.get(frame);
  if (!draft || draft.path !== path || draft.mounted !== version || draft.documentId !== documents.get(frame)?.id) return;
  return applyCommittedPeerChanges(frame, {path, previous:{content:draft.alternative,version}, current:{content:draft.visible,version}}, isCurrent, {historyRestore:true});
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
  // Direct BRs belong to the parent's text proof, not the clip insert/delete path.
  // The final whole-document comparison still catches every unconsumed element or attribute.
  return [...doc.querySelectorAll("*")].filter(node => node.localName !== 'br' || !presentationTags.has(node.parentElement?.localName ?? '')).flatMap(node =>
    node instanceof HTMLTemplateElement ? [node, ...elements(node.content)] : [node]);
}

const presentationTags = new Set<string>(PRESENTATION_TAGS);

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
  }
  if (styles.length > 1) {
    // Reproduce the author's declaration order, including a translate written before new dimensions.
    const order = new Map(Array.from(next, (name, i) => [name, i] as const));
    styles.sort(([a], [b]) => (order.get(a) ?? -1) - (order.get(b) ?? -1));
  }
  for (const [name, , to] of styles) {
    if (to) projected.style.setProperty(name, to);
    else projected.style.removeProperty(name);
  }
  return styles.length && projected.style.cssText === next.cssText ? styles : null;
}

type BoxCapabilities = { measured?: boolean; mounted?: boolean; cssLayoutOffset?: boolean; position?: boolean };

/** Strip only supported changes, then compare the entire remaining document before touching the player. */
export function diffPreviewChanges(previous: string, current: string, box: BoxCapabilities = {}): PreviewChange[] | null {
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
      if (presentationTags.has(left.localName)) {
        const from = readPreviewText(left), to = readPreviewText(right);
        if (from !== null && to !== null && !samePreviewText(from, to)) {
          // A change of authorship on existing breaks is an attribute edit, not a caption.
          if (typeof from !== 'string' && typeof to !== 'string' &&
              (from.breaks.length === to.breaks.length ? from.breaks.some((id, i) => id !== to.breaks[i]) :
                from.breaks.some(id => id && !to.breaks.includes(id)) && to.breaks.some(id => id && !from.breaks.includes(id)))) return null;
          text = [from, to];
          left.replaceChildren();
          right.replaceChildren();
        }
      }
    }
    if (!attributes.length && !styles && !text) continue;
    const hfId = left.getAttribute("data-hf-id");
    const compositionId = left.getAttribute("data-composition-id");
    if (!hfId && !left.id && !compositionId) return null;
    const change = { hfId, id: left.id, compositionId, tag: left.localName, attributes, styles, text, captureOriginalTranslate };
    changes.push(change);
  }
  if (!changes.length || before.documentElement.outerHTML !== after.documentElement.outerHTML) return null;
  // Only verified geometry can preserve a media decoder or canvas drawing buffer.
  const caption = box.mounted && isMountedCaptionBatch(changes, !!box.position, !!box.cssLayoutOffset);
  for (const c of changes) if (!presentationTags.has(c.tag) && (c.styles || c.text) && !caption &&
      !isPaintOnlyChange(c) && !(box.measured && isMediaBoxChange(c)) && !(box.mounted && isPixelBoxChange(c)) &&
      !(box.cssLayoutOffset && isPixelBoxChange(c, true)) && !(c.tag === 'canvas' && isLivePositionEdit([c]))) return null;
  return changes;
}

/** The first visual edit persists the compiler's IDs; undo can return to the unstamped source. */
export async function diffMountedPreview(previous: string, current: string, box: BoxCapabilities = {}) {
  const changes = diffPreviewChanges(previous, current, box);
  if (changes) return changes;
  const before = previous.split("data-hf-id=").length, after = current.split("data-hf-id=").length;
  if (before === after) return null;
  const { ensureHfIds } = await import("@hyperframes/parsers/hf-ids");
  return before < after ? diffPreviewChanges(ensureHfIds(previous), current, box)
    : diffPreviewChanges(previous, ensureHfIds(current), box);
}

function onlyStyles(changes: PreviewChange[]) {
  return changes.every(change => change.styles && !change.attributes.length && !change.text);
}

export async function diffScriptedPreviewStyles(previous: string, current: string) {
  const changes = await diffMountedPreview(previous, current);
  return changes && onlyStyles(changes) ? changes : null;
}

export type PeerApplyOutcome = "applied" | "superseded" | "requires-scene-rebuild" | "unconfirmed";
type PeerApplyOptions = "paint-only" | "temporary" | "keep-visible" | { gestureId?: string; historyRestore?: boolean } | { historyDraftId: string } |
  { structureDraftId: string; onGroup?: (group: import("../../../shared/preview-group").GroupChange) => void };

/** Only a current, confirmed inability to paint authorizes scene recovery. */
export function applyCommittedPeerChanges(
  frame: HTMLIFrameElement | null,
  update: PeerTimingUpdate,
  isCurrent: () => boolean,
  options?: { gestureId?: string; historyRestore?: boolean },
): Promise<PeerApplyOutcome> {
  return applyPeerChanges(frame, update, isCurrent, options);
}

/** Compatibility for provisional paints and callers that only consume success. */
export async function tryApplyPeerChanges(
  frame: HTMLIFrameElement | null, update: PeerTimingUpdate, isCurrent: () => boolean, options?: PeerApplyOptions,
): Promise<boolean> {
  return await applyPeerChanges(frame, update, isCurrent, options) === "applied";
}

async function applyPeerChanges(
  frame: HTMLIFrameElement | null, update: PeerTimingUpdate, isCurrent: () => boolean, options?: PeerApplyOptions,
): Promise<PeerApplyOutcome> {
  if (!frame || !isCurrent()) return "superseded";
  const adapter = createPreviewAdapter({ iframe: frame });
  const document = documents.get(frame);
  if (adapter.sameOrigin) return "requires-scene-rebuild";
  if (!document || !adapter.projectId) return "unconfirmed";
  if (document.token !== adapter.token) return "superseded";
  const src = frame.src;
  const originalDraft = historyDrafts.get(frame);
  const sameDocument = () => documents.get(frame) === document && frame.src === src;
  const { previous, current } = update;
  const releasePresented = capturePresentedTimelineChanges(frame, update.path);
  // Several accepted toggles can bring the file back to the exact source already on screen.
  const sameContent = !options && document.canRebind && previous.content === current.content;
  const measured = typeof options === "object" && "gestureId" in options && !!options.gestureId;
  const cssLayoutOffset = document.canRebind || document.liveEdits.cssLayoutOffset === true;
  const mounted = document.mountedVersions.has(update.path);
  const changes = sameContent ? [] : await (options === "temporary" ? diffScriptedPreviewStyles(previous.content, current.content) :
    diffMountedPreview(previous.content, current.content, { measured, mounted, cssLayoutOffset, position: document.liveEdits.position })).catch(() => null);
  if (!sameDocument() || !isCurrent()) return "superseded";
  if (!changes || (options === "paint-only" && !changes.every(isPaintOnlyChange))) return "requires-scene-rebuild";
  const historyDraftId = typeof options === "object" && "historyDraftId" in options ? options.historyDraftId : undefined;
  if (historyDraftId && !isHistoryGeometry(changes)) return "requires-scene-rebuild";
  const nestedBox = mounted && changes.length > 0 && changes.every(change => isPixelBoxChange(change));
  const caption = mounted && isMountedCaptionBatch(changes, !!document.liveEdits.position, cssLayoutOffset);
  const grade = changes.length > 0 && changes.every(isGradeOnlyChange);
  const cssBox = cssLayoutOffset && changes.length > 0 && changes.every(change => isPixelBoxChange(change, true));
  const canAdvance = grade || nestedBox || caption || cssBox || document.canRebind || (document.liveEdits.presentation && isAuthoredPresentation(changes)) || (measured && changes.length === 1 && isMediaBoxChange(changes[0]!)) || (document.liveEdits.position && (isLivePositionEdit(changes) || changes.every(isPaintOnlyChange))) ||
    (document.liveEdits.mediaTiming && isLiveMediaMove(changes)) ||
    (document.liveEdits.audioTrimV1 && update.path === 'index.html' && isLiveAudioTrim(changes));
  const temporary = options === "temporary" || (!canAdvance && options === "keep-visible");
  if (temporary && (document.canRebind || !onlyStyles(changes))) return "requires-scene-rebuild";
  if (!temporary && !canAdvance) return "requires-scene-rebuild";
  const draftId = typeof options === "object" && "structureDraftId" in options ? options.structureDraftId : undefined;
  if (draftId && (!document.canRebind || !changes.some(change => change.removeFromComposition || change.insert || change.group))) return "requires-scene-rebuild";
  const historyRestore = typeof options === "object" && "historyRestore" in options && options.historyRestore;
  const localSave = typeof options === "object" && !("structureDraftId" in options) && !("historyDraftId" in options) && !historyRestore ? options : undefined;
  const presentation = changes.some(c => c.styles || c.text);
  const mediaControl = !presentation && !!document.canRebind && changes.length > 0 && changes.every(c =>
    (c.tag === "audio" || c.tag === "video") && c.attributes.length > 0 &&
    c.attributes.every(([name]) => ["data-media-start", "data-playback-start", "loop", "data-playback-rate"].includes(name)));
  if (localSave && !mediaControl && (!presentation || changes.some(c => c.attributes.length))) return "requires-scene-rebuild";
  const timeout = 350;
  const sentFrom = document.mountedVersions.get(update.path);
  try {
    const paint = adapter.request<boolean>(presentation ? "peer-presentation" : "peer-timing", {
      documentId: document.id, path: update.path, before: update.previous.version, after: update.current.version,
      changes, ...(sameContent && { sameContent: true }), ...(draftId && { structureDraftId: draftId }),
      ...(historyDraftId && { historyDraftId }), ...(historyRestore && { historyRestore: true }),
      ...(temporary && { temporary: true }), ...(localSave && { localSave: true, gestureId: localSave.gestureId }), expiresAt: Date.now() + timeout,
    }, timeout);
    // A provisional style can paint in parallel with the authoritative script rebuild.
    if (temporary && options === "keep-visible") {
      void paint.catch(() => {});
      return "requires-scene-rebuild";
    }
    // A busy player can apply an edit before Studio receives its reply. Verify the
    // mounted revision without performing the mutation a second time.
    const applied = await paint.catch(async () => {
      if (temporary || draftId || historyDraftId || previous.version === current.version || !sameDocument()) return undefined;
      const version = await adapter.request<unknown>("mounted-file-version", { documentId: document.id, path: update.path });
      if (typeof version !== "string" || !version) return undefined;
      return version === current.version;
    });
    if (!sameDocument()) return "superseded";
    // A newer gesture supersedes an old paint's UI side effects, but its next
    // patch still needs to know which source the live frame actually accepted.
    const lastKnown = document.mountedVersions.get(update.path);
    if (!temporary && !draftId && !historyDraftId) {
      if (lastKnown !== sentFrom && lastKnown !== previous.version && lastKnown !== current.version) return "superseded";
      if (applied === true) document.mountedVersions.set(update.path, current.version);
    }
    if (!isCurrent()) return "superseded";
    if (applied === false) return "requires-scene-rebuild";
    if (applied !== true) return "unconfirmed";
    if (historyDraftId) return "applied";
    if (!temporary && !draftId && originalDraft?.path === update.path && historyDrafts.get(frame) === originalDraft) historyDrafts.delete(frame);
    if (draftId) {
      const group = changes[0]?.group;
      if (group && typeof options === "object" && "structureDraftId" in options) options.onGroup?.(group);
      return "applied";
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
    return "applied";
  } catch { return sameDocument() && isCurrent() ? "unconfirmed" : "superseded"; }
}

/** A scoped frame can project geometry while its file still has the displayed revision. */
export function stagePeerHistoryGeometry(frame: HTMLIFrameElement, path: string, previous: string, restored: string, version: string, mountedContent: string) {
  const doc = documents.get(frame);
  if (!doc || doc.mountedVersions.get(path) !== version) return;
  const adapter = createPreviewAdapter({ iframe: frame });
  const historyDraftId = crypto.randomUUID();
  const draft = {documentId:doc.id, path, mounted:version, visible:mountedContent, alternative:mountedContent === restored ? previous : restored};
  historyDrafts.set(frame, draft);
  let active = true;
  const current = () => active && frame.isConnected && documents.get(frame) === doc;
  void tryApplyPeerChanges(frame, {path, previous: {content: previous, version}, current: {content: restored, version}}, current, {historyDraftId});
  const discard = () => {
    active = false;
    if (historyDrafts.get(frame) === draft) historyDrafts.delete(frame);
    if (frame.isConnected && documents.get(frame) === doc)
      adapter.send("peer-timing", {documentId: doc.id, path, discardDraftId: historyDraftId});
  };
  discard.supersede = () => { active = false; };
  return discard;
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
