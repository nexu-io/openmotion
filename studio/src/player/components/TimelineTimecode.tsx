import { useEffect, useRef } from "react";
import { liveTime, usePlayerStore } from "../store/playerStore";
import { formatTime } from "../lib/time";

function formatTimecode(time: number): string {
  const hundredths = Math.max(0, Math.round(time * 100));
  return `${formatTime(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}`;
}

/** Subscribe separately so playback does not redraw the ruler's ticks. */
export function TimelineTimecode() {
  const ref = useRef<HTMLTimeElement>(null);
  const initial = usePlayerStore(state => state.currentTime);
  useEffect(() => {
    const update = (time: number) => {
      if (ref.current) ref.current.textContent = formatTimecode(time);
    };
    update(usePlayerStore.getState().currentTime);
    const unsubscribe = liveTime.subscribe(update);
    return () => {
      unsubscribe();
    };
  }, []);
  return <time ref={ref} className="motion-timeline-timecode">{formatTimecode(initial)}</time>;
}
