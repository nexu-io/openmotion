// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { saveCanvasDrag } from "./saveCanvasDrag";

const saved = (savedCanvasVersion?: string) => ({ durable: true, changed: true, allMatched: true, savedCanvasVersion });

it("submits each dependent measurement on the previous verified version", async () => {
  const frame = document.createElement("iframe");
  let release!: (value: ReturnType<typeof saved>) => void;
  const first = saveCanvasDrag(frame, "a", "1", undefined, () => new Promise(resolve => { release = resolve; }));
  const writeSecond = vi.fn(async () => saved("v3"));
  const writeThird = vi.fn(async () => saved("v4"));
  const second = saveCanvasDrag(frame, "a", "2", "1", writeSecond);
  const third = saveCanvasDrag(frame, "a", "3", "2", writeThird);
  expect(writeSecond).not.toHaveBeenCalled();
  expect(writeThird).not.toHaveBeenCalled();
  release(saved("v2"));
  await Promise.all([first, second, third]);
  expect(writeSecond).toHaveBeenCalledWith("v2");
  expect(writeThird).toHaveBeenCalledWith("v3");
});

it("drops descendants after a conflict or an unverified source write", async () => {
  const frame = document.createElement("iframe");
  const write = vi.fn(async () => saved("unexpected"));
  const conflict = saveCanvasDrag(frame, "a", "1", undefined, async () => { throw new Error("409"); });
  const second = saveCanvasDrag(frame, "a", "2", "1", write);
  const third = saveCanvasDrag(frame, "a", "3", "2", write);
  await expect(conflict).rejects.toThrow("409");
  expect(await second).toBeUndefined();
  expect(await third).toBeUndefined();
  await saveCanvasDrag(frame, "a", "4", undefined, async () => saved());
  expect(await saveCanvasDrag(frame, "a", "5", "4", write)).toBeUndefined();
  expect(write).not.toHaveBeenCalled();
});

it("continues a settled local version on the same displayed source and respects a separately updated frame", async () => {
  const frame = document.createElement("iframe");
  const write = vi.fn(async () => saved("v3"));
  await saveCanvasDrag(frame, "a", "1", undefined, async () => saved("v2"), "v1");
  await saveCanvasDrag(frame, "a", "2", undefined, write, "v1");
  expect(write).toHaveBeenLastCalledWith("v2");
  await saveCanvasDrag(frame, "a", "3", undefined, write, "v4");
  expect(write).toHaveBeenLastCalledWith();
});
