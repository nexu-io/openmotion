// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const project = "project-a", entry = "/api/projects/project-a/files/index.html";
const source = (version: string) => ({ response: new Response(), data: { version, content: version } });
beforeEach(() => {
  vi.resetModules();
  document.head.innerHTML = '<link rel="preload" data-editor-bootstrap href="/api/projects/project-a?view=editor">';
});
afterEach(() => { document.head.replaceChildren(); vi.useRealTimers(); });

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
