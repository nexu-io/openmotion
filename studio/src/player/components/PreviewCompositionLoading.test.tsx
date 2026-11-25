// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanupMounted, mountHost } from "../../components/ui/mountHost.testHelpers";
import { usePlayerStore } from "../store/playerStore";
import { PreviewCompositionLoading } from "./PreviewCompositionLoading";

const filename = "夜の街 — opening shot.mp4";

afterEach(() => {
  cleanupMounted();
  usePlayerStore.setState(usePlayerStore.getInitialState(), true);
});

it("updates the same live status when the player starts a generation after mount", () => {
  const generation = { current: 0 };
  const host = mountHost(<PreviewCompositionLoading assetGeneration={generation} />);
  const status = host.querySelector('[role="status"]')!;
  const label = document.getElementById(status.getAttribute("aria-labelledby")!)!;
  expect(status.getAttribute("aria-live")).toBe("polite");
  expect(label.textContent).toBe("Loading preview…");
  expect(label.closest(".sr-only")).toBeNull();

  act(() => {
    generation.current = usePlayerStore.getState().beginAssetReadinessLoad();
    usePlayerStore.getState().updateAssetReadiness({
      status: "loading", total: 2, completed: 1, failed: [], pendingAsset: filename,
    }, generation.current);
  });
  expect(label.textContent).toBe("Preparing preview assets");
  expect(label.nextElementSibling?.textContent).toBe(filename);
  expect(label.nextElementSibling?.closest(".sr-only")).toBeNull();

  act(() => usePlayerStore.getState().skipAssetReadiness());
  expect(status.textContent).toBe("Loading preview…");
});

it.each([
  { current: undefined, phase: "loading", name: filename },
  { current: 2, phase: "loading", name: filename },
  { current: 1, phase: "ready", name: filename },
  { current: 1, phase: "loading", name: "   " },
] as const)("uses the generic status for $current, $phase, '$name'", ({ current, phase, name }) => {
  usePlayerStore.setState({ assetReadinessGeneration: 1, assetReadinessPhase: phase, assetReadinessPendingAsset: name });
  const host = mountHost(<PreviewCompositionLoading assetGeneration={current === undefined ? undefined : { current }} />);
  expect(host.textContent).toBe("Loading preview…");
});

it("keeps both status lines screen-reader-only during a quiet switch", () => {
  usePlayerStore.setState({ assetReadinessGeneration: 1, assetReadinessPendingAsset: filename });
  const host = mountHost(<PreviewCompositionLoading showMark={false} assetGeneration={{ current: 1 }} />);
  const status = host.querySelector('[role="status"]')!;
  expect(status.querySelector(".motion-preview-loading-mark")).toBeNull();
  expect(status.querySelector(".sr-only")?.textContent).toBe(`Preparing preview assets${filename}`);
});
