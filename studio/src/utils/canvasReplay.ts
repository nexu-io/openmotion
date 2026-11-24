import type { CompositionEdit } from "../../../packages/edit-core/commands";
import { isPaintOnlyChange } from "../../../shared/preview-timing";
import { diffMountedPreview } from "../player/peerTimingPreview";

/** Only replay a measured box when the entire intervening file change preserves its layout. */
export async function canReplayCanvasCommands(commands: readonly CompositionEdit[], previous: string, current: string): Promise<boolean> {
  if (!commands.length || !commands.every(command =>
    (command.kind === "moveCanvasElement" || command.kind === "setCanvasBox") &&
    Boolean(command.target.hfId || command.target.id))) return false;
  const changes = await diffMountedPreview(previous, current);
  return changes !== null && changes.every(isPaintOnlyChange);
}
