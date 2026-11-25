import { componentOverlaySource } from "../../../shared/registry-material-compat";
import { buildProjectApiPath } from "./projectRouting";
import type { RegistryItem } from "@hyperframes/core/registry";
import type { TimelineElement } from "../player";
import {
  insertTimelineAssetIntoSource,
  resolveTimelineAssetCompositionSize,
  resolveTimelineAssetSrc,
} from "./timelineAssetDrop";
import { collectHtmlIds } from "./studioHelpers";
import { generateId } from "./generateId";
import { formatTimelineAttributeNumber } from "../player/components/timelineEditing";
import { saveProjectFilesWithHistory } from "./studioFileHistory";
import { serializeStudioFileMutation } from "./studioFileMutationCoordinator";
import { extendRootDurationInSource } from "./rootDuration";
import { deriveTimelineStoreKeyForDomId } from "../player/lib/timelineElementHelpers";
import { resolveDropTrack, topTrackZIndex } from "./timelineDropTrackInsert";
import { usePlayerStore } from "../player";
import { studioApiFetch } from "./studioApiFetch";
import { DEFAULT_COMPOSITION_DURATION_SECONDS, MIN_TIMELINE_CLIP_DURATION_SECONDS } from "../../../packages/edit-core/time-bounds";
import { cachedMotionComponent } from "../hooks/useBlockCatalog";
import { placeCatalogComponent } from "./studioTextEdits";
import { supportsOrderedTextEdits } from "./confirmedTextSources";
import { roundToCenti } from "./rounding";

function getMaxZIndexFromIframe(iframe: HTMLIFrameElement | null): number {
  try {
    const doc = iframe?.contentDocument;
    if (!doc) return 0;
    let max = 0;
    for (const el of doc.body.querySelectorAll("*")) {
      const z = parseInt(getComputedStyle(el).zIndex, 10);
      if (Number.isFinite(z) && z > max) max = z;
    }
    return max;
  } catch {
    return 0;
  }
}

interface AddBlockOptions {
  projectId: string;
  blockName: string;
  activeCompPath: string | null;
  placement?: { start: number; duration?: number; track?: number; newTrack?: "top" };
  visualPosition?: { left: number; top: number };
  previewIframe?: HTMLIFrameElement | null;
  currentTime?: number;
  timelineElements: TimelineElement[];
  readProjectFile: (path: string) => Promise<string>;
  writeProjectFile: (path: string, content: string) => Promise<void>;
  recordEdit: (entry: {
    label: string;
    coalesceKey?: string;
    files: Record<string, { before: string; after: string }>;
  }) => Promise<void>;
  refreshFileTree: () => Promise<void>;
  reloadPreview: () => void;
  showToast: (msg: string) => void;
}

function buildUniqueCompositionId(baseName: string, existingIds: Iterable<string>): string {
  const idSet = new Set(existingIds);
  if (!idSet.has(baseName)) return baseName;
  let i = 2;
  while (idSet.has(`${baseName}_${i}`)) i++;
  return `${baseName}_${i}`;
}

async function installRegistryItem({
  projectId,
  blockName,
  showToast,
}: Pick<AddBlockOptions, "projectId" | "blockName" | "showToast">): Promise<{
  block: RegistryItem;
  compositionFile: string;
} | null> {
  const response = await studioApiFetch(buildProjectApiPath(projectId, `/registry/install`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blockName }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Install failed" }));
    showToast((error as { error?: string }).error || "Failed to install block");
    return null;
  }
  const { written, block } = (await response.json()) as {
    written: string[];
    block: RegistryItem;
  };
  const compositionFile = written.find((file) => file.endsWith(".html")) ?? written[0];
  if (!compositionFile) {
    showToast("Installed but no composition file was written");
    return null;
  }
  return { block, compositionFile };
}

async function makeComponentBackgroundTransparent(
  block: RegistryItem,
  compositionFile: string,
  readProjectFile: AddBlockOptions["readProjectFile"],
  writeProjectFile: AddBlockOptions["writeProjectFile"],
): Promise<void> {
  if (block.type !== "hyperframes:component") return;
  await serializeStudioFileMutation(writeProjectFile, compositionFile, async () => {
    const content = await readProjectFile(compositionFile);
    const transparentContent = componentOverlaySource(content);
    if (transparentContent !== content) await writeProjectFile(compositionFile, transparentContent);
  });
}

function resolveBlockPlacement({
  block,
  placement,
  timelineElements,
  currentTime,
}: {
  block: RegistryItem;
  placement: AddBlockOptions["placement"];
  timelineElements: TimelineElement[];
  currentTime: number;
}) {
  const isBlock = block.type === "hyperframes:block";
  const {
    start: placementStart = currentTime,
    duration: placementDuration,
    track: placementTrack,
  } = placement ?? {};
  const start = Number(formatTimelineAttributeNumber(placementStart));
  const blockDuration = "duration" in block ? (block as { duration: number }).duration : undefined;
  const contentEnd = timelineElements.reduce(
    (end, element) => Math.max(end, (element.start ?? 0) + (element.duration ?? 0)),
    0,
  );
  const remaining = roundToCenti(contentEnd - start);
  const duration = placementDuration ?? blockDuration ??
    (remaining > 0 ? Math.max(remaining, MIN_TIMELINE_CLIP_DURATION_SECONDS) : DEFAULT_COMPOSITION_DURATION_SECONDS);
  const nextTrack = Math.max(0, ...timelineElements.map((element) => element.track)) + 1;
  const track = placementTrack ?? (isBlock ? 0 : nextTrack);
  return { duration, isBlock, start, track };
}

function buildSubCompositionHtml({
  id,
  hfId,
  compositionFile,
  start,
  duration,
  track,
  width,
  height,
  left,
  top,
  zIndex,
}: {
  id: string;
  hfId: string;
  compositionFile: string;
  start: number;
  duration: number;
  track: number;
  width: number;
  height: number;
  left: number;
  top: number;
  zIndex: number;
}): string {
  return [
    `<div`,
    `  id="${id}"`,
    `  data-hf-id="${hfId}"`,
    `  data-composition-id="${id}"`,
    `  data-composition-src="${compositionFile}"`,
    `  data-start="${formatTimelineAttributeNumber(start)}"`,
    `  data-duration="${formatTimelineAttributeNumber(duration)}"`,
    `  data-track-index="${track}"`,
    `  data-width="${width}"`,
    `  data-height="${height}"`,
    `  style="position: absolute; left: ${left}px; top: ${top}px; width: ${width}px; height: ${height}px; z-index: ${zIndex}"`,
    `></div>`,
  ].join("\n");
}

export async function addBlockToProject(
  opts: AddBlockOptions,
): Promise<{ block: RegistryItem; compositionPath: string; hostKey: string; element: TimelineElement } | null> {
  const {
    projectId,
    blockName,
    activeCompPath,
    placement,
    visualPosition,
    timelineElements,
    readProjectFile,
    writeProjectFile,
    recordEdit,
    refreshFileTree,
    reloadPreview,
    showToast,
  } = opts;

  try {
    const card = cachedMotionComponent(blockName);
    const installed = card?.compositionFile
      ? { block: card, compositionFile: card.compositionFile }
      : await installRegistryItem({ projectId, blockName, showToast });
    if (!installed) return null;
    const { block, compositionFile } = installed;
    if (!card) await makeComponentBackgroundTransparent(block, compositionFile, readProjectFile, writeProjectFile);

    const targetPath = activeCompPath || "index.html";
    const relevantElements = timelineElements
      .filter(element => (element.sourceFile || targetPath) === targetPath)
      .map(element => ({ ...element, sourceFile: targetPath }));
    const { duration, isBlock, start, track: initialTrack } = resolveBlockPlacement({
      block,
      placement,
      timelineElements: relevantElements,
      currentTime: opts.currentTime ?? 0,
    });
    let track = initialTrack;
    let zIndex = getMaxZIndexFromIframe(opts.previewIframe ?? null) + 1;
    let hostId = "";
    const hfId = `hf-${generateId()}`;
    const insertHost = (originalContent: string) => {
      const { width, height } = resolveTimelineAssetCompositionSize(originalContent);
      hostId = buildUniqueCompositionId(block.name, collectHtmlIds(originalContent));
      if (placement?.newTrack === "top") {
        const placed = usePlayerStore.getState().pendingAssetDrops.flatMap(drop =>
          drop.element && (drop.element.sourceFile || targetPath) === targetPath ? [drop.element] : [],
        );
        zIndex = Math.max(zIndex, topTrackZIndex(originalContent, [...relevantElements, ...placed]));
        const resolved = resolveDropTrack({
          source: originalContent, elements: relevantElements, placed,
          placement: { start, track, newTrack: "top" },
          dropped: { id: hostId, tag: "div", start, duration },
        });
        originalContent = resolved.source;
        track = resolved.track;
      }
      const subComposition = buildSubCompositionHtml({
        id: hostId, hfId,
        compositionFile: resolveTimelineAssetSrc(targetPath, compositionFile),
        start,
        duration,
        track,
        width,
        height,
        left: visualPosition ? Math.round(visualPosition.left) : 0,
        top: visualPosition ? Math.round(visualPosition.top) : 0,
        zIndex,
      });
      return extendRootDurationInSource(
        insertTimelineAssetIntoSource(originalContent, subComposition),
        start + duration,
      );
    };
    const label = `Add ${isBlock ? "block" : "component"}: ${block.title}`;
    if (card) {
      const place = () => placeCatalogComponent(projectId, targetPath, blockName, label, insertHost);
      if (supportsOrderedTextEdits(projectId)) await place();
      else await serializeStudioFileMutation(writeProjectFile, targetPath, place);
    } else {
      await saveProjectFilesWithHistory({
        projectId, label, files: { [targetPath]: insertHost }, readFile: readProjectFile,
        writeFile: writeProjectFile, recordEdit,
      });
    }

    await refreshFileTree();
    reloadPreview();

    const hostKey = deriveTimelineStoreKeyForDomId(hostId, targetPath);
    return {
      block,
      compositionPath: compositionFile,
      hostKey,
      element: { id: hostKey, key: hostKey, domId: hostId, sourceFile: targetPath,
        tag: "div", start, duration, track, authoredTrack: track, zIndex, compositionSrc: compositionFile },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to add block";
    showToast(message);
    return null;
  }
}
