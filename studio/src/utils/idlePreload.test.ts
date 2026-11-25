// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { scheduleIdlePreloads } from "./idlePreload";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestIdleCallback", undefined);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("waits for idle and the previous download, then continues past a failed import", async () => {
  let reject!: (error: Error) => void;
  const first = vi.fn(() => new Promise<void>((_, failed) => { reject = failed; }));
  const second = vi.fn(async () => {});
  const dispose = scheduleIdlePreloads([first, second]);
  expect(first).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
  reject(new Error("offline"));
  await vi.runAllTimersAsync();
  expect(second).toHaveBeenCalledOnce();
  dispose();
});

it("drops the remaining downloads on navigation and avoids speculative data-saver traffic", async () => {
  const load = vi.fn(async () => {});
  scheduleIdlePreloads([load])();
  await vi.runAllTimersAsync();
  expect(load).not.toHaveBeenCalled();
  vi.stubGlobal("navigator", { connection: { saveData: true } });
  scheduleIdlePreloads([load]);
  await vi.runAllTimersAsync();
  expect(load).not.toHaveBeenCalled();
});

it("waits until a background tab becomes visible", async () => {
  const visibility = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const load = vi.fn(async () => {});
  const dispose = scheduleIdlePreloads([load]);
  await vi.runAllTimersAsync();
  expect(load).not.toHaveBeenCalled();
  visibility.mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.runAllTimersAsync();
  expect(load).toHaveBeenCalledOnce();
  dispose();
});

it("waits for window load plus delayMs before scheduling speculative downloads, and cancels cleanly on dispose", async () => {
  const readyState = vi.spyOn(document, "readyState", "get").mockReturnValue("interactive");
  const load = vi.fn(async () => {});
  const dispose = scheduleIdlePreloads([load], { delayMs: 4000 });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(load).not.toHaveBeenCalled();

  readyState.mockReturnValue("complete");
  window.dispatchEvent(new Event("load"));
  await vi.advanceTimersByTimeAsync(3999);
  expect(load).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(load).toHaveBeenCalledOnce();
  dispose();

  const cancelled = vi.fn(async () => {});
  const stop = scheduleIdlePreloads([cancelled], { delayMs: 4000 });
  await vi.advanceTimersByTimeAsync(2000);
  stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect(cancelled).not.toHaveBeenCalled();
});
