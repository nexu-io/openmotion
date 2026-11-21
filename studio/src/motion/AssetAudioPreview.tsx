import { useEffect, useRef, useState } from 'react';
import { AudioPreviewWaveform } from '../components/nle/AudioPreviewWaveform';
import { mediaCrossOriginForUrl } from '../components/nle/mediaCrossOrigin';
import '../components/nle/audioPreview.css';

/** Visual feedback for the library's existing native audio player. */
export function AssetAudioPreview({ src, autoPlay = false, onError }: { src: string; autoPlay?: boolean; onError: () => void }) {
  const media = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const crossOrigin = mediaCrossOriginForUrl(src);
  useEffect(() => { const element = media.current; return () => element?.pause(); }, [src]);
  return <div className="om-asset-audio-player">
    <AudioPreviewWaveform media={media} playing={playing} />
    <audio ref={media} crossOrigin={crossOrigin} src={src} controls autoPlay={autoPlay} preload="metadata" onError={onError}
      onPlaying={() => setPlaying(true)} onPause={() => setPlaying(false)}
      onWaiting={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
  </div>;
}
