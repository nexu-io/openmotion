import { saveTimelineFiles } from "../utils/orderedTimelineEdits";
import { supportsProjectTextEdits, supportsOrderedTextEdits, confirmedSource } from "../utils/confirmedTextSources";
import { scheduleCommittedTimelinePreview } from "../player/committedTimelinePreview";
import { projectColorGrade } from "./studioColorGradingPreview";
import { patchMediaColorGradingInHtml } from "./editor/colorGradingScopePatch";
import { hasRelativeLutSource } from "./studioMediaJobs";

export type ColorGradingScope = "source-file" | "project";
export type ColorGradingScopeResult = { changedFiles: number; changedElements: number };

type ProjectFileReader = (path: string) => Promise<string>;
type ProjectFileWriter = (path: string, content: string) => Promise<void>;
type ShowToast = (message: string, tone?: "error" | "info") => void;
type RecordEdit = (entry: {
  label: string;
  files: Record<string, { before: string; after: string }>;
}) => Promise<void>;

export const EMPTY_COLOR_GRADING_SCOPE_RESULT: ColorGradingScopeResult = {
  changedFiles: 0,
  changedElements: 0,
};

interface ApplyColorGradingScopeOptions {
  scope: ColorGradingScope;
  value: string | null;
  selectedSourceFile: string;
  compositionPaths: string[];
  projectId: string;
  frame?: HTMLIFrameElement | null;
  activePath?: string;
  waitForPendingDomEditSaves: () => Promise<void>;
  readProjectFile: ProjectFileReader;
  writeProjectFile: ProjectFileWriter;
  recordEdit: RecordEdit;
  reloadPreview: () => void;
  showToast: ShowToast;
}

function colorGradingScopePaths(
  scope: ColorGradingScope,
  selectedSourceFile: string,
  compositionPaths: string[],
): string[] {
  return scope === "source-file" ? [selectedSourceFile] : compositionPaths;
}

// fallow-ignore-next-line complexity
export async function applyColorGradingScopeUpdate({
  scope,
  value,
  selectedSourceFile,
  compositionPaths,
  projectId,
  frame,
  activePath = "index.html",
  waitForPendingDomEditSaves,
  readProjectFile,
  writeProjectFile,
  recordEdit,
  reloadPreview,
  showToast,
}: ApplyColorGradingScopeOptions): Promise<ColorGradingScopeResult> {
  if (scope === "project" && hasRelativeLutSource(value)) {
    showToast(
      "Project-wide color grading cannot copy relative LUT paths. Apply to this file or use a URL/data LUT.",
      "error",
    );
    return EMPTY_COLOR_GRADING_SCOPE_RESULT;
  }

  const counts = new Map<string, number>();
  const patchGrading = (path: string) => (before: string) => {
    const result = patchMediaColorGradingInHtml(before, value);
    counts.set(path, result.count);
    return result.html;
  };
  const paths = colorGradingScopePaths(scope, selectedSourceFile, compositionPaths);
  const ordered = supportsOrderedTextEdits(projectId);
  const local = ordered || supportsProjectTextEdits(projectId);
  if (!ordered) await waitForPendingDomEditSaves();
  let projection: ReturnType<typeof projectColorGrade> | undefined;
  const changedPaths = await saveTimelineFiles({
    projectId,
    label: value ? "Apply color grading" : "Clear color grading",
    files: Object.fromEntries(paths.map((path) => [path, patchGrading(path)])),
    readFile: async path => (local ? confirmedSource(projectId, path)?.content : undefined) ?? readProjectFile(path),
    projectPending: frame && ordered ? files => {
      projection = projectColorGrade(frame, activePath, files);
      return () => projection?.settle(false);
    } : undefined,
    onSaved: async (files, previous, bases) => {
      projection?.settle(true);
      if (frame?.isConnected && ordered && !frame.contentDocument) {
        scheduleCommittedTimelinePreview(frame, projectId, activePath, files, previous, reloadPreview, bases);
      } else if (!projection?.complete || !frame?.isConnected) reloadPreview();
    },
    writeFile: writeProjectFile,
    recordEdit,
  }, local);
  if (changedPaths.length === 0) {
    showToast("No color grading changed", "info");
    return EMPTY_COLOR_GRADING_SCOPE_RESULT;
  }
  const changedElements = Array.from(counts.values()).reduce((sum, n) => sum + n, 0);
  showToast(
    `${value ? "Applied" : "Cleared"} color grading on ${changedElements} media item${changedElements === 1 ? "" : "s"}`,
    "info",
  );
  return { changedFiles: changedPaths.length, changedElements };
}
