// Vite imports include these recordings in both dev and packaged builds.
import ash from '../../assets/voice-previews/gpt-live-1/ash.mp3?url';
import echo from '../../assets/voice-previews/gpt-live-1/echo.mp3?url';
import verse from '../../assets/voice-previews/gpt-live-1/verse.mp3?url';
import cedar from '../../assets/voice-previews/gpt-live-1/cedar.mp3?url';
import coral from '../../assets/voice-previews/gpt-live-1/coral.mp3?url';
import sage from '../../assets/voice-previews/gpt-live-1/sage.mp3?url';
import shimmer from '../../assets/voice-previews/gpt-live-1/shimmer.mp3?url';
import ballad from '../../assets/voice-previews/gpt-live-1/ballad.mp3?url';
import marin from '../../assets/voice-previews/gpt-live-1/marin.mp3?url';
import alloy from '../../assets/voice-previews/gpt-live-1/alloy.mp3?url';

export const liveVoicePreviews: Readonly<Record<string, string>> = {
  ash, echo, verse, cedar, coral, sage, shimmer, ballad, marin, alloy
};
