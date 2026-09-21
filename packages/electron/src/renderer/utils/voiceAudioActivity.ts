/** Digital PCM silence carries timing, but is not evidence of speech. */
export function hasVoiceAudioSignal(pcm16Base64: string): boolean {
  const bytes = atob(pcm16Base64);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    if (bytes.charCodeAt(i) !== 0 || bytes.charCodeAt(i + 1) !== 0) return true;
  }
  return false;
}
