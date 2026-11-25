// @vitest-environment happy-dom
// fallow-ignore-file code-duplication
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createStudioApi,
  fileContentVersion,
  identifyFileWrite,
  openProjectHistory,
  type StudioApiAdapter,
} from "@hyperframes/studio-server";
import { consumeStudioWriteToken } from "../utils/studioFileVersion";
import { enqueueProjectEdit } from "../utils/orderedProjectEdits";
import { confirmedSource, forgetProjectSources, rememberSource } from "../utils/confirmedTextSources";
import { acknowledgeFileEdit, isolatedEditVersion } from "../utils/isolatedEditVersions";
import {
  beginStudioPendingEdit,
  paintBackNewestStudioPendingEdit,
} from "../utils/studioPendingEdits";
import { usePersistentEditHistory } from "./usePersistentEditHistory";
import { installEditorTracking, resetEditorTrackingForTests } from "../motion/editorTracking";
import { studioEditLifecycle } from "../webmcp/writeCoordinator";
import { withAvailableHistorySteps } from "../../../shared/studio-history-availability";
import { TimelineHistoryButtons } from "../components/TimelineHistoryButtons";

const cleanup: Array<() => unknown> = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  vi.unstubAllGlobals();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The hook over the real history routes and engine, on a project whose index.html reads "A". */
async function studio({ withHistory = true, initialFiles = {} as Record<string, string> } = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const dir = tempDir("hf-studio-history-");
  writeFileSync(join(dir, "index.html"), "A");
  for (const [name, content] of Object.entries(initialFiles)) writeFileSync(join(dir, name), content);
  const historyRoot = tempDir("hf-studio-history-root-");
  const history = await openProjectHistory({
    projectDir: dir,
    historyRoot,
  });
  cleanup.push(() => history.close());
  const api = createStudioApi({
    listProjects: () => [],
    resolveProject: (id: string) => (id === "demo" ? { id, dir } : null),
    ...(withHistory && { history: () => withAvailableHistorySteps(history, historyRoot) }),
  } as unknown as StudioApiAdapter);
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    api.request(url.replace(/^\/api/, ""), init),
  );
  let hook!: ReturnType<typeof usePersistentEditHistory>;
  function Harness() {
    hook = usePersistentEditHistory({ projectId: "demo" });
    return createElement(TimelineHistoryButtons, {
      canUndo: hook.canUndo, canRedo: hook.canRedo,
      onUndo: () => { void hook.undo({ readFile }); },
      onRedo: () => { void hook.redo({ readFile }); },
    });
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  cleanup.push(() => act(() => root.unmount()));
  const file = () => readFileSync(join(dir, "index.html"), "utf8");
  const save = (content: string) => writeFileSync(join(dir, "index.html"), content);
  const readFile = async (path: string) => readFileSync(join(dir, path), "utf8");
  return { dir, history, hook: () => hook, file, save, readFile, host };
}

it("uses an explicit history read for pending notifications and still refreshes on later notifications", async () => {
  const { hook } = await studio();
  const fetch = vi.fn(globalThis.fetch);
  vi.stubGlobal("fetch", fetch);
  vi.useFakeTimers();
  try {
    hook().refreshAfterEvent();
    await act(() => hook().refresh());
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(fetch).toHaveBeenCalledTimes(1);
    hook().refreshAfterEvent();
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("uses navigation returned by a cloud step and ignores its own history event", async () => {
  const { hook } = await studio();
  const readFile = vi.fn(async () => "note");
  const edit = { id: "edit", label: "Edit title", paths: ["qa-history-1.txt"], endedAt: 1000 };
  let token: string | undefined;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return Response.json({ currentSeq: 2, back: edit, forward: null, entries: [] });
    token = new Headers(init.headers).get("x-hyperframes-write-token")!;
    hook().refreshAfterEvent(token);
    const undo = JSON.parse(String(init.body)).direction === "back";
    return Response.json({ ok: true, stepLabel: edit.label, appliedFiles: ["qa-history-1.txt"],
      navigation: undo ? { currentSeq: 1, back: null, forward: edit } : { currentSeq: 2, back: edit, forward: null } });
  });
  vi.stubGlobal("fetch", fetch);
  await act(() => hook().refresh());
  vi.useFakeTimers();
  try {
    await act(() => hook().undo({ readFile }));
    hook().refreshAfterEvent(token);
    expect(hook().availableNow("redo")).toBe(true);
    expect(hook().canUndo).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(() => hook().redo({ readFile }));
    expect(hook().canUndo).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
    hook().refreshAfterEvent("another-editor");
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(fetch).toHaveBeenCalledTimes(4);
  } finally { vi.useRealTimers(); }
});

it("uses the files actually restored by cloud history in both directions", async () => {
  const { hook, save, readFile } = await studio();
  let seq = 2;
  const edit = { id: "edit", label: "Edit title", paths: ["index.html"], endedAt: 1000 };
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      seq = JSON.parse(String(init.body)).direction === "back" ? 1 : 2;
      save(seq === 1 ? "A" : "B");
      return Response.json({ ok: true, appliedFiles: ["index.html"],
        entry: { label: "Destination", files: [{ path: "other.html" }] } });
    }
    return Response.json({ currentSeq: seq, back: seq === 2 ? edit : null,
      forward: seq === 1 ? edit : null, entries: [{ id: "edit", endedAt: new Date(1000).toISOString() }] });
  });
  save("B");
  await act(() => hook().refresh());
  const undo = await act(() => hook().undo({ readFile }));
  expect(undo.files).toEqual({ "index.html": { previous: "B", restored: "A" } });
  await vi.waitFor(() => expect(hook().state.redo).toEqual([{ createdAt: 1000 }]));
  const redo = await act(() => hook().redo({ readFile }));
  expect(redo.files).toEqual({ "index.html": { previous: "A", restored: "B" } });
});

it("cloud saves need no claim and a stale tab always steps the latest project edit", async () => {
  const { hook, readFile } = await studio();
  const own = { id: "title", label: "Edit title", paths: ["index.html"], endedAt: 1000 };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      expect(url).toMatch(/\/history\/step$/);
      expect(JSON.parse(String(init.body))).toEqual({ direction: "back" });
      return Response.json({ ok: true, appliedFiles: ["captions.srt"], stepLabel: "Edit subtitles" });
    }
    return Response.json({ currentSeq: 2, back: own, forward: null, entries: [] });
  });
  vi.stubGlobal("fetch", fetch);
  await act(() => hook().refresh());
  await act(() => hook().recordEdit({ label: "Edit title", files: { "index.html": { before: "A", after: "B" } } }));
  const result = await act(() => hook().undo({ readFile, claimedAfter: 0 }));
  expect(result).toMatchObject({ ok: true, label: "Edit subtitles", paths: ["captions.srt"] });
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("guards an ordered edit pressed before its receipt and reuses verified file bytes for undo and redo", async () => {
  const { hook } = await studio();
  cleanup.push(() => forgetProjectSources('demo'));
  const path = 'index.html';
  const edit = { id: 'entry', label: 'Move layer', versionId: 'v2', paths: [path], endedAt: 1000 };
  const nav = (undone: boolean) => ({ supportsGuardedSteps: true, currentSeq: undone ? 1 : 2, revision: undone ? 'r1' : 'r2', currentVersionId: undone ? 'v1' : 'v2',
    back: undone ? null : edit, forward: undone ? edit : null });
  let saved = false;
  let undone = true;
  let race = false;
  let loseReply = false;
  let send!: () => void;
  const receipt = new Promise<void>(resolve => { send = resolve; });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json({ ...nav(undone), entries: [] });
    const body = JSON.parse(String(init.body));
    if (url.endsWith('/text-edits/batch')) {
      await receipt;
      saved = true;
      undone = false;
      const id = body.operations[0].id;
      return Response.json({ committed: [{ id, writeToken: id, changedPaths: [path], versions: { [path]: 'file-B' },
        versionId: 'v2', revision: 'r2', parentVersionId: 'v1', parentRevision: 'r1', historySeq: 2, coalesced: false }] });
    }
    expect(url).toMatch(/\/step-guarded$/);
    const undo = body.direction === 'back';
    expect(body).toEqual({ direction: undo ? 'back' : 'forward', expectedVersionId: undo ? 'v2' : 'v1',
      expectedRevision: undo ? 'r2' : 'r1', expectedTargetVersionId: undo ? 'v1' : 'v2', expectedTargetRevision: undo ? 'r1' : 'r2' });
    if (race) return Response.json({ error: 'Peer moved the cursor' }, { status: 409 });
    undone = undo;
    if (loseReply) throw new TypeError('Lost connection after the transaction committed');
    const navigation = nav(undone);
    return Response.json({ ok: true, revision: navigation.revision, versionId: navigation.currentVersionId,
      stepLabel: edit.label, appliedFiles: [path], navigation });
  });
  vi.stubGlobal('fetch', fetch);
  await act(() => hook().refresh());
  const plan = { label: edit.label, edits: [{ path, version: 'file-A', before: 'A', after: 'B' }] };
  const saving = enqueueProjectEdit('demo', path, async () => plan, false, async () => plan);
  await Promise.resolve();
  const pending = hook().predict('undo');
  expect(pending?.files[path]).toMatchObject({ previous: 'B', restored: 'A' });
  expect(saved).toBe(false);
  send();
  await saving;
  expect(hook().predict('undo')?.id).toBe(pending!.id);
  const readFile = vi.fn(async () => { throw new Error('unexpected file read'); });
  const undo = await act(() => hook().undo({ readFile, predictedId: pending!.id }));
  expect(undo).toMatchObject({ ok: true, undoes: pending!.id, files: { [path]: { previous: 'B', restored: 'A',
    versions: { previousVersion: 'file-B', restored: 'file-A' } } } });
  expect(confirmedSource('demo', path)).toEqual({ content: 'A', version: 'file-A' });
  const redo = hook().predict('redo');
  expect(redo?.files[path]).toMatchObject({ previous: 'A', restored: 'B' });
  expect(await act(() => hook().redo({ readFile, predictedId: redo!.id }))).toMatchObject({ ok: true, undoes: redo!.id });
  expect(confirmedSource('demo', path)).toEqual({ content: 'B', version: 'file-B' });
  loseReply = true;
  const recovered = await act(() => hook().undo({ readFile, predictedId: pending!.id }));
  expect(recovered).toMatchObject({ ok: true, undoes: pending!.id, files: { [path]: { previous: 'B', restored: 'A' } } });
  expect(confirmedSource('demo', path)).toEqual({ content: 'A', version: 'file-A' });
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/step-guarded'))).toHaveLength(3);
  loseReply = false;
  race = true;
  expect(await act(() => hook().redo({ readFile, predictedId: redo!.id }))).toMatchObject({ ok: false, reason: 'content-mismatch' });
  expect(hook().predict('undo')).toBeNull();
  const requests = fetch.mock.calls.length;
  expect(await act(() => hook().undo({ readFile, predictedId: pending!.id }))).toMatchObject({ ok: false, reason: 'content-mismatch' });
  expect(fetch).toHaveBeenCalledTimes(requests);
  expect(readFile).not.toHaveBeenCalled();
});

it("reads a multi-file history step concurrently without waiting once per file", async () => {
  const { dir, hook, save, readFile } = await studio({ initialFiles: { "other.html": "X" } });
  save("B"); writeFileSync(join(dir, "other.html"), "Y");
  await act(() => hook().recordEdit({ label: "Move linked clips", files: { "index.html": { before: "A", after: "B" }, "other.html": { before: "X", after: "Y" } } }));
  const reads: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const read = async (path: string) => { reads.push(path); await pending; return readFile(path); };
  await act(async () => {
    const result = hook().undo({ readFile: read });
    try { await vi.waitFor(() => expect(new Set(reads)).toEqual(new Set(["index.html", "other.html"]))); }
    finally { release(); }
    expect((await result).ok).toBe(true);
  });
});

it('keeps the peer redo destination captured at click even if the project returns to the same source cursor', async () => {
  const { hook } = await studio();
  const next = { id: 'redo-entry', label: 'Peer edit', endedAt: 3, paths: ['notes.txt'], versionId: 'first',
    targetRevision: 'first-revision', targetVersionId: 'first' };
  const navigation = { revision: 'base-r', currentVersionId: 'base', currentSeq: 1, back: null, forward: next, entries: [] };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json(navigation);
    expect(url).toMatch(/\/step-guarded$/);
    expect(JSON.parse(String(init.body))).toEqual({ direction: 'forward', expectedVersionId: 'base', expectedRevision: 'base-r',
      expectedTargetVersionId: 'first', expectedTargetRevision: 'first-revision' });
    return Response.json({ error: 'Changed destination' }, { status: 409 });
  });
  vi.stubGlobal('fetch', fetch);
  await act(() => hook().refresh());
  expect(hook().predict('redo')).toBeNull();
  const guard = hook().guard('redo');
  navigation.forward = { ...next, versionId: 'second', targetVersionId: 'second', targetRevision: 'second-revision' };
  await act(() => hook().refresh());
  const readFile = vi.fn(async () => '');
  expect(await act(() => hook().redo({ readFile, guard }))).toMatchObject({ ok: false, reason: 'content-mismatch' });
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(readFile).not.toHaveBeenCalled();
});

it('releases a provisional restore on the first peer event, before a late step response', async () => {
  const { hook } = await studio();
  cleanup.push(() => forgetProjectSources('demo'));
  rememberSource('demo', 'index.html', { content: 'B', version: 'own-B' });
  acknowledgeFileEdit('demo', 'index.html', 'own-A', 'own-B');
  const edit = { id: 'one', label: 'Move', paths: ['index.html'], endedAt: 1000 };
  const next = { currentSeq: 2, back: edit, forward: null, entries: [] };
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => init?.method === 'POST'
    ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(Response.json(next)));
  await act(() => hook().refresh());
  const onSuperseded = vi.fn();
  const readFile = vi.fn(async () => 'B');
  await act(async () => {
    const step = hook().undo({ readFile, onSuperseded });
    await vi.waitFor(() => expect(finish).toBeDefined());
    hook().noteOutsideChange('peer', ['index.html']);
    hook().refreshAfterEvent('peer');
    rememberSource('demo', 'index.html', { content: 'C', version: 'peer-C' });
    expect(onSuperseded).toHaveBeenCalledExactlyOnceWith(['index.html']);
    finish(Response.json({ ok: true, stepLabel: edit.label, appliedFiles: ['index.html'],
      navigation: { currentSeq: 1, back: null, forward: edit } }));
    expect(await step).toEqual({ ok: true, label: 'Move', paths: ['index.html'] });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(isolatedEditVersion('demo', 'index.html', 'own-A')).toBe('own-A');
    expect(confirmedSource('demo', 'index.html')).toEqual({ content: 'C', version: 'peer-C' });
  });
});

it('undoes exactly the newest of two queued moves pressed before either receipt', async () => {
  const { hook } = await studio();
  cleanup.push(() => forgetProjectSources('demo'));
  const path = 'index.html';
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json({ supportsGuardedSteps: true, currentSeq: 1, currentVersionId: 'v1', revision: 'r1', back: null, forward: null, entries: [] });
    const body = JSON.parse(String(init.body));
    if (url.endsWith('/batch')) {
      await held;
      expect(body.operations).toHaveLength(2);
      return Response.json({ committed: body.operations.map(({ id }: {id: string}, i: number) => ({
        id, writeToken: id, changedPaths: [path], versions: { [path]: `file${i + 2}` }, historySeq: i + 2, coalesced: false,
        parentVersionId: `v${i + 1}`, parentRevision: `r${i + 1}`, versionId: `v${i + 2}`, revision: `r${i + 2}`,
      })) });
    }
    expect(url).toMatch(/\/step-guarded$/);
    expect(body).toEqual({ direction: 'back', expectedVersionId: 'v3', expectedRevision: 'r3', expectedTargetVersionId: 'v2', expectedTargetRevision: 'r2' });
    return Response.json({ ok: true, stepLabel: 'Move again', appliedFiles: [path], versionId: 'v2', revision: 'r2',
      navigation: { supportsGuardedSteps: true, currentVersionId: 'v2', revision: 'r2', currentSeq: 2, back: null, forward: null } });
  });
  vi.stubGlobal('fetch', fetch);
  await act(() => hook().refresh());
  const move = (before: string, after: string) => enqueueProjectEdit('demo', path, async () => ({
    label: 'Move', edits: [{ path, version: 'file1', before, after }],
  }));
  const first = move('A', 'B');
  const firstId = hook().pendingUndoId();
  const second = move('B', 'C');
  const secondId = hook().pendingUndoId();
  expect(firstId && secondId).toBeTruthy();
  expect(firstId).not.toBe(secondId);
  expect(hook().predict('undo')).toBeNull();
  const readFile = vi.fn(async () => 'unexpected');
  await act(async () => {
    const step = hook().undo({ pendingUndoId: secondId, readFile });
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith('/batch'))).toBe(true));
    release();
    await Promise.all([first, second]);
    expect(await step).toMatchObject({ ok: true, files: { [path]: { previous: 'C', restored: 'B' } } });
  });
  const failing = enqueueProjectEdit('demo', path, async () => { throw new Error('Missing clip'); });
  const failedId = hook().pendingUndoId();
  const rejected = expect(failing).rejects.toThrow('Missing clip');
  expect(await act(() => hook().undo({ pendingUndoId: failedId, readFile }))).toMatchObject({ ok: false, reason: 'content-mismatch' });
  await rejected;
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/step-guarded'))).toHaveLength(1);
  expect(readFile).not.toHaveBeenCalled();
});

it("disables a known conflicting undo before the user clicks it", async () => {
  const { history, hook, save, host } = await studio();
  save("B");
  await act(() => hook().recordEdit({ label: "Move", files: { "index.html": { before: "A", after: "B" } } }));
  const agent = await history.beginWindow({ kind: "agent", name: "Agent" }, "Agent edit");
  save("C");
  await agent.close();
  await act(() => hook().noteOutsideChange());
  await vi.waitFor(() => expect(hook().canUndo).toBe(false));
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')!.disabled).toBe(true);
});

it("an undo whose media bytes are missing has the same disabled flags as empty history", async () => {
  const { dir, history, hook } = await studio({ initialFiles: { "clip.mp4": "original" } });
  expect(hook().canUndo).toBe(false);
  expect(hook().canRedo).toBe(false);
  const window = await history.beginWindow({ kind: "person", name: "You" }, "Overwrite media");
  writeFileSync(join(dir, "clip.mp4"), "replacement");
  await window.close();
  expect(history.next("back", { kind: "person", name: "You" })).toBeDefined();
  await act(() => hook().noteOutsideChange());
  await vi.waitFor(() => expect(hook().undoLabel).toBeUndefined());
  expect(hook().canUndo).toBe(false);
  expect(hook().canRedo).toBe(false);
  expect(readFileSync(join(dir, "clip.mp4"), "utf8")).toBe("replacement");
});

it("an edit Studio saved is undone and redone by the project's history, with the preview's before and after", async () => {
  const { hook, file, save, readFile } = await studio();
  save("B");
  await act(() =>
    hook().recordEdit({
      label: "Moved Title",
      files: { "index.html": { before: "A", after: "B" } },
    }),
  );
  await vi.waitFor(() => expect(hook().undoLabel).toBe("Moved Title"));

  const undone = await act(() => hook().undo({ readFile }));
  expect(undone).toEqual({
    ok: true,
    label: "Undid: Moved Title",
    undoes: expect.any(String),
    paths: ["index.html"],
    files: { "index.html": { previous: "B", restored: "A" } },
  });
  expect(file()).toBe("A");

  await vi.waitFor(() => expect(hook().canRedo).toBe(true));
  const redone = await act(() => hook().redo({ readFile }));
  expect(redone).toMatchObject({ ok: true, label: "Redid: Moved Title" });
  expect(file()).toBe("B");
});

it("gives an edit that begins the history's claim count, so undo can tell its claims from older ones", async () => {
  const { hook, save } = await studio();
  save("B");
  await act(() =>
    hook().recordEdit({
      label: "Moved Title",
      files: { "index.html": { before: "A", after: "B" } },
    }),
  );
  const saving = beginStudioPendingEdit(() => () => {});

  expect(paintBackNewestStudioPendingEdit()?.claimsAtBegin).toBe(hook().claims());
  expect(hook().claims()).toBe(1);
  saving.settle();
});

it("undoes the edit claimed since the key, not a later edit the server took in first", async () => {
  const { dir, hook, file, save, readFile } = await studio();
  const atKey = hook().claims();
  save("B");
  await act(() =>
    hook().recordEdit({
      label: "Moved Title",
      files: { "index.html": { before: "A", after: "B" } },
    }),
  );
  writeFileSync(join(dir, "card.html"), "Y");
  const later = hook().recordEdit({
    label: "Added Card",
    files: { "card.html": { before: "", after: "Y" } },
  });
  const afterLater = async <T>(_paths: readonly string[], task: () => Promise<T>) => {
    await later;
    return task();
  };

  const undone = await act(() =>
    hook().undo({ readFile, serialize: afterLater, claimedAfter: atKey }),
  );
  expect(undone).toMatchObject({ ok: true, label: "Undid: Moved Title" });
  expect(file()).toBe("A");
  expect(readFileSync(join(dir, "card.html"), "utf8")).toBe("Y");
});

it("a second undo pressed while the same edit saves undoes the edit before it", async () => {
  const { hook, file, save, readFile } = await studio();
  save("B");
  await act(() =>
    hook().recordEdit({
      label: "Moved Title",
      files: { "index.html": { before: "A", after: "B" } },
    }),
  );
  await vi.waitFor(() => expect(hook().undoLabel).toBe("Moved Title"));
  const atKey = hook().claims();
  save("C");
  await act(() =>
    hook().recordEdit({
      label: "Moved Card",
      files: { "index.html": { before: "B", after: "C" } },
    }),
  );

  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(_paths: readonly string[], task: () => Promise<T>) => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };
  const press = () => hook().undo({ readFile, claimedAfter: atKey, serialize });

  const [first, second] = await act(() => Promise.all([press(), press()]));

  expect([first, second]).toMatchObject([
    { ok: true, label: "Undid: Moved Card" },
    { ok: true, label: "Undid: Moved Title" },
  ]);
  expect(file()).toBe("A");
});

it("keeps the claim when its undo fails, so the next press targets that edit again", async () => {
  const { hook, save, readFile } = await studio();
  save("B");
  await act(() =>
    hook().recordEdit({
      label: "Moved Title",
      files: { "index.html": { before: "A", after: "B" } },
    }),
  );
  await vi.waitFor(() => expect(hook().undoLabel).toBe("Moved Title"));
  const atKey = hook().claims();
  save("C");
  await act(() =>
    hook().recordEdit({
      label: "Moved Card",
      files: { "index.html": { before: "B", after: "C" } },
    }),
  );
  const posted: string[] = [];
  const fetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posted.push(url.slice(url.lastIndexOf("/") + 1));
    return fetch(url, init);
  });

  save("edited elsewhere");
  const failed = await act(() => hook().undo({ readFile, claimedAfter: atKey }));
  save("C");
  const retried = await act(() => hook().undo({ readFile, claimedAfter: atKey }));

  expect(failed.ok).toBe(false);
  expect(retried).toMatchObject({ ok: true, label: "Undid: Moved Card" });
  expect(posted.filter((p) => p === "undo" || p === "step")).toEqual(["undo", "undo"]);
});

it("does not undo again an edit another press already undid", async () => {
  const { hook, file, save, readFile } = await studio();
  save("B");
  await act(() =>
    hook().recordEdit({
      label: "Moved Title",
      files: { "index.html": { before: "A", after: "B" } },
    }),
  );
  await vi.waitFor(() => expect(hook().undoLabel).toBe("Moved Title"));
  const atKey = hook().claims();
  save("C");
  await act(() =>
    hook().recordEdit({
      label: "Moved Card",
      files: { "index.html": { before: "B", after: "C" } },
    }),
  );
  let calls = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(_paths: readonly string[], task: () => Promise<T>) => {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error("save failed"));
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };
  const press = () => hook().undo({ readFile, claimedAfter: atKey, serialize });

  const [first, second] = await act(() => Promise.allSettled([press(), press()]));
  const third = await act(() => press());

  expect(first.status).toBe("rejected");
  expect(second).toMatchObject({
    status: "fulfilled",
    value: { ok: true, label: "Undid: Moved Card" },
  });
  expect(third).toMatchObject({ ok: true, label: "Undid: Moved Title" });
  expect(file()).toBe("A");
});

it("does not undo again an edit a later press undid first", async () => {
  const { hook, file, save, readFile } = await studio();
  save("B");
  await act(() =>
    hook().recordEdit({
      label: "Moved Title",
      files: { "index.html": { before: "A", after: "B" } },
    }),
  );
  await vi.waitFor(() => expect(hook().undoLabel).toBe("Moved Title"));
  const atKey = hook().claims();
  save("C");
  await act(() =>
    hook().recordEdit({
      label: "Moved Card",
      files: { "index.html": { before: "B", after: "C" } },
    }),
  );
  let fail!: (error: Error) => void;
  const held = <T>(_paths: readonly string[], _task: () => Promise<T>) =>
    new Promise<T>((_resolve, reject) => {
      fail = reject;
    });
  const failed = hook()
    .undo({ readFile, claimedAfter: atKey, serialize: held })
    .catch(() => undefined);

  const second = await act(() => hook().undo({ readFile, claimedAfter: atKey }));
  fail(new Error("save failed"));
  await failed;
  const third = await act(() => hook().undo({ readFile, claimedAfter: atKey }));

  expect(second).toMatchObject({ ok: true, label: "Undid: Moved Card" });
  expect(third).toMatchObject({ ok: true, label: "Undid: Moved Title" });
  expect(file()).toBe("A");
});

it("refuses a second press whose edit is undone once an edit was made after the press", async () => {
  const { dir, hook, file, save, readFile } = await studio();
  save("B");
  await act(() =>
    hook().recordEdit({
      label: "Moved Title",
      files: { "index.html": { before: "A", after: "B" } },
    }),
  );
  await vi.waitFor(() => expect(hook().undoLabel).toBe("Moved Title"));
  const atKey = hook().claims();
  save("C");
  await act(() =>
    hook().recordEdit({
      label: "Moved Card",
      files: { "index.html": { before: "B", after: "C" } },
    }),
  );
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let queue: Promise<unknown> = Promise.resolve();
  let queued = 0;
  const serialize = <T>(_paths: readonly string[], task: () => Promise<T>) => {
    queued += 1;
    const wait = queued === 2 ? opened : Promise.resolve();
    const run = queue.then(() => wait).then(task);
    queue = run.catch(() => undefined);
    return run;
  };
  const press = () => hook().undo({ readFile, claimedAfter: atKey, serialize });
  const firstPress = press();
  const secondPress = press();
  // The first press must be over, not only its file written: the undo's closing sweep would take card.html
  // into the undo, and the claim below would then hold nothing.
  const first = await act(() => firstPress);
  expect(file()).toBe("B");
  writeFileSync(join(dir, "card.html"), "Y");
  await act(() =>
    hook().recordEdit({
      label: "Added Card",
      files: { "card.html": { before: "", after: "Y" } },
    }),
  );

  open();
  const second = await act(() => secondPress);

  expect(first).toMatchObject({ ok: true, label: "Undid: Moved Card" });
  expect(second).toMatchObject({ ok: false, reason: "content-mismatch" });
  expect(readFileSync(join(dir, "card.html"), "utf8")).toBe("Y");
  expect(file()).toBe("B");
});

it("a file the edit made (a freeze's still) is deleted by its Undo and put back by its Redo", async () => {
  const { dir, hook, save, readFile } = await studio();
  const still = join(dir, "assets", "freeze", "talk.png");
  mkdirSync(dirname(still), { recursive: true });
  writeFileSync(still, "png");
  save("B");
  await act(() =>
    hook().recordEdit({
      label: "Freeze frame",
      files: { "index.html": { before: "A", after: "B" } },
      created: ["assets/freeze/talk.png"],
    }),
  );
  await vi.waitFor(() => expect(hook().undoLabel).toBe("Freeze frame"));

  await act(() => hook().undo({ readFile }));
  expect(existsSync(still)).toBe(false);

  await vi.waitFor(() => expect(hook().canRedo).toBe(true));
  await act(() => hook().redo({ readFile }));
  expect(readFileSync(still, "utf8")).toBe("png");
});

it("a drag's edits under one key undo as one step, even before the drag goes idle", async () => {
  const { hook, file, save, readFile } = await studio();
  const writes: Array<[before: string, after: string]> = [
    ["A", "B"],
    ["B", "C"],
  ];
  for (const [before, after] of writes) {
    save(after);
    await act(() =>
      hook().recordEdit({
        label: "Dragged Title",
        coalesceKey: "drag",
        coalesceMs: 60_000,
        files: { "index.html": { before, after } },
      }),
    );
  }
  await vi.waitFor(() => expect(hook().undoLabel).toBe("Dragged Title"));
  const undone = await act(() => hook().undo({ readFile }));
  expect(undone).toMatchObject({
    ok: true,
    label: "Undid: Dragged Title",
    files: { "index.html": { previous: "C", restored: "A" } },
  });
  expect(file()).toBe("A");
});

it("a key one page holds does not join another page's edit under the same key", async () => {
  const { hook, file, save, readFile } = await studio();
  let reloaded!: ReturnType<typeof usePersistentEditHistory>;
  function Reloaded() {
    reloaded = usePersistentEditHistory({ projectId: "demo" });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Reloaded)));
  cleanup.push(() => act(() => root.unmount()));
  const held = { label: "Moved Title", coalesceKey: "timeline-move:1", coalesceMs: Infinity };
  save("B");
  await act(() =>
    hook().recordEdit({ ...held, files: { "index.html": { before: "A", after: "B" } } }),
  );
  save("C");
  await act(() =>
    reloaded.recordEdit({ ...held, files: { "index.html": { before: "B", after: "C" } } }),
  );

  await act(() => reloaded.undo({ readFile }));

  expect(file()).toBe("B");
});

it("a host's write claimed under claimKey joins Studio's save under the same key: one undo takes back both", async () => {
  const { dir, history, hook, file, save, readFile } = await studio();
  const key = "drop:1";
  writeFileSync(join(dir, "clip.mp4"), "media");
  await history.claim({ kind: "person", name: "You" }, "Dropped on timeline", ["clip.mp4"], {
    coalesceKey: hook().claimKey(key),
    idleMs: Infinity,
  });
  save("B");
  await act(() =>
    hook().recordEdit({
      label: "Dropped on timeline",
      coalesceKey: key,
      coalesceMs: Infinity,
      files: { "index.html": { before: "A", after: "B" } },
    }),
  );

  await act(() => hook().undo({ readFile }));

  expect(file()).toBe("A");
  expect(existsSync(join(dir, "clip.mp4"))).toBe(false);
});

it("an undo before the history view shows a drag's held claim still waits on the files it wrote", async () => {
  const { hook, save, readFile } = await studio();
  const server = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? server(url, init)
      : Promise.resolve(new Response(null, { status: 503 })),
  );
  save("B");
  await act(() =>
    hook().recordEdit({
      label: "Dragged Title",
      coalesceKey: "drag",
      files: { "index.html": { before: "A", after: "B" } },
    }),
  );
  let waitedOn: readonly string[] = [];
  const serialize = <T>(paths: readonly string[], task: () => Promise<T>) => {
    waitedOn = paths;
    return task();
  };

  await act(() => hook().undo({ readFile, serialize }));
  expect(waitedOn).toEqual(["index.html"]);
});

it("an agent's edit made seconds before Studio's stays the agent's: Cmd+Z undoes only Studio's", async () => {
  const { hook, file, save, readFile } = await studio();
  save("B");
  await act(() => hook().recordEdit({ label: "sweep", files: {} }));
  save("C");
  await act(() =>
    hook().recordEdit({
      label: "Moved Title",
      files: { "index.html": { before: "B", after: "C" } },
    }),
  );
  expect(await act(() => hook().undo({ readFile }))).toMatchObject({ label: "Undid: Moved Title" });
  expect(file()).toBe("B");
});

it("an undo's writes carry the write token Studio marked, so their echo is not read as an outside edit", async () => {
  const { dir, hook, save, readFile } = await studio();
  save("B");
  await act(() =>
    hook().recordEdit({
      label: "Moved Title",
      files: { "index.html": { before: "A", after: "B" } },
    }),
  );
  await act(() => hook().undo({ readFile }));
  const receipt = identifyFileWrite(join(dir, "index.html"), fileContentVersion("A"));
  expect(consumeStudioWriteToken(receipt?.writeToken ?? null)).toBe(true);
});

it("without a history on the server an edit still saves, and there is nothing to undo", async () => {
  const { hook, file, save, readFile } = await studio({ withHistory: false });
  save("B");
  await act(() =>
    hook().recordEdit({
      label: "Moved Title",
      files: { "index.html": { before: "A", after: "B" } },
    }),
  );
  expect(hook().canUndo).toBe(false);
  expect(await act(() => hook().undo({ readFile }))).toEqual({ ok: false, reason: "empty" });
  expect(file()).toBe("B");
});

/** Answers requests to `route` with `reply` instead of the engine, every other request as before; returns the undo. */
function answer(
  route: "/history" | "/history/step" | "/history/claim",
  status: number,
  reply: object | string,
) {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    url.endsWith(route)
      ? Promise.resolve(
          new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status }),
        )
      : real(url, init),
  );
  return () => vi.stubGlobal("fetch", real);
}

it("a step the server could not take says why, instead of reading as nothing to undo", async () => {
  const { hook, readFile } = await studio();
  answer("/history/step", 500, { error: "disk full" });
  expect(await act(() => hook().undo({ readFile }))).toEqual({
    ok: false,
    reason: "failed",
    message: "disk full",
  });
});

it("a refused step disables its button and repeated shortcuts until a new step is available", async () => {
  const { hook, save, readFile, host } = await studio();
  save("B");
  await act(() =>
    hook().recordEdit({
      label: "Moved Title",
      files: { "index.html": { before: "A", after: "B" } },
    }),
  );
  await vi.waitFor(() => expect(hook().undoLabel).toBe("Moved Title"));
  const restoreFetch = answer("/history/step", 200, { ok: false, conflict: { files: ["index.html"], newer: [] } });
  const requests = vi.spyOn(globalThis, "fetch");
  const staleUndo = hook().undo;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const queued = staleUndo({ readFile, serialize: async (_paths, run) => { await waiting; return run(); } });
  expect(await act(() => hook().undo({ readFile }))).toEqual({
    ok: false,
    reason: "content-mismatch",
    paths: ["index.html"],
  });
  expect(hook().canUndo).toBe(false);
  release();
  expect(await act(() => queued)).toMatchObject({ ok: false, reason: "empty" });
  expect(hook().predict("undo")).toBeNull();
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')!.disabled).toBe(true);
  await act(() => hook().noteOutsideChange());
  await act(() => staleUndo({ readFile }));
  await act(() => hook().undo({ readFile }));
  expect(hook().canUndo).toBe(false);
  expect(requests.mock.calls.filter(([url]) => String(url).endsWith('/history/step'))).toHaveLength(1);
  requests.mockRestore();
  restoreFetch();
  save("C");
  await act(() => hook().recordEdit({ label: "New edit", files: { "index.html": { before: "B", after: "C" } } }));
  await vi.waitFor(() => expect(hook().canUndo).toBe(true));
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')!.disabled).toBe(false);
  expect(await act(() => hook().undo({ readFile }))).toMatchObject({ ok: true });
});

it("disables a redo conflict without disabling the independent undo step", async () => {
  const { hook, save, readFile, host } = await studio();
  save("B");
  await act(() => hook().recordEdit({ label: "First edit", files: { "index.html": { before: "A", after: "B" } } }));
  save("C");
  await act(() => hook().recordEdit({ label: "Second edit", files: { "index.html": { before: "B", after: "C" } } }));
  await act(() => hook().undo({ readFile }));
  await vi.waitFor(() => expect(hook().canRedo).toBe(true));
  answer("/history/step", 200, { ok: false, conflict: { files: ["index.html"], newer: [] } });
  await act(() => hook().redo({ readFile }));
  expect(hook().canRedo).toBe(false);
  expect(hook().canUndo).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Redo"]')!.disabled).toBe(true);
});

it("a claim the server refused is logged, and the write stays undoable as a change made outside", async () => {
  const { hook, file, save, readFile } = await studio();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(() => logged.mockRestore());
  const restoreFetch = answer("/history/claim", 500, { error: "disk full" });
  save("B");
  await act(() =>
    hook().recordEdit({
      label: "Moved Title",
      files: { "index.html": { before: "A", after: "B" } },
    }),
  );
  expect(logged).toHaveBeenCalledWith(
    '[history] 500: "Moved Title" was not recorded as your edit: disk full',
  );
  restoreFetch();
  expect(await act(() => hook().undo({ readFile }))).toMatchObject({
    ok: true,
    label: "Undid: Changed outside the app",
  });
  expect(file()).toBe("A");
});

it.each([
  [
    "the server refused",
    409,
    () => answer("/history/claim", 409, { error: "newer edit" }),
    "newer edit",
  ],
  [
    "could not reach the server",
    0,
    () => {
      const real = globalThis.fetch;
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
        url.endsWith("/history/claim")
          ? Promise.reject(new TypeError("fetch failed"))
          : real(url, init),
      );
    },
    "Studio could not reach its server.",
  ],
] as const)(
  "a claim that %s logs under [history] with its status",
  async (_, status, stub, reason) => {
    const { hook, save } = await studio();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanup.push(() => logged.mockRestore());
    stub();
    save("B");
    await act(() =>
      hook().recordEdit({
        label: "Moved Title",
        files: { "index.html": { before: "A", after: "B" } },
      }),
    );
    expect(logged).toHaveBeenCalledWith(
      `[history] ${status}: "Moved Title" was not recorded as your edit: ${reason}`,
    );
  },
);

it("a step whose reply cannot be read says so, instead of throwing", async () => {
  const { hook, readFile } = await studio();
  answer("/history/step", 200, "<html>");
  expect(await act(() => hook().undo({ readFile }))).toEqual({
    ok: false,
    reason: "failed",
    message: "The history's reply was unreadable.",
  });
});

it("an edit whose history reply cannot be read is still saved, and the reply is its own error", async () => {
  const { hook, file, save } = await studio();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  cleanup.push(() => logged.mockRestore());
  answer("/history", 200, "<html>");
  save("B");
  await act(() =>
    hook().recordEdit({
      label: "Moved Title",
      files: { "index.html": { before: "A", after: "B" } },
    }),
  );
  await vi.waitFor(() =>
    expect(logged).toHaveBeenCalledWith("The history's reply was unreadable."),
  );
  expect(file()).toBe("B");
});

it("a step that cannot reach the server says so", async () => {
  const { hook, readFile } = await studio();
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    url.endsWith("/history/step") ? Promise.reject(new TypeError("fetch failed")) : real(url, init),
  );
  expect(await act(() => hook().undo({ readFile }))).toEqual({
    ok: false,
    reason: "failed",
    message: "Studio could not reach its server.",
  });
});

it("predicts a step from what this tab wrote as soon as its save ends, and not while a claim or step may have moved the history", async () => {
  const { hook, save, readFile } = await studio();
  const real = globalThis.fetch;
  const slowView = (url: string, init?: RequestInit) =>
    url.endsWith("/history")
      ? new Promise((r) => setTimeout(r, 50)).then(() => real(url, init))
      : real(url, init);
  vi.stubGlobal("fetch", slowView);
  save("B");
  const claim = hook().recordEdit({
    label: "Moved Title",
    files: { "index.html": { before: "A", after: "B" } },
  });
  expect(hook().predict("undo")).toBeNull();
  await act(() => claim);
  const predicted = hook().predict("undo")!;
  expect(predicted?.files).toEqual({ "index.html": { previous: "B", restored: "A" } });

  hook().noteOutsideChange();
  expect(hook().predict("undo")).toBeNull();
  await vi.waitFor(() => expect(hook().predict("undo")?.id).toBe(predicted.id));

  const undone = hook().undo({ readFile });
  expect(hook().predict("undo")).toBeNull();
  expect((await act(() => undone)).undoes).toBe(predicted.id);
  await vi.waitFor(() =>
    expect(hook().predict("redo")?.files).toEqual({
      "index.html": { previous: "A", restored: "B" },
    }),
  );
});

it("an undo taken before the view caught up with the edit still reports the preview's before and after", async () => {
  const { hook, save, readFile } = await studio();
  save("B");
  const record = hook().recordEdit({
    label: "Moved Title",
    files: { "index.html": { before: "A", after: "B" } },
  });
  const undo = hook().undo;
  await act(() => record);
  const undone = await act(() => undo({ readFile }));
  expect(undone).toMatchObject({
    ok: true,
    files: { "index.html": { previous: "B", restored: "A" } },
  });
});

it("stores DOM targets in existing history and retains them through undo and redo", async () => {
  const { hook, save, readFile, history } = await studio();
  save("B");
  const targets = [{ file: "index.html", id: "title", selector: ".title", selectorIndex: 1 }];
  await act(() =>
    hook().recordEdit({
      label: "Title",
      targets,
      files: { "index.html": { before: "A", after: "B" } },
    }),
  );
  expect(history.list().at(-1)?.targets).toEqual(targets);
  await vi.waitFor(() => expect(hook().canUndo).toBe(true));
  await act(() => hook().undo({ readFile }));
  expect(history.list().at(-1)?.targets).toEqual(targets);
  await vi.waitFor(() => expect(hook().canRedo).toBe(true));
  await act(() => hook().redo({ readFile }));
  expect(history.list().at(-1)?.targets).toEqual(targets);
});

it("reports one manual edit per history entry it claims, and none for an Agent tool's write", async () => {
  const sent = vi.fn((_event: string, _properties: Record<string, unknown>) => "queued");
  resetEditorTrackingForTests();
  installEditorTracking(sent as never);
  cleanup.push(() => installEditorTracking(undefined));
  const { hook, save } = await studio();
  const edits = () => sent.mock.calls.filter(([event]) => event === "studio_edit_result").map(([, properties]) => properties);

  save("B");
  await act(() => hook().recordEdit({ label: "Move layer", coalesceKey: "drag", coalesceMs: Infinity, files: { "index.html": { before: "A", after: "B" } } }));
  save("C");
  await act(() => hook().recordEdit({ label: "Move layer", coalesceKey: "drag", coalesceMs: Infinity, files: { "index.html": { before: "B", after: "C" } } }));
  // "demo" is not a UUID and not the built-in project, so only its scope is sent.
  expect(edits(), "a held drag is one edit").toEqual([{ outcome: "success", edit_kind: "move", surface: "canvas", project_scope: "other" }]);

  save("D");
  await act(() => hook().recordEdit({ label: "Split 2 clips at 1.00s", files: { "index.html": { before: "C", after: "D" } } }));
  expect(edits().map((edit) => edit.edit_kind)).toEqual(["move", "timeline_split"]);

  const callId = studioEditLifecycle.begin("demo", { handle: "h", sourceFile: "index.html" }, "set-text");
  cleanup.push(() => studioEditLifecycle.reset());
  save("E");
  await act(() => hook().recordEdit({ label: "Edit text", files: { "index.html": { before: "D", after: "E" } } }));
  studioEditLifecycle.dismiss(callId);
  expect(edits(), "an Agent write is not a manual edit").toHaveLength(2);
  expect(hook().undoLabel, "the Agent write is still undoable").toBe("Edit text");
});
