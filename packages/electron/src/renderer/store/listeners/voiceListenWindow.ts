/**
 * Listen-window countdown for voice mode (NIM-1594).
 *
 * Owns the timer that transitions voice from 'listening' to 'sleeping' after
 * a period of inactivity, plus the "user speech in progress" flag that gates
 * it. Several async events (token-usage from a barge-in-cancelled response,
 * a late transcript-complete for the previous utterance, the playback-drain
 * post-turn window) can request the timer while the user is mid-utterance;
 * arming it then would expire the window and gate the mic while the user is
 * still talking. So: speechStarted() holds all arm requests, speechStopped()
 * releases them and arms from now. Explicit sleep (pause_listening) bypasses
 * this module entirely -- it only guards the *inactivity* path.
 *
 * Pure (no electron/jotai imports) so it is unit-testable with fake timers.
 */

export interface VoiceListenWindowOptions {
  /** Window length, read at arm time so settings changes apply immediately. */
  getWindowMs: () => number;
  /** Fired when the window elapses without the user speaking. */
  onExpire: () => void;
  /** Diagnostic hook: an arm request was held because speech is in progress. */
  onHeldDuringSpeech?: (reason: string) => void;
  /** A transcript-only speech hold expired without a closing event. */
  onSpeechExpired?: () => void;
}

export class VoiceListenWindowController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private userSpeechActive = false;
  private speechLease: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: VoiceListenWindowOptions) {}

  get isUserSpeechActive(): boolean {
    return this.userSpeechActive;
  }

  /** VAD speech_started: hold all timer arms until speechStopped(). */
  speechStarted(leaseMs?: number): void {
    this.userSpeechActive = true;
    this.clear();
    this.clearSpeechLease();
    if (leaseMs !== undefined) {
      this.speechLease = setTimeout(() => {
        this.speechLease = null;
        this.speechStopped();
        this.opts.onSpeechExpired?.();
      }, leaseMs);
    }
  }

  /** VAD speech_stopped: release the hold and start the countdown from now. */
  speechStopped(): void {
    this.clearSpeechLease();
    this.userSpeechActive = false;
    this.start('speech-stopped');
  }

  /**
   * Arm (or re-arm) the countdown. No-op while the user is speaking --
   * speech_stopped will arm it when the utterance actually ends.
   */
  start(reason: string): void {
    if (this.userSpeechActive) {
      this.opts.onHeldDuringSpeech?.(reason);
      return;
    }
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.opts.onExpire();
    }, this.opts.getWindowMs());
  }

  /** Stop the countdown without touching speech state. */
  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Stop the countdown AND forget in-flight speech. For session stop,
   * reconnect (a speech_stopped may have been lost with the socket), and
   * explicit pause -- anywhere a stale speech flag could hold the window
   * open forever.
   */
  reset(): void {
    this.clearSpeechLease();
    this.userSpeechActive = false;
    this.clear();
  }

  private clearSpeechLease(): void {
    if (this.speechLease !== null) clearTimeout(this.speechLease);
    this.speechLease = null;
  }
}
