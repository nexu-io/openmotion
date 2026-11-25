// @vitest-environment happy-dom
import React, { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { installReactActEnvironment, mountReactHarness } from "./domSelectionTestHarness";
import { usePlayerStore } from "../player/store/playerStore";
import { loadRenderQueue, loadTranscript } from "../components/studioPanelImports";
import { loadCreativeMediaMenu, loadWorkspaceSearchResults } from "../motion/workspaceFeatureImports";
import { scheduleIdlePreloads } from "../utils/idlePreload";
import { useWarmStudioFeatures } from "./useWarmStudioFeatures";

installReactActEnvironment();
vi.mock("../utils/idlePreload", () => ({ scheduleIdlePreloads: vi.fn(() => vi.fn()) }));
vi.mock("../utils/cloudFeatures", () => ({ useCloudFeatureEnabled: () => false }));
afterEach(() => { usePlayerStore.getState().reset(); vi.clearAllMocks(); });

it("waits for a real paint and timeline, cancels on leaving, and gates cloud-only or disabled features", () => {
  let paint!: () => void;
  function Harness({ project, workspace }: { project: string; workspace: boolean }) {
    paint = useWarmStudioFeatures(project, workspace);
    return null;
  }
  const plan = vi.mocked(scheduleIdlePreloads);
  usePlayerStore.setState({ timelineProjectId: "A", previewBooted: true, timelineReady: true });
  const root = mountReactHarness(<Harness project="A" workspace />);
  expect(plan).not.toHaveBeenCalled();
  act(paint);
  expect(plan).toHaveBeenLastCalledWith([loadRenderQueue, loadWorkspaceSearchResults, loadCreativeMediaMenu]);
  const cancel = plan.mock.results[0]!.value;
  act(() => root.render(<Harness project="B" workspace={false} />));
  expect(cancel).toHaveBeenCalledOnce();
  act(paint);
  expect(plan).toHaveBeenCalledTimes(1);
  act(() => usePlayerStore.setState({ timelineProjectId: "B", timelineReady: true }));
  expect(plan).toHaveBeenLastCalledWith([loadRenderQueue]);
  expect(plan.mock.calls.flatMap(([loaders]) => loaders)).not.toContain(loadTranscript);
  act(() => root.render(<Harness project="A" workspace />));
  act(() => usePlayerStore.setState({ timelineProjectId: "A", timelineReady: true }));
  expect(plan).toHaveBeenCalledTimes(2);
  act(() => root.unmount());
});
