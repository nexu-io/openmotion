// @vitest-environment happy-dom
import { act, Suspense } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { installReactActEnvironment, mountReactHarness } from "../hooks/domSelectionTestHarness";
import { preloadableComponent } from "./preloadableComponent";

installReactActEnvironment();
afterEach(() => { document.body.innerHTML = ""; });

it("opens an already warmed view synchronously without flashing the fallback", async () => {
  const importer = vi.fn(async () => ({ default: ({ title }: { title: string }) => <b>{title}</b> }));
  const { load, Component } = preloadableComponent(importer);
  await load();
  const root = mountReactHarness(<Suspense fallback="loading"><Component title="export" /></Suspense>);
  expect(document.body.textContent).toBe("export");
  expect(importer).toHaveBeenCalledOnce();
  act(() => root.unmount());
});

it("uses Suspense for a cold view and keeps its contents when the parent rerenders", async () => {
  const view = { default: () => <input defaultValue="draft" /> };
  let finish!: (value: typeof view) => void;
  const { Component } = preloadableComponent(() => new Promise<typeof view>(resolve => { finish = resolve; }));
  const render = () => <Suspense fallback="loading"><Component /></Suspense>;
  const root = mountReactHarness(render());
  expect(document.body.textContent).toBe("loading");
  await act(async () => finish(view));
  const input = document.querySelector("input")!;
  input.value = "in progress";
  act(() => root.render(render()));
  expect(document.querySelector("input")).toBe(input);
  expect(input.value).toBe("in progress");
  act(() => root.unmount());
});
