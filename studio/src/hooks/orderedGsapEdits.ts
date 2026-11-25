import { isolatedSourceVersion, mountedCanvasVersion } from "../components/editor/isolatedSourceTarget";
import { buildDomEditPatchTarget, type DomEditSelection } from "../components/editor/domEditing";
import type { ConfirmedSource } from "../utils/confirmedTextSources";
import { saveOrderedTimeline } from "../utils/orderedTimelineEdits";
import type { RecordEditInput, StudioWriteHistory } from "../utils/studioFileHistory";
import { GsapMutationHttpError } from "./gsapScriptCommitHelpers";
import { idSelector } from "./gsapShared";
import type { CommitMutationOptions, MutationResult } from "./gsapScriptCommitTypes";

type Projection = { result: MutationResult; targetId?: string };

async function editAnimation(
  source: string,
  mutations: readonly Record<string, unknown>[],
  selection: DomEditSelection,
  proposedId?: string,
): Promise<Projection> {
  const { applyGsapMutationsInMemory, validateGsapMutationPayload } =
    await import("../../../packages/edit-core/gsap-mutations");
  let before = source;
  let targetId: string | undefined;
  if (proposedId) {
    const { patchCanvasElement } = await import("../../../packages/edit-core/canvas-commands");
    const assigned = patchCanvasElement(source, {
      target: buildDomEditPatchTarget(selection),
      operations: [{ type: "ensure-id", property: "id", value: proposedId }],
    });
    if (!assigned.elementId) throw new Error("The selected animation target is no longer in the file.");
    before = assigned.html;
    targetId = assigned.elementId;
  }
  const commands = mutations.map((mutation) => {
    const command = targetId ? { ...mutation, targetSelector: idSelector(targetId) } : mutation;
    const valid = validateGsapMutationPayload(command);
    if (!valid.ok) throw new GsapMutationHttpError(400, valid);
    return valid.mutation;
  });
  const result = applyGsapMutationsInMemory(before, commands);
  if (!result.ok) throw new GsapMutationHttpError(result.status, result);
  return { result: { ...result, before: source, changed: source !== result.after }, targetId };
}

/** The runtime renders the local parse now. Persistence uses the existing file/operation chain. */
export async function saveOrderedGsapEdit(
  project: string,
  path: string,
  selection: DomEditSelection,
  mutations: readonly Record<string, unknown>[],
  options: CommitMutationOptions,
  history: StudioWriteHistory | undefined,
  recordEdit: (edit: RecordEditInput) => Promise<void>,
  present: (result: MutationResult) => void,
  confirm: (result: MutationResult, previous?: ConfirmedSource) => void,
): Promise<MutationResult> {
  const shownVersion = selection.isolatedTarget
    ? isolatedSourceVersion(selection.isolatedTarget)
    : selection.element && mountedCanvasVersion(selection.element.ownerDocument, project, path);
  let latest!: Projection;
  await saveOrderedTimeline(
    project,
    [
      {
        path,
        shownVersion,
        async apply(source) {
          latest = await editAnimation(source, mutations, selection, options.ensureTargetId);
          return latest.result.after!;
        },
      },
    ],
    options.label,
    {
      undoGroup: history?.continuous ? history.windowId : undefined,
      coalesceKey: options.coalesceKey,
      coalesceMs: options.coalesceMs,
      recordEdit,
      projectPending() {
        const { result, targetId } = latest;
        const el = selection.element;
        const id = el?.getAttribute("id");
        if (targetId && el && !id) el.id = targetId;
        present(result);
        if (targetId && el && !id)
          return () => {
            if (el.id === targetId) el.removeAttribute("id");
          };
      },
      onSaved: async (files, previous) => {
        const { result } = latest;
        const after = files[path]?.after;
        if (!after || result.after === after) return confirm(result, previous);
        // A later inspector edit may deliver this file's final paint for the animation.
        const { extractGsapScriptBlock, parseGsapAnimationsFromHtml } =
          await import("../../../packages/edit-core/gsap-mutations");
        confirm(
          {
            ...result,
            after,
            changed: result.before !== after,
            parsed: parseGsapAnimationsFromHtml(after),
            scriptText: extractGsapScriptBlock(after)?.scriptText,
          },
          previous,
        );
      },
    },
  );
  return latest.result;
}
