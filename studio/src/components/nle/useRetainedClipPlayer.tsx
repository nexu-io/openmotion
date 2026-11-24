import { Fragment, cloneElement, useLayoutEffect, useRef, useState, type ReactElement, type RefAttributes, type RefObject } from "react";
import { readMountedSource } from "../../hooks/syncPeerComposition";
import { addExternalFileReloadListener } from "../../hooks/externalFileReloadBus";
import { hasStudioFileSave } from "../../utils/studioSaveState";
import type { PlayerProps } from "../../player/components/Player";
import { getCompositionCacheKeyRevision } from "../../player/lib/clientCompositionCapture";
import { isolatedPreviewOrigin } from "../../player/lib/previewLease";
import { compositionPathOfPreviewUrl } from "../../utils/projectCompositionPath";
import { usePlayerStore } from "../../player/store/playerStore";
import { thumbnailRevisionOf } from "../../player/store/thumbnailSlice";
import { isUnrelatedPreviewHtmlChange } from "../../player/lib/previewHtmlSources";
import { mountedPeerFileVersion, tryApplyPeerChanges } from "../../player/peerTimingPreview";
import { isPreviewChanging } from "../../player/previewReloading";

type PlayerElement = ReactElement<PlayerProps & RefAttributes<HTMLIFrameElement>>;
type Visit = {
  project: string;
  url?: string;
  id: number;
  settling?: boolean;
  resumedSlot?: { key: string; mountedKey: string };
};
type Parked = Visit & {
  path: string;
  frame: HTMLIFrameElement;
  player: PlayerElement;
  revision: string;
  pending: number;
};

function clipRevision(project: string, path: string) {
  return getCompositionCacheKeyRevision(project, path, thumbnailRevisionOf(usePlayerStore.getState().thumbnailRevisions, path));
}

type Visits = { active: Visit; parked: Parked | null; serial: number };

/** Keep one painted clip. Never reorder mounted iframe nodes: Chromium would navigate them again. */
export function useRetainedClipPlayers(
  project: string, url: string | undefined, frame: RefObject<HTMLIFrameElement | null>,
  players: PlayerElement[], live: PlayerElement | undefined,
) {
  const [visits, setVisits] = useState<Visits>({ active: { project, url, id: 0 }, parked: null, serial: 0 });
  const lastPlayer = useRef<PlayerElement | undefined>(undefined);

  const { active, parked, serial } = visits;
  // Live/shadow generation belongs to the foreground coordinator. Returning to a
  // patched clip after another clip promoted its shadow must preserve its DOM key.
  const renderedLive = active.resumedSlot && live?.key === active.resumedSlot.key
    ? cloneElement(live, { key: active.resumedSlot.mountedKey }) : live;
  useLayoutEffect(() => { lastPlayer.current = renderedLive; }, [renderedLive]);
  if (active.project !== project || active.url !== url) {
    const reuse = parked && parked.project === project && parked.url === url &&
      parked.frame.dataset.clipPainted === "true" &&
      parked.revision === clipRevision(project, parked.path);
    const path = active.url && compositionPathOfPreviewUrl(active.url);
    const previous = active.project === project && isolatedPreviewOrigin() && path && path !== "index.html" && lastPlayer.current &&
      frame.current?.dataset.clipPainted === "true" && !hasStudioFileSave(project, path) && !isPreviewChanging()
      ? { ...active, path, frame: frame.current, player: lastPlayer.current,
          revision: clipRevision(project, path), pending: 0 }
      : null;
    const resumedSlot = reuse && live?.key && parked.player.key
      ? { key: live.key, mountedKey: parked.player.key } : undefined;
    setVisits({ active: { project, url, id: reuse ? parked.id : serial + 1, resumedSlot, settling: !!(reuse && parked.pending) }, serial: serial + 1, parked: previous });
  }
  useLayoutEffect(() => {
    if (!parked) return;
    let failed = false;
    const current = () => !failed && parked.frame.isConnected;
    let queue = Promise.resolve();
    const discard = () => {
      if (!current()) return;
      failed = true;
      setVisits(v => {
        if (v.parked === parked) return { ...v, parked: null };
        if (v.active.id !== parked.id) return v;
        return { ...v, serial: v.serial + 1, active: { project, url: v.active.url, id: v.serial + 1 } };
      });
    };
    const stop = addExternalFileReloadListener((path, read, change) => {
      if (!current() || change?.projectId !== project) return;
      if (path === ".") { discard(); return; }
      const revision = clipRevision(project, parked.path);
      if (path !== parked.path && !mountedPeerFileVersion(parked.frame, path)) {
        // Source revisions also count possible nested dependencies. A mounted
        // document with a complete source graph can rule out an unrelated sibling.
        if (isUnrelatedPreviewHtmlChange(parked.frame, project, parked.path, [path], change.treeChanged)) {
          parked.revision = revision;
        } else if (parked.revision !== revision || change.paths?.includes(parked.path)) {
          discard();
        }
        return;
      }

      parked.revision = revision;
      parked.pending++;
      queue = queue.then(async () => {
        if (!current()) return;
        // A full-file upload may omit an inline delta. Read only this resident
        // file, then use the same version-checked DOM update as ordered edits.
        const mounted = mountedPeerFileVersion(parked.frame, path);
        const [previous, next] = await Promise.all([
          !mounted || mounted === change.previous?.version ? change.previous : readMountedSource(project, mounted),
          change.current ?? read?.(project, path),
        ]);
        if (!previous || !next?.version || typeof next.content !== "string" || !current()) { discard(); return; }
        const applied = await tryApplyPeerChanges(parked.frame, {
          path, previous, current: { content: next.content, version: next.version },
        }, current);
        if (!applied) discard();
      }).catch(discard).finally(() => {
        if (--parked.pending || !current()) return;
        setVisits(v => v.active.id === parked.id && v.active.settling
          ? { ...v, active: { ...v.active, settling: false } } : v);
      });
    });
    // An ACK can follow a switch back to this still-mounted document.
    return stop;
  }, [parked, project]);

  const park = (player: PlayerElement, visible: boolean) => cloneElement(player, {
    ref: null, parked: true, inert: true, style: visible ? player.props.style : { display: "none" },
  });
  const activePlayers = players.map(player =>
    player !== live || !renderedLive ? player : active.settling ? park(renderedLive, true) : renderedLive);
  const groups = [{ id: active.id, players: activePlayers }];
  if (parked) groups.push({ id: parked.id, players: [park(parked.player, false)] });
  return groups.sort((a, b) => a.id - b.id).map(group => <Fragment key={group.id}>{group.players}</Fragment>);
}
