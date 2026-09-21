/** Engine-specific voice choices and preview availability. */

import { liveVoicePreviews } from './liveVoicePreviews';
import type { VoiceEngineId } from '../../store/atoms/voiceModeState';

/**
 * Voices the TTS speech endpoint accepts directly. Anything outside this set
 * needs an explicit stand-in or it cannot be previewed.
 */
const TTS_NATIVE_VOICES = new Set(['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer']);

/**
 * Stand-ins for speech-to-speech voices the TTS endpoint does not have. Must
 * stay in step with the map in VoiceModeService's preview handler -- that
 * handler is what actually performs the substitution.
 */
const TTS_STAND_INS: Record<string, string> = {
  ballad: 'nova',
  marin: 'alloy',
  cedar: 'onyx',
  verse: 'fable',
};

export interface VoiceCatalogEntry {
  id: string;
  name: string;
  description: string;
  gender: 'male' | 'female' | 'neutral';
  /** Engines known to accept this voice. */
  engines: readonly VoiceEngineId[];
}

/** Built-in voices currently offered by the settings picker. */
export const VOICE_CATALOG: readonly VoiceCatalogEntry[] = [
  { id: 'ash', name: 'Ash', description: 'Clear and confident', gender: 'male', engines: ['realtime', 'live'] },
  { id: 'echo', name: 'Echo', description: 'Smooth and resonant', gender: 'male', engines: ['realtime', 'live'] },
  { id: 'verse', name: 'Verse', description: 'Dynamic and engaging', gender: 'male', engines: ['realtime', 'live'] },
  { id: 'cedar', name: 'Cedar', description: 'Deep and authoritative', gender: 'male', engines: ['realtime', 'live'] },
  { id: 'coral', name: 'Coral', description: 'Warm and friendly', gender: 'female', engines: ['realtime', 'live'] },
  { id: 'sage', name: 'Sage', description: 'Thoughtful and calm', gender: 'female', engines: ['realtime', 'live'] },
  { id: 'shimmer', name: 'Shimmer', description: 'Bright and cheerful', gender: 'female', engines: ['realtime', 'live'] },
  { id: 'ballad', name: 'Ballad', description: 'Melodic and expressive', gender: 'female', engines: ['realtime', 'live'] },
  { id: 'marin', name: 'Marin', description: 'Natural and conversational', gender: 'female', engines: ['realtime', 'live'] },
  { id: 'alloy', name: 'Alloy', description: 'Balanced and versatile', gender: 'neutral', engines: ['realtime', 'live'] },
];

export function voicesForEngine(engine: VoiceEngineId): VoiceCatalogEntry[] {
  return VOICE_CATALOG.filter((v) => v.engines.includes(engine));
}

export function voiceGroupsForEngine(engine: VoiceEngineId): Array<{ label: string; voices: VoiceCatalogEntry[] }> {
  const voices = voicesForEngine(engine);
  return (['male', 'female', 'neutral'] as const)
    .map((gender) => ({
      label: gender === 'male' ? 'Male' : gender === 'female' ? 'Female' : 'Neutral',
      voices: voices.filter((v) => v.gender === gender),
    }))
    .filter((group) => group.voices.length > 0);
}

/**
 * The voice to actually use on this engine. A voice the engine does not accept
 * falls back to that engine's first option rather than being sent through and
 * failing at connect time.
 */
export function resolveVoiceForEngine(engine: VoiceEngineId, voiceId: string | undefined): string {
  const available = voicesForEngine(engine);
  if (voiceId && available.some((v) => v.id === voiceId)) return voiceId;
  return available[0]?.id ?? 'alloy';
}

export interface VoicePreviewEligibility {
  canPreview: boolean;
  /** True when the sample is a stand-in voice, or a different speech model, or both. */
  approximate: boolean;
  /** User-facing explanation. Empty when the preview is the voice itself. */
  note: string;
}

export function previewEligibility(engine: VoiceEngineId, voiceId: string): VoicePreviewEligibility {
  if (engine === 'live') {
    const recorded = Object.prototype.hasOwnProperty.call(liveVoicePreviews, voiceId);
    return {
      canPreview: recorded,
      approximate: false,
      note: recorded ? '' : 'No recording is available for this voice.',
    };
  }
  const standIn = TTS_STAND_INS[voiceId];
  const direct = TTS_NATIVE_VOICES.has(voiceId);

  if (!direct && !standIn) {
    return {
      canPreview: false,
      approximate: false,
      note: 'Preview is unavailable for this voice -- the preview service has no matching voice, and playing a different one would be misleading.',
    };
  }

  return standIn
    ? { canPreview: true, approximate: true, note: 'This voice has no preview equivalent; the sample uses a similar voice.' }
    : { canPreview: true, approximate: false, note: '' };
}
