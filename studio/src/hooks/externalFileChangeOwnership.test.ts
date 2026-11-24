import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { subscribeProjectActivity } from "../motion/workspaceRefresh";
import { sseFileChangeChannel } from "./useExternalFileChangeCoordinator";

describe("external file-change subscription ownership", () => {
  it("has one subscriber instead of independent Preview and SDK listeners", () => {
    const preview = readFileSync(new URL("./usePreviewPersistence.ts", import.meta.url), "utf8");
    const sdk = readFileSync(new URL("./useSdkSession.ts", import.meta.url), "utf8");
    const coordinator = readFileSync(
      new URL("./useExternalFileChangeCoordinator.ts", import.meta.url),
      "utf8",
    );

    expect(preview).not.toContain('hot.on("hf:file-change"');
    expect(sdk).not.toContain('hot.on("hf:file-change"');
    expect(coordinator.match(/hot\.on\("hf:file-change"/g)).toHaveLength(1);
  });

  it("selects the SSE channel for production and hands it the shared handler", () => {
    const coordinator = readFileSync(
      new URL("./useExternalFileChangeCoordinator.ts", import.meta.url),
      "utf8",
    );
    expect(coordinator).toContain("sseFileChangeChannel(handler, catchUp, historyHandler)");
  });

  it("asks to catch up on every reconnect, since changes made while disconnected are never resent", () => {
    const listeners = new Map<string, (event: unknown) => void>();
    class FakeEventSource {
      addEventListener(type: string, listener: (event: unknown) => void) {
        listeners.set(type, listener);
      }
      close = vi.fn();
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    try {
      const onReconnect = vi.fn();
      sseFileChangeChannel(vi.fn(), onReconnect);
      listeners.get("open")?.(new Event("open"));
      expect(onReconnect).not.toHaveBeenCalled();
      listeners.get("error")?.(new Event("error"));
      listeners.get("open")?.(new Event("open"));
      listeners.get("open")?.(new Event("open"));
      expect(onReconnect).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("creates one fresh stream and catches up after a browser offline interval", () => {
    const network = new EventTarget();
    const streams: FakeEventSource[] = [];
    class FakeEventSource extends EventTarget {
      close = vi.fn();
      constructor() { super(); streams.push(this); }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("addEventListener", network.addEventListener.bind(network));
    vi.stubGlobal("removeEventListener", network.removeEventListener.bind(network));
    try {
      const catchUp = vi.fn();
      const stop = sseFileChangeChannel(vi.fn(), catchUp);
      streams[0].dispatchEvent(new Event("open"));
      network.dispatchEvent(new Event("offline"));
      expect(streams[0].close).toHaveBeenCalledOnce();
      network.dispatchEvent(new Event("online"));
      expect(streams).toHaveLength(2);
      streams[1].dispatchEvent(new Event("open"));
      expect(catchUp).toHaveBeenCalledOnce();
      stop();
      network.dispatchEvent(new Event("offline"));
      network.dispatchEvent(new Event("online"));
      expect(streams).toHaveLength(2);
    } finally { vi.unstubAllGlobals(); }
  });

  it("delivers the raw file-change event from EventSource to the handler and closes on cleanup", () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const close = vi.fn();
    const opened: string[] = [];
    class FakeEventSource {
      constructor(url: string) {
        opened.push(url);
      }
      addEventListener(type: string, listener: (event: unknown) => void) {
        listeners.set(type, listener);
      }
      close = close;
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    try {
      const onDelivery = vi.fn();
      const stop = sseFileChangeChannel(onDelivery, vi.fn());
      const event = new MessageEvent("file-change", { data: JSON.stringify({ path: "a.html" }) });
      listeners.get("file-change")?.(event);
      expect(opened).toEqual(["/api/events?orderedEdits=1"]);
      expect(onDelivery).toHaveBeenCalledWith(event);
      stop();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("applies a contiguous batch once, refreshes history once, and reconciles a gap", () => {
    const stream = new EventTarget();
    vi.stubGlobal("EventSource", class {
      addEventListener = stream.addEventListener.bind(stream);
      close() {}
    });
    const onChange = vi.fn(), catchUp = vi.fn(), onHistory = vi.fn();
    const send = (event: string, data: object) => stream.dispatchEvent(new MessageEvent(event, {data: JSON.stringify(data)}));
    const batch = { revision: "v2", ordered: { fromRevision: "v0", historySeq: 2, steps: [{id:"a"}, {id:"b"}] } };
    const stop = sseFileChangeChannel(onChange, catchUp, onHistory);
    try {
      send("file-change", batch);
      send("history-changed", { includedInOrderedEdit:true });
      send("file-change", batch);
      expect(onChange).toHaveBeenCalledOnce();
      expect(onHistory).toHaveBeenCalledOnce();
      send("file-change", {...batch, revision:"v5", ordered:{...batch.ordered, fromRevision:"v4"}});
      expect(catchUp).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledOnce();
    } finally { stop(); vi.unstubAllGlobals(); }
  });

  it("delivers project history and render invalidations through the shared EventSource", () => {
    const listeners = new Map<string, (event: unknown) => void>();
    class FakeEventSource {
      addEventListener(type: string, listener: (event: unknown) => void) {
        listeners.set(type, listener);
      }
      close = vi.fn();
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const onActivity = vi.fn();
    const unsubscribe = subscribeProjectActivity(onActivity);
    try {
      const onHistoryChanged = vi.fn();
      const stop = sseFileChangeChannel(vi.fn(), vi.fn(), onHistoryChanged);
      const event = new MessageEvent("history-changed", { data: JSON.stringify({ projectId: "project-a" }) });
      listeners.get("history-changed")?.(event);
      expect(onHistoryChanged).toHaveBeenCalledWith(event);
      listeners.get("render-updated")?.(new MessageEvent("render-updated", { data: JSON.stringify({ projectId: "project-a", state: "queued" }) }));
      expect(onActivity).toHaveBeenCalledWith("project-a", "render-updated");
      stop();
    } finally {
      unsubscribe();
      vi.unstubAllGlobals();
    }
  });
});
