import { useCallback, useEffect, useRef, useState } from 'react';

/** Owns a bundled sample, including pending play promises and selection changes. */
export function useVoicePreview(source: string | undefined) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string>();
  const stop = useCallback(() => {
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    }
    setIsPlaying(false);
  }, []);

  useEffect(() => {
    setError(undefined);
    return stop;
  }, [source, stop]);

  const toggle = useCallback(async () => {
    if (audioRef.current) { stop(); return; }
    if (!source) return;
    const audio = new Audio(source);
    audioRef.current = audio;
    setError(undefined);
    setIsPlaying(true);
    const finish = (failed: boolean) => {
      if (audioRef.current !== audio) return;
      stop();
      if (failed) setError('Could not play this voice preview.');
    };
    audio.onended = () => finish(false);
    audio.onerror = () => finish(true);
    try { await audio.play(); } catch { finish(true); }
  }, [source, stop]);

  return { isPlaying, error, toggle };
}
