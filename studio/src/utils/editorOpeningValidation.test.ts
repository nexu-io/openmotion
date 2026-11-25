// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const project = "project-a", entry = "/api/projects/project-a/files/index.html";
const source = (version: string) => ({ response: new Response(), data: { version, content: version } });
const scoped = { projectId: project, revision: "r1" };
beforeEach(() => {
  vi.resetModules();
  document.head.innerHTML = '<link rel="preload" data-editor-bootstrap href="/api/projects/project-a?view=editor">';
});
afterEach(() => { document.head.replaceChildren(); vi.useRealTimers(); });

it.each([
  { head: 'r1', event: false, catchUp: false },
  { head: 'r2', event: false, catchUp: true },
  { head: null, event: false, catchUp: true },
  { head: 'r1', event: true, catchUp: true },
])('verifies both preloads without the stream, then reconciles $head (file event: $event)', async ({ head, event, catchUp }) => {
  vi.useFakeTimers();
  const boot = await import('./editorOpeningValidation');
  const readTree = vi.fn(async () => ({ revision: 'r1', entryVersion: 'a' }));
  const readSource = vi.fn(async () => source('a'));
  const ready = vi.fn();
  void Promise.all([boot.readEditorOpeningSource(project, entry, readSource), boot.readEditorOpeningTree(project, readTree, scoped)]).then(ready);
  await vi.advanceTimersByTimeAsync(0);
  expect(ready).toHaveBeenCalledOnce();
  expect(readTree).toHaveBeenCalledOnce();
  expect(readSource).toHaveBeenCalledOnce();
  expect(boot.hasEditorOpeningPreload(project)).toBe(true); // The stream must still request its opening head.
  if (event) boot.noteOpeningFileChange(project);
  expect(boot.noteOpeningConnection(project, head)).toBe(catchUp);
  expect(boot.noteOpeningConnection(project, head)).toBe(false);
  expect(boot.hasEditorOpeningPreload(project)).toBe(false);
});

it.each(['other project', 'other revision', 'file race'])('does not bypass the stream on %s', async reason => {
  vi.useFakeTimers();
  const boot = await import('./editorOpeningValidation');
  const read = vi.fn().mockResolvedValueOnce({ revision: 'r1', entryVersion: 'a' })
    .mockResolvedValue({ revision: 'r2', entryVersion: 'b' });
  const head = reason === 'other project' ? { ...scoped, projectId: 'other' }
    : reason === 'other revision' ? { ...scoped, revision: 'old' } : scoped;
  const ready = vi.fn();
  const tree = boot.readEditorOpeningTree(project, read, head).then(ready);
  if (reason === 'file race') boot.noteOpeningFileChange(project);
  await vi.advanceTimersByTimeAsync(1199);
  expect(ready).not.toHaveBeenCalled();
  expect(boot.noteOpeningConnection(project, 'r2')).toBe(false);
  await tree;
  expect(ready).toHaveBeenCalledWith({ revision: 'r2', entryVersion: 'b' });
  expect(read).toHaveBeenCalledTimes(2);
});

it('gives the already-connected head precedence over an earlier authorized head', async () => {
  const boot = await import('./editorOpeningValidation');
  const preload = Promise.withResolvers<{ revision: string; entryVersion: string }>();
  const read = vi.fn().mockReturnValueOnce(preload.promise).mockResolvedValue({ revision: 'r2', entryVersion: 'b' });
  const tree = boot.readEditorOpeningTree(project, read, scoped);
  expect(boot.noteOpeningConnection(project, 'r2')).toBe(false);
  preload.resolve({ revision: 'r1', entryVersion: 'a' });
  expect((await tree).entryVersion).toBe('b');
  expect(read).toHaveBeenCalledTimes(2);
});

it('only lets the current overlapping tree read release the waiting entry source', async () => {
  const boot = await import('./editorOpeningValidation');
  const first = Promise.withResolvers<{ revision: string; entryVersion: string }>();
  const latest = Promise.withResolvers<{ revision: string; entryVersion: string }>();
  const stale = boot.readEditorOpeningTree(project, () => first.promise, scoped);
  const tree = boot.readEditorOpeningTree(project, () => latest.promise, scoped);
  const read = vi.fn(async () => source('a'));
  const file = boot.readEditorOpeningSource(project, entry, read);
  first.reject(new Error('superseded'));
  await expect(stale).rejects.toThrow('superseded');
  latest.resolve({ revision: 'r1', entryVersion: 'a' });
  await Promise.all([tree, file]);
  expect(read).toHaveBeenCalledOnce();
  expect(boot.noteOpeningConnection(project, 'r1')).toBe(false);
});

it.each(['before', 'during'])('rechecks the entry when a new connected head arrives %s the source read', async timing => {
  const boot = await import('./editorOpeningValidation');
  await boot.readEditorOpeningTree(project, async () => ({ revision: 'r1', entryVersion: 'a' }), scoped);
  const delayed = Promise.withResolvers<ReturnType<typeof source>>();
  const read = vi.fn().mockReturnValueOnce(delayed.promise).mockResolvedValue(source('b'));
  if (timing === 'before') expect(boot.noteOpeningConnection(project, 'r2')).toBe(true);
  const file = boot.readEditorOpeningSource(project, entry, read);
  if (timing === 'during') expect(boot.noteOpeningConnection(project, 'r2')).toBe(true);
  delayed.resolve(source('a'));
  expect((await file).data).toEqual(source('b').data);
  expect(read).toHaveBeenLastCalledWith({ version: 'a', content: 'a' });
});

it('does not downgrade a known file version even when both preloads match the scoped snapshot', async () => {
  const boot = await import('./editorOpeningValidation');
  const { readCurrentProjectSource } = await import('./readCurrentProjectSource');
  const { rememberSource, confirmedSource } = await import('./confirmedTextSources');
  rememberSource(project, 'index.html', { version: 'b', content: 'newer' });
  const response = (version: string, content: string) => Response.json({ version, content }, { headers: { 'X-OpenMotion-Text-Edits': '1' } });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response('a', 'older')).mockResolvedValueOnce(response('b', 'newer'));
  try {
    await boot.readEditorOpeningTree(project, async () => ({ revision: 'r1', entryVersion: 'a' }), scoped);
    expect((await readCurrentProjectSource(project, 'index.html')).data?.content).toBe('newer');
    expect(confirmedSource(project, 'index.html')).toEqual({ version: 'b', content: 'newer' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { fetcher.mockRestore(); }
});

it('does not use the old entry version for a delayed source once the silent-stream deadline expires', async () => {
  vi.useFakeTimers();
  const boot = await import('./editorOpeningValidation');
  const catchUp = vi.fn();
  boot.watchOpeningDeadline(project, catchUp);
  const delayed = Promise.withResolvers<ReturnType<typeof source>>();
  const read = vi.fn().mockReturnValueOnce(delayed.promise).mockResolvedValue(source('b'));
  const file = boot.readEditorOpeningSource(project, entry, read);
  await boot.readEditorOpeningTree(project, async () => ({ revision: 'r1', entryVersion: 'a' }), scoped);
  await vi.advanceTimersByTimeAsync(1200);
  expect(catchUp).toHaveBeenCalledOnce();
  delayed.resolve(source('a'));
  expect((await file).data?.version).toBe('b');
  expect(read).toHaveBeenLastCalledWith({ content: 'a', version: 'a' });
  // Further writes in the still-unsubscribed interval also need reconciliation.
  expect(boot.noteOpeningConnection(project, 'r3')).toBe(true);
});

it("accepts matching speculative reads without a second tree or source request", async () => {
  const boot = await import("./editorOpeningValidation");
  const readTree = vi.fn(async () => ({ revision: "r1", entryVersion: "a" }));
  const readSource = vi.fn(async () => source("a"));
  const tree = boot.readEditorOpeningTree(project, readTree);
  const file = boot.readEditorOpeningSource(project, entry, readSource);
  boot.noteOpeningConnection(project, "r1");
  await Promise.all([tree, file]);
  expect(readTree).toHaveBeenCalledTimes(1);
  expect(readSource).toHaveBeenCalledTimes(1);
});

it("handles a commit before subscription and another while checking the tree", async () => {
  const boot = await import("./editorOpeningValidation");
  const reread = Promise.withResolvers<{ revision: string; entryVersion: string }>();
  const readTree = vi.fn().mockResolvedValueOnce({ revision: "r1", entryVersion: "a" })
    .mockReturnValueOnce(reread.promise).mockResolvedValue({ revision: "r3", entryVersion: "c" });
  const readSource = vi.fn().mockResolvedValueOnce(source("a")).mockResolvedValue(source("c"));
  const tree = boot.readEditorOpeningTree(project, readTree);
  const file = boot.readEditorOpeningSource(project, entry, readSource);
  boot.noteOpeningConnection(project, "r2");
  await vi.waitFor(() => expect(readTree).toHaveBeenCalledTimes(2));
  boot.noteOpeningFileChange(project);
  reread.resolve({ revision: "r2", entryVersion: "b" });
  expect((await tree).entryVersion).toBe("b");
  expect(readTree).toHaveBeenCalledTimes(2);
  expect((await file).data?.version).toBe("c");
  expect(readSource).toHaveBeenLastCalledWith({ content: "a", version: "a" });
});

it("conditionally refetches a mismatched entry even when the project tree matches", async () => {
  const boot = await import("./editorOpeningValidation");
  const read = vi.fn().mockResolvedValueOnce(source("a")).mockResolvedValue(source("b"));
  boot.noteOpeningConnection(project, "r2");
  await boot.readEditorOpeningTree(project, async () => ({ revision: "r2", entryVersion: "b" }));
  expect((await boot.readEditorOpeningSource(project, entry, read)).data?.version).toBe("b");
  expect(read).toHaveBeenCalledTimes(2);
});

it("uses a fresh read on a stalled stream and catches up once when connectivity returns", async () => {
  vi.useFakeTimers();
  const boot = await import("./editorOpeningValidation");
  const read = vi.fn().mockResolvedValueOnce({ revision: "r1", entryVersion: "a" })
    .mockResolvedValue({ revision: "r2", entryVersion: "b" });
  const tree = boot.readEditorOpeningTree(project, read);
  await vi.advanceTimersByTimeAsync(1300);
  expect((await tree).revision).toBe("r2");
  expect(boot.noteOpeningConnection(project, "r3")).toBe(true);
  expect(boot.noteOpeningConnection(project, "r3")).toBe(false);
});

it("starts a new head check when returning to a project whose opening was interrupted", async () => {
  const boot = await import("./editorOpeningValidation");
  const delayed = Promise.withResolvers<{ revision: string; entryVersion: string }>();
  const firstRead = vi.fn().mockReturnValueOnce(delayed.promise).mockResolvedValue({ revision: "r1", entryVersion: "a" });
  const old = boot.readEditorOpeningTree(project, firstRead);
  boot.noteOpeningConnection(project, "r1");
  boot.leaveEditorOpening(project);
  expect(boot.hasEditorOpeningPreload("another-project")).toBe(false);
  const current = vi.fn().mockResolvedValueOnce({ revision: "r1", entryVersion: "a" })
    .mockResolvedValue({ revision: "r2", entryVersion: "b" });
  const revisit = boot.readEditorOpeningTree(project, current);
  boot.noteOpeningConnection(project, "r2");
  delayed.resolve({ revision: "r1", entryVersion: "a" });
  await old;
  expect((await revisit).entryVersion).toBe("b");
  expect((await boot.readEditorOpeningSource(project, entry, async () => source("b"))).data?.version).toBe("b");
  expect(boot.hasEditorOpeningPreload(project)).toBe(false);
});

it("does not turn unrelated changes into repeated tree queries on an active project", async () => {
  const boot = await import("./editorOpeningValidation");
  boot.noteOpeningConnection(project, "r2");
  let calls = 0;
  const tree = await boot.readEditorOpeningTree(project, async () => {
    boot.noteOpeningFileChange(project);
    return { revision: "r" + (++calls), entryVersion: "a" };
  });
  expect(tree.revision).toBe("r2");
  expect(calls).toBe(2);
});
