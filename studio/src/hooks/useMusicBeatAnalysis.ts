import type { BeatGridCommand } from '../../../packages/edit-core/commands';
import { writeBeatGrid } from '../../../packages/edit-core/beat-file';
import { supportsProjectTextEdits } from '../utils/confirmedTextSources';
import { runOrderedProjectBarrier } from '../utils/orderedProjectEdits';
import { StudioFileConflictError } from '../utils/studioSaveDiagnostics';
import { commitTextEdits } from '../utils/studioTextEdits';
import { serializeStudioFileMutation } from '../utils/studioFileMutationCoordinator';
import { getCachedCloudDisklessMode } from '../utils/cloudRuntime';
import { useEffect, useMemo, useRef, useState } from "react";
import type { RemoteFileRead } from "./remoteFileReads";
import { addExternalFileReloadListener } from "./externalFileReloadBus";
import { usePlayerStore } from "../player/store/playerStore";
import { resolveBeatSourceTrack } from "../utils/timelineInspector";
import { resolveProjectMediaUrl } from "../player/components/thumbnailUtils";
import { analyzeMusicFromUrl } from "@hyperframes/core/beats";
import { whenTimelineIdle } from "../player/components/timelineMotion";
import { useFileManagerContextOptional } from "../contexts/FileManagerContext";
import { mergeUserBeats } from "../utils/beatEditing";
import { getTimelineElementIndexes } from "../player/lib/timelineElementIndexes";
import { remapBeatAnalysisToComposition } from "../utils/beatEditActions";
import {
  audioRelPathForSrc,
  beatFilePathForSrc,
  parseBeats,
} from "@hyperframes/core/beats";

// Module-level cache so the same URL isn't re-decoded/analyzed on re-mount.
// Capped so decoded PCM buffers don't accumulate unbounded across a session.
const analysisCache = new Map<string, ReturnType<typeof analyzeMusicFromUrl>>();
const MAX_ANALYSIS_CACHE = 4;

const PERSIST_DEBOUNCE_MS = 350;

function cacheAnalysis(url: string, promise: ReturnType<typeof analyzeMusicFromUrl>): void {
  analysisCache.set(url, promise);
  while (analysisCache.size > MAX_ANALYSIS_CACHE) {
    const oldest = analysisCache.keys().next().value;
    if (oldest === undefined) break;
    analysisCache.delete(oldest);
  }
}

type BeatBase = { content: string; version: string | null };
type ProjectIo = { readOptionalProjectFile: (path: string, observe?: (base: BeatBase) => void) => Promise<string> };

async function detectBeats(url: string, key: string) {
  let result = analysisCache.get(key);
  if (!result) {
    result = analyzeMusicFromUrl(url, { pause: whenTimelineIdle }).catch(error => {
      if (analysisCache.get(key) === result) analysisCache.delete(key);
      throw error;
    });
    cacheAnalysis(key, result);
  }
  return result;
}

/** The current beat analysis, remapped onto the composition's edited beat grid. */
export function useAdjustedBeatAnalysis() {
  const beatAnalysis = usePlayerStore((s) => s.beatAnalysis);
  const musicElement = usePlayerStore((s) => getTimelineElementIndexes(s.elements).musicElement);
  const beatEdits = usePlayerStore((s) => s.beatEdits);
  return useMemo(
    () => remapBeatAnalysisToComposition(beatAnalysis, musicElement, beatEdits),
    [beatAnalysis, musicElement, beatEdits],
  );
}

export function useMusicBeatAnalysis(): void {
  const elements = usePlayerStore((s) => s.elements);
  const setBeatAnalysis = usePlayerStore((s) => s.setBeatAnalysis);
  const setBeatEdits = usePlayerStore((s) => s.setBeatEdits);
  const setBeatPersist = usePlayerStore((s) => s.setBeatPersist);
  const resetBeatHistory = usePlayerStore((s) => s.resetBeatHistory);
  const fileManager = useFileManagerContextOptional();
  const readOptionalProjectFile = fileManager?.readOptionalProjectFile;
  const writeProjectFile = fileManager?.writeProjectFile;

  // File IO via ref so the effects only re-run when the track changes.
  const ioRef = useRef<
    (ProjectIo & { writeProjectFile: (p: string, c: string, before?: string, command?: BeatGridCommand) => Promise<void> }) | null
  >(null);
  ioRef.current =
    readOptionalProjectFile && writeProjectFile
      ? { readOptionalProjectFile, writeProjectFile }
      : null;

  const projectId = usePlayerStore((s) => s.timelineProjectId);
  const { musicSrc, isFallbackTrack } = useMemo(() => {
    const resolved = resolveBeatSourceTrack(elements);
    return {
      musicSrc: resolveProjectMediaUrl(
        resolved?.element.src,
        projectId,
        typeof window !== "undefined" ? window.location.origin : undefined,
      ),
      isFallbackTrack: resolved?.isFallback ?? false,
    };
  }, [elements, projectId]);

  const asset = audioRelPathForSrc(musicSrc ?? "");
  const assetVersion = asset ? fileManager?.assetMetadata?.[asset]?.version : undefined;
  const [reload, setReload] = useState(0);
  const refreshTree = useRef(fileManager?.refreshFileTree);
  refreshTree.current = fileManager?.refreshFileTree;
  const observed = useRef<{ path: string; assetVersion: string; base: BeatBase } | null>(null);

  // ── Load: decode for strength data, then use the saved beat file if present,
  //    otherwise seed it from detection. Resets edits + history on track change. ──
  useEffect(() => {
    observed.current = null;
    if (!musicSrc) {
      setBeatAnalysis(null);
      setBeatEdits(null);
      resetBeatHistory();
      return;
    }
    if (!ioRef.current) {
      setBeatAnalysis(null);
      setBeatEdits(null);
      resetBeatHistory();
      return;
    }
    const beatPath = beatFilePathForSrc(musicSrc);
    if (!beatPath) return;
    const io = ioRef.current;
    let generation = 0;
    const key = JSON.stringify([musicSrc, assetVersion]);
    setBeatAnalysis(null);

    const loadGrid = async (read?: RemoteFileRead) => {
      const turn = ++generation;
      let base: BeatBase | undefined;
      const shared = projectId && read?.(projectId, beatPath);
      const content = shared ? await shared.then(file => {
        if (file.missing) base = { content: "", version: null };
        else if (typeof file.content === "string" && file.version) base = { content: file.content, version: file.version };
        return file.content;
      }) : await io.readOptionalProjectFile(beatPath, value => { base = value; }).catch(() => "");
      if (turn !== generation) return;
      const saved = content ? parseBeats(content) : null;
      // Named music opts in through an authored grid. A fallback audio track can seed its first grid.
      if (!isFallbackTrack && !saved?.times.length) {
        observed.current = null;
        setBeatAnalysis(null);
        setBeatEdits(null);
        resetBeatHistory();
        return;
      }
      const analysis = await detectBeats(musicSrc, key);
      if (turn !== generation) return;
      observed.current = assetVersion && base ? { path: beatPath, assetVersion, base } : null;
      setBeatEdits(null);
      resetBeatHistory();
      setBeatAnalysis({ ...analysis, beatTimes: saved?.times.length ? saved.times : analysis.beatTimes,
        beatStrengths: saved?.times.length ? saved.strengths : analysis.beatStrengths });
    };
    const refresh = (read?: RemoteFileRead) => { void loadGrid(read).catch(() => {}); };
    refresh();
    const unsubscribe = addExternalFileReloadListener((changed, read) => {
      if (changed === beatPath || changed === ".") refresh(read);
    });
    return () => {
      generation++;
      unsubscribe();
      observed.current = null;
    };
  }, [musicSrc, projectId, assetVersion, isFallbackTrack, reload, setBeatAnalysis, setBeatEdits, resetBeatHistory]);

  // ── Persist: register a debounced writer fired by every beat edit/undo/redo.
  //    Flushes any pending write on cleanup so the last edit is never lost. ──
  useEffect(() => {
    const beatPath = beatFilePathForSrc(musicSrc);
    if (!musicSrc || !beatPath || !ioRef.current) {
      setBeatPersist(null);
      return;
    }
    const io = ioRef.current;
    const audio = audioRelPathForSrc(musicSrc) ?? "audio";
    const invalidated = new WeakSet<object>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: { command: BeatGridCommand; input: typeof observed.current } | null = null;

    const flush = () => {
      if (pending === null) return;
      const { command, input } = pending;
      const content = writeBeatGrid(command.assetPath, command.beats);
      pending = null;
      if (projectId && input?.path === beatPath && supportsProjectTextEdits(projectId)) {
        // A second local save uses the receipt of its predecessor. A replacement or a concurrent
        // first creation still conflicts against the exact input captured during beat analysis.
        const save = () => runOrderedProjectBarrier(projectId, async () => {
          if (invalidated.has(input)) return;
          const result = await commitTextEdits(projectId, [{ path: beatPath, before: input.base.content, after: content,
            version: input.base.version }], { label: 'Edit beat markers', dependencies: { [audio]: input.assetVersion }, beatAssets: [audio] });
          const version = result.versions[beatPath];
          if (version) input.base = { content, version };
        });
        void serializeStudioFileMutation(io.writeProjectFile, beatPath, async () => {
          try { await save(); }
          catch (error) {
            if (!(error instanceof StudioFileConflictError)) return; // The shared save state reports this failure.
            invalidated.add(input);
            if (observed.current !== input) return;
            if (error.filePath === audio) await refreshTree.current?.();
            if (observed.current === input) setReload(value => value + 1);
          }
        }).catch(() => {});
        return;
      }
      const write = getCachedCloudDisklessMode()
        ? io.writeProjectFile(beatPath, content, undefined, command)
        : io.writeProjectFile(beatPath, content);
      void write.catch(() => {});
    };

    const persist = () => {
      const s = usePlayerStore.getState();
      const a = s.beatAnalysis;
      if (!a) return;
      const merged = mergeUserBeats(a.beatTimes, a.beatStrengths, s.beatEdits, musicSrc);
      pending = { input: observed.current, command: { kind: 'setBeatGrid', assetPath: audio,
        beats: merged.times.map((time, index) => ({ time, strength: merged.strengths[index] ?? 0.5 })) } };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, PERSIST_DEBOUNCE_MS);
    };

    setBeatPersist(persist);
    return () => {
      if (timer) clearTimeout(timer);
      flush(); // write the last pending edit before tearing down
      setBeatPersist(null);
    };
  }, [musicSrc, assetVersion, projectId, setBeatPersist]);
}
