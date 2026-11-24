import type { CompositionEdit } from "../../../packages/edit-core/commands";
import { isPaintOnlyChange } from "../../../shared/preview-timing";
import { diffPreviewChanges } from "../player/peerTimingPreview";

/** Only replay a measured box when the entire intervening file change preserves its layout. */
export function canReplayCanvasCommands(commands: readonly CompositionEdit[], previous: string, current: string): boolean {
  if (!commands.length || !commands.every(command =>
    (command.kind === "moveCanvasElement" || command.kind === "setCanvasBox") &&
    Boolean(command.target.hfId || command.target.id))) return false;
  const changes = diffPreviewChanges(previous, current);
  return changes !== null && changes.every(isPaintOnlyChange);
}
