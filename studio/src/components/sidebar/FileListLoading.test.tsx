// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileListError } from "./FileListLoading";
import { AssetsTab } from "./AssetsTab";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

describe("FileListError and sidebar retry", () => {
  it("renders a retryable alert state and shows Retrying while async retry is in flight", async () => {
    let resolveRetry!: () => void;
    const onRetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        }),
    );

    act(() => root!.render(<FileListError onRetry={onRetry} />));
    const alert = host!.querySelector('[data-testid="file-list-error"]');
    expect(alert?.textContent).toContain("Could not load project files");

    const retryBtn = host!.querySelector<HTMLButtonElement>('[data-testid="file-list-retry"]')!;
    expect(retryBtn.disabled).toBe(false);

    act(() => retryBtn.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(retryBtn.disabled).toBe(true);
    expect(retryBtn.textContent).toContain("Retrying");

    await act(async () => {
      resolveRetry();
      await Promise.resolve();
    });
    expect(retryBtn.disabled).toBe(false);
  });

  it("shows FileListError instead of empty drop hint in AssetsTab when file tree loading failed", () => {
    const onRetry = vi.fn();
    act(() =>
      root!.render(
        <AssetsTab projectId="proj-err" assets={[]} loading={false} error={true} onRetry={onRetry} />,
      ),
    );
    expect(host!.querySelector('[data-testid="file-list-error"]')).not.toBeNull();
    expect(host!.textContent).not.toContain("Drop media files here");

    act(() => host!.querySelector<HTMLButtonElement>('[data-testid="file-list-retry"]')!.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
