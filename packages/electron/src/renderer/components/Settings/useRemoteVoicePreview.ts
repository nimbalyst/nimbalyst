import React from 'react';
import { useAtomValue } from 'jotai';
import { voiceModePreviewAudioAtom } from '../../store/atoms/voiceModeState';

/** Legacy Realtime TTS preview transport; Live uses bundled recordings. */
export function useRemoteVoicePreview(enabled: boolean, voiceId: string) {
  const [isPreviewPlaying, setIsPreviewPlaying] = React.useState(false);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  // Stop remote audio when switching selections or leaving the panel.
  React.useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setIsPreviewPlaying(false);
    };
  }, [enabled, voiceId]);

  // Play preview audio when main process broadcasts a `voice-mode:preview-audio`
  // event. The IPC event is handled centrally in
  // store/listeners/voiceModeListeners.ts which writes voiceModePreviewAudioAtom;
  // we play only on *new* bumps so any audio that was queued up before this
  // panel mounted doesn't replay on open.
  const previewAudio = useAtomValue(voiceModePreviewAudioAtom);
  const initialPreviewAudioRef = React.useRef(previewAudio);
  React.useEffect(() => {
    if (previewAudio === initialPreviewAudioRef.current) return;
    if (!previewAudio || !enabled) return;
    const { audioBase64, format } = previewAudio.payload;
    const audio = new Audio(`data:audio/${format};base64,${audioBase64}`);
    audioRef.current = audio;
    setIsPreviewPlaying(true);

    audio.onended = () => {
      setIsPreviewPlaying(false);
      audioRef.current = null;
    };

    audio.onerror = () => {
      setIsPreviewPlaying(false);
      audioRef.current = null;
    };

    audio.play().catch(() => {
      setIsPreviewPlaying(false);
      audioRef.current = null;
    });
  }, [previewAudio]);

  const handlePreviewVoice = async () => {
    if (!enabled) return;
    if (isPreviewPlaying) {
      // Stop current preview
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setIsPreviewPlaying(false);
      return;
    }

    setIsPreviewPlaying(true);
    try {
      const result = await window.electronAPI?.invoke('voice-mode:preview-voice', voiceId);
      if (!result?.success) {
        console.error('[VoiceModePanel] Preview failed:', result?.message);
        setIsPreviewPlaying(false);
      }
      // Audio will be received via IPC and played automatically
    } catch (error) {
      console.error('[VoiceModePanel] Preview error:', error);
      setIsPreviewPlaying(false);
    }
  };
  return { isPlaying: isPreviewPlaying, isLoading: isPreviewPlaying && !audioRef.current, toggle: handlePreviewVoice };
}
