import { thumbnailScheduler } from "./lib/thumbnailScheduler";

let reloading = false;
let reloadRequested = false;
let scriptWrites = 0;
const scriptWriteListeners = new Set<() => void>();

export function previewScriptWritePending() { return scriptWrites > 0 && !givenUp; }
export function subscribePreviewScriptWrites(listener: () => void) {
  scriptWriteListeners.add(listener);
  return () => { scriptWriteListeners.delete(listener); };
}
// A press gave up on the change in progress (a save that never returns); later ones do not wait on it again.
let givenUp = false;

const changing = () => reloading || reloadRequested || scriptWrites > 0;
const noteIdle = () => {
  if (!changing()) givenUp = false;
  // Scene swaps and pending saves use the same server as composition thumbnails.
  // Reserve it for the preview from the request through the final painted frame.
  thumbnailScheduler.setPreviewReloading(changing());
  globalThis.document?.documentElement.toggleAttribute(
    "data-preview-changing",
    isPreviewChanging(),
  );
};

export function giveUpOnPreviewChange(): void {
  givenUp = changing();
  noteIdle();
  for (const listener of scriptWriteListeners) listener();
}

export function setPreviewReloading(next: boolean): void {
  reloading = next;
  noteIdle();
}

/** Studio asked for a reload that has not begun yet; `previewReloadBegun` closes that gap. */
export function requestPreviewReload(): void {
  reloadRequested = true;
  noteIdle();
}

export function previewReloadBegun(): void {
  reloadRequested = false;
  noteIdle();
}

/** A script write, scene swap or history step counts from its send until its preview update is applied, or it fails. */
export async function whileScriptWrites<T>(write: (release: () => void) => Promise<T>): Promise<T> {
  scriptWrites += 1;
  noteIdle();
  let active = true;
  const release = () => {
    if (!active) return;
    active = false;
    scriptWrites -= 1;
    noteIdle();
    if (!scriptWrites) for (const listener of scriptWriteListeners) listener();
  };
  try { return await write(release); }
  finally { release(); }
}

/** The one owner of "the preview is about to change": a canvas press waits for it. */
export function isPreviewChanging(): boolean {
  return changing() && !givenUp;
}
