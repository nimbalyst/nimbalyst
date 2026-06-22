import type { CompletionSoundType } from '../../main/utils/store';

/**
 * Loudness multiplier applied to the authored peak gains of the built-in
 * synthesized sounds. The originals (~0.15-0.2) were authored very
 * conservatively, so even at 100% volume (unity master gain) they were barely
 * audible. 3x raises them to a clearly-audible level while staying well under
 * the 1.0 clipping ceiling (worst-case summed peak — the bell's 4 harmonics —
 * stays ~0.6). The volume slider still attenuates from this louder baseline.
 */
const SYNTH_GAIN_BOOST = 3;

export class SoundPlayer {
  private audioContext: AudioContext | null = null;
  /**
   * Master gain node that every sound routes through. Its gain acts as a
   * volume multiplier (0-1) applied uniformly to all sounds, so the per-tone
   * envelopes in the individual play methods stay unchanged.
   */
  private masterGain: GainNode | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.masterGain = this.audioContext.createGain();
      this.masterGain.connect(this.audioContext.destination);
    }
  }

  /**
   * @param soundType which synthesized sound to play.
   * @param volume    volume multiplier in the range 0-1 (a fraction of system
   *                  volume). Defaults to 1 (full volume). Clamped to [0, 1].
   */
  public async playSound(soundType: CompletionSoundType, volume = 1): Promise<void> {
    // console.log('[SoundPlayer] playSound called with type:', soundType);

    if (!this.audioContext || !this.masterGain) {
      console.warn('[SoundPlayer] AudioContext not available');
      return;
    }

    // console.log('[SoundPlayer] AudioContext state:', this.audioContext.state);

    // Resume AudioContext if it's suspended (required by browser autoplay policies)
    if (this.audioContext.state === 'suspended') {
      // console.log('[SoundPlayer] Resuming suspended AudioContext');
      await this.audioContext.resume();
    }

    // Apply the volume at the start of every call so playback is stateless per
    // call: a quiet completion sound never leaks its gain into a later sound.
    const clamped = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1));
    this.masterGain.gain.setValueAtTime(clamped, this.audioContext.currentTime);

    switch (soundType) {
      case 'chime':
        // console.log('[SoundPlayer] Playing chime');
        await this.playChime();
        break;
      case 'bell':
        // console.log('[SoundPlayer] Playing bell');
        await this.playBell();
        break;
      case 'pop':
        // console.log('[SoundPlayer] Playing pop');
        await this.playPop();
        break;
      case 'alert':
        // console.log('[SoundPlayer] Playing alert');
        await this.playAlert();
        break;
      case 'custom':
        await this.playCustom();
        break;
      case 'none':
        // Do nothing
        break;
    }
  }

  /**
   * Fetch the custom sound bytes from the main process and decode them.
   * Returns the decoded AudioBuffer, or null when no file is set / decoding
   * fails (e.g. corrupt audio). Callers decide what to do with null.
   */
  private async loadCustomAudioBuffer(): Promise<AudioBuffer | null> {
    if (!this.audioContext) return null;
    const api = (typeof window !== 'undefined' ? (window as any).electronAPI : undefined);
    const data: Uint8Array | null = api?.invoke
      ? await api.invoke('completion-sound:get-custom-data')
      : null;
    if (!data || data.byteLength === 0) {
      return null;
    }
    // Copy into a fresh ArrayBuffer (decodeAudioData detaches its input).
    const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return this.audioContext.decodeAudioData(arrayBuffer as ArrayBuffer);
  }

  /**
   * Play a user-supplied custom sound. The bytes are fetched from the main
   * process (which owns the file in userData) and decoded via the Web Audio
   * API. Plays nothing if no file is set or decoding fails — by design,
   * 'custom' never substitutes a built-in sound (that would surprise the user).
   */
  private async playCustom(): Promise<void> {
    if (!this.audioContext || !this.masterGain) return;

    try {
      const audioBuffer = await this.loadCustomAudioBuffer();
      if (!audioBuffer) return;

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      const gainNode = this.audioContext.createGain();
      // Play the user's file at its native level; the volume slider (master
      // gain) provides attenuation, so no extra reduction is applied here.
      gainNode.gain.value = 1.0;
      source.connect(gainNode);
      // Route through masterGain (not destination directly) so the completion
      // sound volume slider scales the custom sound like every built-in sound.
      gainNode.connect(this.masterGain);
      source.start();
    } catch (err) {
      console.error('[SoundPlayer] Failed to play custom sound:', err);
    }
  }

  /**
   * Validate that the currently-configured custom sound can actually be
   * decoded as audio. Used at selection time to reject corrupt/unsupported
   * files that slipped past the extension + magic-byte checks.
   */
  public async validateCustomSound(): Promise<boolean> {
    try {
      const audioBuffer = await this.loadCustomAudioBuffer();
      return audioBuffer !== null;
    } catch {
      return false;
    }
  }

  /**
   * Play an alert sound for permission requests - more attention-grabbing
   */
  private async playAlert(): Promise<void> {
    if (!this.audioContext) return;

    const ctx = this.audioContext;
    const now = ctx.currentTime;

    // Two-tone alert sound (like a doorbell or notification)
    const tones = [
      { freq: 880, start: 0, duration: 0.15 },
      { freq: 660, start: 0.15, duration: 0.15 },
      { freq: 880, start: 0.35, duration: 0.15 },
    ];

    tones.forEach(({ freq, start, duration }) => {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(freq, now + start);

      const peak = 0.2 * SYNTH_GAIN_BOOST;
      gainNode.gain.setValueAtTime(0, now + start);
      gainNode.gain.linearRampToValueAtTime(peak, now + start + 0.02);
      gainNode.gain.setValueAtTime(peak, now + start + duration - 0.02);
      gainNode.gain.linearRampToValueAtTime(0, now + start + duration);

      oscillator.connect(gainNode);
      gainNode.connect(this.masterGain!);

      oscillator.start(now + start);
      oscillator.stop(now + start + duration);
    });
  }

  private async playChime(): Promise<void> {
    if (!this.audioContext) return;

    const ctx = this.audioContext;
    const now = ctx.currentTime;

    // Create a gentle chime with two tones
    const frequencies = [800, 1200];
    const duration = 0.3;

    frequencies.forEach((freq, index) => {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(freq, now);

      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.15 * SYNTH_GAIN_BOOST, now + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + duration);

      oscillator.connect(gainNode);
      gainNode.connect(this.masterGain!);

      oscillator.start(now + index * 0.1);
      oscillator.stop(now + duration + index * 0.1);
    });
  }

  private async playBell(): Promise<void> {
    if (!this.audioContext) return;

    const ctx = this.audioContext;
    const now = ctx.currentTime;

    // Create a bell-like sound with multiple harmonics
    const fundamental = 600;
    const harmonics = [1, 2.4, 3.8, 5.2];
    const duration = 0.5;

    harmonics.forEach((ratio, index) => {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(fundamental * ratio, now);

      const volume = (0.1 * SYNTH_GAIN_BOOST) / (index + 1);
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(volume, now + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + duration);

      oscillator.connect(gainNode);
      gainNode.connect(this.masterGain!);

      oscillator.start(now);
      oscillator.stop(now + duration);
    });
  }

  private async playPop(): Promise<void> {
    if (!this.audioContext) return;

    const ctx = this.audioContext;
    const now = ctx.currentTime;

    // Create a short pop sound
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(400, now);
    oscillator.frequency.exponentialRampToValueAtTime(100, now + 0.1);

    gainNode.gain.setValueAtTime(0.2 * SYNTH_GAIN_BOOST, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

    oscillator.connect(gainNode);
    gainNode.connect(this.masterGain!);

    oscillator.start(now);
    oscillator.stop(now + 0.1);
  }

  public dispose(): void {
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.masterGain = null;
  }
}

// Singleton instance
let soundPlayer: SoundPlayer | null = null;

export function getSoundPlayer(): SoundPlayer {
  if (!soundPlayer) {
    soundPlayer = new SoundPlayer();
  }
  return soundPlayer;
}
