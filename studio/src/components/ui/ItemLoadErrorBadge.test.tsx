// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18n";
import { ItemLoadErrorBadge } from "./ItemLoadErrorBadge";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("ItemLoadErrorBadge", () => {
  it("renders a button trigger that invokes onReload without bubbling to parent card handlers", () => {
    const onParentClick = vi.fn();
    const onParentPointerDown = vi.fn();
    const onReload = vi.fn();

    act(() => {
      root.render(
        <I18nProvider initialLocale="zh-CN">
          <div onPointerDown={onParentPointerDown} onClick={onParentClick}>
            <ItemLoadErrorBadge onReload={onReload} />
          </div>
        </I18nProvider>,
      );
    });

    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="item-load-error"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.tagName).toBe("BUTTON");
    expect(trigger?.getAttribute("aria-label")).toBe("加载失败 · 点击重新加载");

    const PointerCtor = window.PointerEvent ?? MouseEvent;
    act(() => {
      trigger!.dispatchEvent(new PointerCtor("pointerdown", { bubbles: true }));
      trigger!.click();
    });

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onParentPointerDown).not.toHaveBeenCalled();
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it("renders a span[role=button] when nested inside a native button and supports keyboard reload", () => {
    const onParentClick = vi.fn();
    const onReload = vi.fn();

    act(() => {
      root.render(
        <I18nProvider initialLocale="en">
          <button type="button" onClick={onParentClick}>
            <ItemLoadErrorBadge nestedInButton compact onReload={onReload} />
          </button>
        </I18nProvider>,
      );
    });

    const trigger = host.querySelector<HTMLElement>('[data-testid="item-load-error"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.tagName).toBe("SPAN");
    expect(trigger?.getAttribute("role")).toBe("button");
    expect(trigger?.className).toContain("is-compact");

    act(() => {
      trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    expect(onReload).toHaveBeenCalledTimes(2);
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it("suppresses clicks while reloading", () => {
    const onReload = vi.fn();
    act(() => {
      root.render(
        <I18nProvider initialLocale="en">
          <ItemLoadErrorBadge reloading onReload={onReload} />
        </I18nProvider>,
      );
    });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="item-load-error"]')!;
    expect(trigger.getAttribute("data-reloading")).toBe("true");
    expect(trigger.disabled).toBe(true);
    act(() => trigger.click());
    expect(onReload).not.toHaveBeenCalled();
  });
});
