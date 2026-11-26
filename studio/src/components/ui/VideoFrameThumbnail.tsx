import { useI18n } from "../../i18n/I18n";
import { useEffect, useRef, useState } from "react";
import { getCachedVideoFrame, subscribeVideoFrame } from "./videoFrameThumbnailLoader";

const RETRY_DELAYS_MS = [1_000, 3_000] as const;

interface ThumbnailState {
  readonly src: string;
  readonly frame: string | null;
  readonly attempt: number;
  readonly failedAttempt: number | null;
  readonly autoRetriesUsed: number;
}

function initialStateFor(src: string): ThumbnailState {
  return {
    src,
    frame: getCachedVideoFrame(src),
    attempt: 0,
    failedAttempt: null,
    autoRetriesUsed: 0,
  };
}

/**
 * Extracts a representative JPEG frame from a video URL using a hidden
 * video + canvas. Seeks to ~10% of duration to avoid black opening frames.
 * Used by AssetPreview (library/history/versions), RenderPreview, and Scenario cards.
 */
export function VideoFrameThumbnail({
  src,
  fallbackLabel,
}: {
  src: string;
  /** Shown instead of an endless shimmer when the video can't be decoded. */
  fallbackLabel?: string;
}) {
  const { t } = useI18n();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [state, setState] = useState<ThumbnailState>(() => initialStateFor(src));
  // Default to near-viewport so first paint starts immediately (capped by the shared
  // concurrency queue) and environments with stub IntersectionObserver keep working;
  // real IntersectionObserver updates cancel offscreen queued work and re-trigger on return.
  const [nearViewport, setNearViewport] = useState(true);
  const wasNearViewportRef = useRef(true);

  // Derive synchronously for the current `src` so switching versions clears any stale frame immediately.
  const current = state.src === src ? state : initialStateFor(src);
  const failed = current.failedAttempt !== null;
  const awaitingRecovery = !current.frame && current.failedAttempt === current.attempt;

  useEffect(() => {
    setState((prev) => (prev.src === src ? prev : initialStateFor(src)));
  }, [src]);

  useEffect(() => {
    if (current.frame || !host || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setNearViewport(Boolean(entry?.isIntersecting)),
      { rootMargin: "240px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [host, current.frame]);

  // Recover automatically when a failed card is scrolled back into view.
  useEffect(() => {
    const wasNear = wasNearViewportRef.current;
    wasNearViewportRef.current = nearViewport;
    if (!wasNear && nearViewport && awaitingRecovery) {
      setState((prev) =>
        prev.src === src && !prev.frame && prev.failedAttempt === prev.attempt
          ? { ...prev, attempt: prev.attempt + 1, autoRetriesUsed: 0 }
          : prev,
      );
    }
  }, [nearViewport, awaitingRecovery, src]);

  useEffect(() => {
    if (current.frame || !nearViewport || current.failedAttempt === current.attempt) return;

    let cancelled = false;
    const activeAttempt = current.attempt;

    const unsubscribe = subscribeVideoFrame(src, activeAttempt, {
      onFrame: (dataUrl) => {
        if (cancelled) return;
        setState((prev) =>
          prev.src === src
            ? { ...prev, frame: dataUrl, failedAttempt: null }
            : { src, frame: dataUrl, attempt: 0, failedAttempt: null, autoRetriesUsed: 0 },
        );
      },
      onError: () => {
        if (cancelled) return;
        setState((prev) =>
          prev.src === src
            ? { ...prev, failedAttempt: activeAttempt }
            : {
                src,
                frame: null,
                attempt: activeAttempt,
                failedAttempt: activeAttempt,
                autoRetriesUsed: 0,
              },
        );
      },
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [src, nearViewport, current.frame, current.attempt, current.failedAttempt]);

  // Bounded backoff auto-retries while visible + recovery on network online / tab visibility return.
  useEffect(() => {
    if (!awaitingRecovery) return;

    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const delay = RETRY_DELAYS_MS[current.autoRetriesUsed];
    if (delay !== undefined && nearViewport) {
      retryTimer = setTimeout(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        setState((prev) =>
          prev.src === src && !prev.frame && prev.failedAttempt === prev.attempt
            ? {
                ...prev,
                attempt: prev.attempt + 1,
                autoRetriesUsed: prev.autoRetriesUsed + 1,
              }
            : prev,
        );
      }, delay);
    }

    const triggerRecovery = () => {
      if (!nearViewport) return;
      if (typeof document !== "undefined" && document.hidden) return;
      setState((prev) =>
        prev.src === src && !prev.frame && prev.failedAttempt === prev.attempt
          ? { ...prev, attempt: prev.attempt + 1, autoRetriesUsed: 0 }
          : prev,
      );
    };
    const onVisibilityChange = () => {
      if (typeof document !== "undefined" && !document.hidden) triggerRecovery();
    };
    window.addEventListener("online", triggerRecovery);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      window.removeEventListener("online", triggerRecovery);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [awaitingRecovery, current.autoRetriesUsed, nearViewport, src]);

  if (failed && !current.frame) {
    return (
      <div ref={setHost} className="w-full h-full bg-neutral-800 flex items-center justify-center">
        <span className="text-[9px] font-medium text-neutral-600">{fallbackLabel ?? t("Video")}</span>
      </div>
    );
  }

  if (!current.frame) {
    return <div ref={setHost} data-thumbnail-loading className="w-full h-full bg-panel-surface" />;
  }

  return <img src={current.frame} alt="" draggable={false} className="w-full h-full object-contain" />;
}
