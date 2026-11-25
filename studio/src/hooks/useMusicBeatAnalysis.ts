import { writeBeatGrid } from '../../../packages/edit-core/beat-file';
import { supportsOrderedTextEdits } from '../utils/confirmedTextSources';
import { enqueueProjectEdit } from '../utils/orderedProjectEdits';
import { StudioFileConflictError } from '../utils/studioSaveDiagnostics';
import { readStudioAssetVersion } from '../utils/studioTextEdits';
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
type ProjectIo = {
  readOptionalProjectFile: (path: string, observe?: (base: BeatBase) => void) => Promise<string>;
  writeProjectFile: (path: string, content: string) => Promise<void>;
};
type BeatInput = { path: string; assetVersion: string; base: Promise<BeatBase>; conflict?: StudioFileConflictError };

/** Each completed gesture owns a place in the project queue, including the first sidecar creation. */
function saveBeatGrid(project: string, audio: string, input: BeatInput, content: string) {
  const { path, assetVersion, base: previous } = input;
  const save = enqueueProjectEdit(project, path, async drafts => {
    const base = drafts.get(path) ?? await previous;
    if (input.conflict) throw input.conflict;
    return { label: 'Edit beat markers', edits: [{ path, before: base.content, after: content, version: base.version }],
      dependencies: { [audio]: assetVersion }, beatAssets: [audio] };
  });
  // A following packet uses our last receipt, never a newly fetched peer grid as the base of an old edit.
  input.base = save.then(saved => ({ content, version: saved.versions[path] ?? null }), error => {
    if (error instanceof StudioFileConflictError) input.conflict = error;
    return previous;
  });
  return save;
}

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
  const ioRef = useRef<ProjectIo | null>(null);
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
  const observed = useRef<BeatInput | null>(null);

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
    let mediaVersion = assetVersion;
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
      const ordered = projectId && supportsOrderedTextEdits(projectId);
      if (ordered && !base) return; // An unavailable sidecar must not be mistaken for an empty grid.
      const version = mediaVersion ?? (ordered && asset ? await readStudioAssetVersion(projectId, asset) : undefined);
      if (turn !== generation) return;
      mediaVersion = version;
      const analysis = await detectBeats(musicSrc, JSON.stringify([musicSrc, version]));
      if (turn !== generation) return;
      observed.current = version && base ? { path: beatPath, assetVersion: version, base: Promise.resolve(base) } : null;
      setBeatEdits(null);
      resetBeatHistory();
      setBeatAnalysis({ ...analysis, beatTimes: saved?.times.length ? saved.times : analysis.beatTimes,
        beatStrengths: saved?.times.length ? saved.strengths : analysis.beatStrengths });
    };
    // Reserve opening bandwidth for the first frame. A stalled preview must still allow beat editing.
    let stopWaiting: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const start = (read?: RemoteFileRead) => {
      stopWaiting?.();
      clearTimeout(timeout);
      void loadGrid(read).catch(() => {});
    };
    if (usePlayerStore.getState().previewBooted) start();
    else {
      stopWaiting = usePlayerStore.subscribe(state => {
        if (state.timelineProjectId === projectId && state.previewBooted) start();
      });
      timeout = setTimeout(start, 8_000);
    }
    const unsubscribe = addExternalFileReloadListener((changed, read) => {
      if (changed === asset || changed === ".") mediaVersion = undefined;
      if (changed === beatPath || changed === asset || changed === ".") start(read);
    });
    return () => {
      generation++;
      stopWaiting?.();
      clearTimeout(timeout);
      unsubscribe();
      stopWaiting?.();
      clearTimeout(timeout);
      observed.current = null;
    };
  }, [musicSrc, projectId, asset, assetVersion, isFallbackTrack, reload, setBeatAnalysis, setBeatEdits, resetBeatHistory]);

  // Beat gestures paint in the player store. The ordered writer batches transport while retaining each gesture.
  useEffect(() => {
    const beatPath = beatFilePathForSrc(musicSrc);
    if (!musicSrc || !beatPath || !ioRef.current) {
      setBeatPersist(null);
      return;
    }
    const io = ioRef.current;
    const audio = audioRelPathForSrc(musicSrc) ?? "audio";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingContent: string | undefined;

    const flushLegacyWrite = () => {
      if (pendingContent === undefined) return;
      void io.writeProjectFile(beatPath, pendingContent).catch(() => {});
      pendingContent = undefined;
    };

    const persist = () => {
      const s = usePlayerStore.getState();
      const a = s.beatAnalysis;
      if (!a) return;
      const merged = mergeUserBeats(a.beatTimes, a.beatStrengths, s.beatEdits, musicSrc);
      const content = writeBeatGrid(audio, merged.times.map((time, i) => ({ time, strength: merged.strengths[i] ?? 0.5 })));
      if (projectId && supportsOrderedTextEdits(projectId)) {
        const input = observed.current;
        if (!input || input.path !== beatPath) return;
        void saveBeatGrid(projectId, audio, input, content).catch(async error => {
          if (!(error instanceof StudioFileConflictError) || observed.current !== input) return;
          observed.current = null;
          setBeatAnalysis(null);
          if (error.filePath === audio) await refreshTree.current?.().catch(() => {});
          setReload(value => value + 1);
        });
        return;
      }
      pendingContent = content;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flushLegacyWrite, PERSIST_DEBOUNCE_MS);
    };

    setBeatPersist(persist);
    return () => {
      if (timer) clearTimeout(timer);
      flushLegacyWrite();
      setBeatPersist(null);
    };
  }, [musicSrc, assetVersion, projectId, setBeatAnalysis, setBeatPersist]);
}
