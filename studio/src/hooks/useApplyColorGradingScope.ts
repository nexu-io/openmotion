import { useCallback } from "react";
import { useStudioShellContext } from "../contexts/StudioContext";
import { useDomEditContext } from "../contexts/DomEditContext";
import { useFileManagerContext } from "../contexts/FileManagerContext";
import {
  applyColorGradingScopeUpdate,
  EMPTY_COLOR_GRADING_SCOPE_RESULT,
  type ColorGradingScope,
} from "../components/studioColorGradingScope";
import type { StudioRightPanelsProps } from "../components/StudioRightPanels.types";

export function useApplyColorGradingScope(
  recordEdit: StudioRightPanelsProps["recordEdit"],
  reloadPreview: StudioRightPanelsProps["reloadPreview"],
) {
  const { projectId, activeCompPath, previewIframeRef, showToast, waitForPendingDomEditSaves } =
    useStudioShellContext();
  const { domEditSelection } = useDomEditContext();
  const { readProjectFile, writeProjectFile, compositions } = useFileManagerContext();
  return useCallback(
    async (scope: ColorGradingScope, value: string | null) =>
      applyColorGradingScopeUpdate({
        scope,
        value,
        selectedSourceFile: domEditSelection?.sourceFile || activeCompPath || "index.html",
        compositionPaths: compositions,
        projectId,
        frame: previewIframeRef.current,
        activePath: activeCompPath ?? "index.html",
        waitForPendingDomEditSaves,
        readProjectFile,
        writeProjectFile,
        recordEdit,
        reloadPreview,
        showToast,
      }).catch((error) => {
        showToast(
          `Couldn't apply color grading: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return EMPTY_COLOR_GRADING_SCOPE_RESULT;
      }),
    [
      activeCompPath,
      compositions,
      previewIframeRef,
      domEditSelection?.sourceFile,
      projectId,
      readProjectFile,
      recordEdit,
      reloadPreview,
      showToast,
      waitForPendingDomEditSaves,
      writeProjectFile,
    ],
  );
}
