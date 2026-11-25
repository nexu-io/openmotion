// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanupMounted, mountHost } from "../../components/ui/mountHost.testHelpers";
import { usePlayerStore } from "../store/playerStore";
import { PreviewCompositionLoading } from "./PreviewCompositionLoading";

const filename = "夜の街 — opening shot.mp4";
const title = "Preparing preview assets";
const firstFrameTitle = "Preparing the first preview frame";
const genericHint = "The preview will appear when it is ready.";
const editingHint = "You can keep editing while the preview loads.";
const downloadHint = "Downloading this file for playback.";

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
  expect(label.textContent).toBe(firstFrameTitle);
  expect(label.nextElementSibling?.textContent).toBe(genericHint);
  expect(label.closest(".sr-only")).toBeNull();

  act(() => {
    generation.current = usePlayerStore.getState().beginAssetReadinessLoad();
    usePlayerStore.getState().updateAssetReadiness({
      status: "loading", total: 2, completed: 1, failed: [], pendingAsset: filename,
    }, generation.current);
  });
  expect(label.textContent).toBe(title);
  expect(label.nextElementSibling?.textContent).toBe(filename);
  expect(label.nextElementSibling?.closest(".sr-only")).toBeNull();

  act(() => usePlayerStore.getState().skipAssetReadiness());
  expect(status.textContent).toBe(`${firstFrameTitle}${genericHint}`);
  expect(label.nextElementSibling?.textContent).toBe(genericHint);
});

it.each([
  { current: undefined, phase: "loading", name: filename },
  { current: 2, phase: "loading", name: filename },
  { current: 1, phase: "ready", name: filename },
  { current: 1, phase: "loading", name: "   " },
] as const)("uses the generic status for $current, $phase, '$name'", ({ current, phase, name }) => {
  usePlayerStore.setState({ assetReadinessGeneration: 1, assetReadinessPhase: phase, assetReadinessPendingAsset: name });
  const host = mountHost(<PreviewCompositionLoading canEditWhileLoading assetGeneration={current === undefined ? undefined : { current }} />);
  expect(host.textContent).toBe(`${firstFrameTitle}${editingHint}`);
  expect(host.querySelector('[dir="auto"]')).toBeNull();
});

it("keeps the status and download hint screen-reader-only during a quiet switch", () => {
  usePlayerStore.setState({ assetReadinessGeneration: 1, assetReadinessPendingAsset: filename });
  const host = mountHost(<PreviewCompositionLoading showMark={false} assetGeneration={{ current: 1 }} />);
  const status = host.querySelector('[role="status"]')!;
  expect(status.querySelector(".motion-preview-loading-mark")).toBeNull();
  expect(status.querySelector(".sr-only")?.textContent).toBe(`${title}${filename}${downloadHint}`);
});

it.each([true, false])("uses Studio theme tokens for the entire cover with showMark=%s", showMark => {
  usePlayerStore.setState({ assetReadinessGeneration: 1, assetReadinessPendingAsset: filename });
  const host = mountHost(<PreviewCompositionLoading showMark={showMark} assetGeneration={{ current: 1 }} />);
  const status = host.querySelector('[role="status"]')!;
  expect(status.classList.contains("inset-0")).toBe(true);
  expect(status.classList.contains("bg-[var(--motion-canvas)]")).toBe(true);
  expect(status.classList.contains("text-[color:var(--motion-strong)]")).toBe(true);
  const file = status.querySelector('[dir="auto"]')!;
  expect(file.classList.contains("text-[color:var(--motion-text)]")).toBe(true);
  expect(file.nextElementSibling?.classList.contains("text-[color:var(--motion-muted)]")).toBe(true);
});

it.each([true, false, undefined])("describes the download when edit eligibility is %s", canEditWhileLoading => {
  const longName = "很长的文件名".repeat(50) + ".mp4";
  usePlayerStore.setState({ assetReadinessGeneration: 1, assetReadinessPendingAsset: longName });
  const host = mountHost(<PreviewCompositionLoading canEditWhileLoading={canEditWhileLoading} assetGeneration={{ current: 1 }} />);
  const file = host.querySelector('[dir="auto"]')!;
  expect(file.textContent).toBe(longName);
  expect(file.getAttribute("title")).toBe(longName);
  expect(file.classList.contains("truncate")).toBe(true);
  expect(file.nextElementSibling?.textContent).toBe(canEditWhileLoading ? `${downloadHint} You can keep editing.` : downloadHint);
});
