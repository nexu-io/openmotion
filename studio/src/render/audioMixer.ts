import type { TimelineElement } from "../player/store/timelineElement";
import { STUDIO_API_SAME_ORIGIN_CREDENTIALS } from "../components/editor/manualEditingAvailability";
import { resolveOriginalPreviewMediaUrl } from "./browserExportPreflight";

const MIX_SAMPLE_RATE = 48_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function fetchMediaCredentials(): RequestCredentials {
  if (STUDIO_API_SAME_ORIGIN_CREDENTIALS) return "same-origin";
  const host = globalThis.location?.hostname;
  return !host || LOOPBACK_HOSTS.has(host) ? "omit" : "same-origin";
}

export function isAudibleElement(el: TimelineElement): boolean {
  if (el.hidden || el.muted || el.audioGroupHidden || !el.src) return false;
  if (el.tag === "audio" || el.kind === "audio") return true;
  if (el.tag === "video" || el.kind === "video") return el.hasAudio !== false;
  return false;
}

export interface MixedAudioResult {
  audioBuffer: AudioBuffer;
  trackCount: number;
}

/**
 * Decode and mix all audible timeline clips into a stereo 48kHz AudioBuffer
 * using the browser's OfflineAudioContext, respecting trim, rate, volume and fades.
 */
export async function mixTimelineAudio(options: {
  projectId: string;
  elements: readonly TimelineElement[];
  duration: number;
  signal?: AbortSignal;
}): Promise<MixedAudioResult | null> {
  const { projectId, elements, duration, signal } = options;
  const audible = elements.filter(isAudibleElement);
  if (audible.length === 0) return null;

  const OfflineCtx =
    globalThis.OfflineAudioContext ??
    (globalThis as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  if (!OfflineCtx) return null;

  const totalFrames = Math.max(1, Math.ceil(duration * MIX_SAMPLE_RATE));
  const ctx = new OfflineCtx(2, totalFrames, MIX_SAMPLE_RATE);
  const decodedCache = new Map<string, Promise<AudioBuffer | null>>();

  const loadBuffer = (url: string): Promise<AudioBuffer | null> => {
    let cached = decodedCache.get(url);
    if (!cached) {
      cached = (async () => {
        const response = await fetch(url, {
          credentials: fetchMediaCredentials(),
          signal,
        });
        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
          return await ctx.decodeAudioData(arrayBuffer);
        } catch {
          // Video files without an audio stream fail decodeAudioData; skip cleanly.
          return null;
        }
      })();
      decodedCache.set(url, cached);
    }
    return cached;
  };

  const origin = globalThis.location?.origin;
  const entries = await Promise.all(
    audible.map(async (el) => {
      const url = resolveOriginalPreviewMediaUrl(el.src!, projectId, origin);
      const buffer = await loadBuffer(url);
      return { el, buffer };
    }),
  );

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  let scheduledCount = 0;
  for (const { el, buffer } of entries) {
    if (!buffer) continue;
    const clipStart = Math.max(0, el.start);
    if (clipStart >= duration) continue;
    const clipDuration = Math.min(el.duration, duration - clipStart);
    if (clipDuration <= 0) continue;

    const rate = Math.max(0.0625, Math.min(16, el.playbackRate ?? 1));
    const mediaOffset = Math.max(0, el.playbackStart ?? 0);
    if (mediaOffset >= buffer.duration) continue;

    const maxSourceSpan = Math.max(0, buffer.duration - mediaOffset);
    const playDuration = Math.min(clipDuration, maxSourceSpan / rate);
    // AudioBufferSourceNode.start's third parameter is source-buffer duration,
    // independent of playbackRate; convert timeline seconds to source seconds.
    const sourceDuration = Math.min(maxSourceSpan, playDuration * rate);
    if (playDuration <= 0 || sourceDuration <= 0) continue;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;

    const gainNode = ctx.createGain();
    const baseGain = Math.max(0, (el.volume ?? 1) * (el.audioGroupVolume ?? 1));
    const fadeIn = Math.max(0, Math.min(playDuration / 2, el.fadeIn ?? 0));
    const fadeOut = Math.max(0, Math.min(playDuration / 2, el.fadeOut ?? 0));

    if (fadeIn > 0) {
      gainNode.gain.setValueAtTime(0, clipStart);
      gainNode.gain.linearRampToValueAtTime(baseGain, clipStart + fadeIn);
    } else {
      gainNode.gain.setValueAtTime(baseGain, clipStart);
    }

    if (fadeOut > 0) {
      const fadeOutStart = Math.max(clipStart + fadeIn, clipStart + playDuration - fadeOut);
      gainNode.gain.setValueAtTime(baseGain, fadeOutStart);
      gainNode.gain.linearRampToValueAtTime(0, clipStart + playDuration);
    }

    source.connect(gainNode);
    gainNode.connect(ctx.destination);
    source.start(clipStart, mediaOffset, sourceDuration);
    scheduledCount += 1;
  }

  if (scheduledCount === 0) return null;
  const audioBuffer = await ctx.startRendering();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return { audioBuffer, trackCount: scheduledCount };
}
