import { studioApiFetch } from "../../utils/studioApiFetch";
import { waitForMediaDerived } from "../../utils/mediaDerivedBus";

export class UnavailableAudioError extends Error {}

function extractPeaks(channelData: Float32Array, barCount: number): number[] {
  const peaks: number[] = [];
  const samplesPerBar = Math.floor(channelData.length / barCount);
  if (samplesPerBar === 0) return Array(barCount).fill(0);
  for (let index = 0; index < barCount; index++) {
    let max = 0;
    const start = index * samplesPerBar;
    const end = Math.min(start + samplesPerBar, channelData.length);
    for (let sample = start; sample < end; sample++) {
      max = Math.max(max, Math.abs(channelData[sample] ?? 0));
    }
    peaks.push(max);
  }
  const maxPeak = Math.max(...peaks, 0.001);
  return peaks.map((peak) => peak / maxPeak);
}

export async function loadWaveform(
  audioUrl: string,
  waveformUrl: string | undefined,
  signal: AbortSignal,
  sourceKind: "audio" | "video",
): Promise<number[]> {
  // Failures propagate: authors trim and beat-align against this, so made-up peaks beat no gap.
  // The scheduler caches the failure (metadataFailureTtlMs): no refetch loop, no stuck state.
  if (!waveformUrl) {
    if (sourceKind === "video") throw new Error("Video waveform requires server peaks");
    return await decodeWaveformPeaks(audioUrl, signal);
  }
  try {
    return await fetchWaveformPeaks(waveformUrl, signal);
  } catch (error) {
    // Missing media stays missing; a cancelled lease stays cancelled.
    if (sourceKind === "video" || error instanceof UnavailableAudioError || signal.aborted) throw error;
    // The server decodes with FFmpeg, which a first run may still be downloading (409) or lack
    // entirely (500). Decode audio sources locally, but never download whole video containers.
    return await decodeWaveformPeaks(audioUrl, signal);
  }
}

async function fetchWaveformPeaks(url: string, signal: AbortSignal): Promise<number[]> {
  const maxPendingAttempts = 12;
  let delayMs = 500;

  for (let attempt = 0; attempt < maxPendingAttempts; attempt += 1) {
    const response = await studioApiFetch(url, { signal });
    if (response.status === 404 || response.status === 410) {
      throw new UnavailableAudioError(`Waveform request failed (${response.status})`);
    }
    if (response.status === 202) {
      const pendingBody = (await response.json().catch(() => null)) as { sha256?: string } | null;
      const expectedSha = typeof pendingBody?.sha256 === "string" ? pendingBody.sha256 : undefined;
      const sseEvent = await waitForMediaDerived(
        (evt) => evt.kind === "waveform" && (!expectedSha || evt.sha256 === expectedSha),
        delayMs,
        signal,
      );
      if (sseEvent?.status === "failed") {
        throw new Error("Waveform extraction failed");
      }
      delayMs = Math.min(4000, Math.round(delayMs * 1.7));
      continue;
    }
    if (!response.ok) throw new Error(`Waveform request failed (${response.status})`);
    const data: unknown = await response.json();
    if (typeof data === "object" && data !== null && (data as { pending?: unknown }).pending === true) {
      const expectedSha =
        typeof (data as { sha256?: unknown }).sha256 === "string"
          ? ((data as { sha256: string }).sha256)
          : undefined;
      await waitForMediaDerived(
        (evt) => evt.kind === "waveform" && (!expectedSha || evt.sha256 === expectedSha),
        delayMs,
        signal,
      );
      delayMs = Math.min(4000, Math.round(delayMs * 1.7));
      continue;
    }
    if (
      typeof data !== "object" ||
      data === null ||
      !("peaks" in data) ||
      !Array.isArray(data.peaks) ||
      !data.peaks.every((peak) => typeof peak === "number")
    ) {
      throw new Error("Invalid waveform response");
    }
    return data.peaks;
  }
  throw new Error("Waveform extraction timed out while pending");
}

async function decodeWaveformPeaks(url: string, signal: AbortSignal): Promise<number[]> {
  const response = await studioApiFetch(url, { signal });
  if (response.status === 404 || response.status === 410) throw new UnavailableAudioError(`Audio request failed (${response.status})`);
  if (!response.ok) throw new Error(`Audio request failed (${response.status})`);
  const buffer = await response.arrayBuffer();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(buffer);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return extractPeaks(decoded.getChannelData(0), 4000);
  } finally {
    await context.close();
  }
}

