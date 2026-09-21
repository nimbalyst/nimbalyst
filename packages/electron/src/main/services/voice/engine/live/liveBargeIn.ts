/**
 * Barge-in on the Live path: deciding when the user talking over the assistant
 * should flush OUR buffered audio.
 *
 * Why this exists at all. The renderer schedules assistant audio ahead of
 * real time, so several seconds of already-received PCM can still be playing
 * after the model has stopped producing it. On Realtime, the engine's
 * `interrupted` event is what tells the renderer to drop that queue. Live
 * publishes no interruption event in the supported subset -- correctly, since
 * it handles interruption itself -- so nothing was flushing the queue and the
 * user kept hearing the assistant they had just interrupted. The whole point of
 * model-level interruption is defeated by our own buffer.
 *
 * The decision is an application concern, so it lives here rather than being
 * synthesized as a fake protocol event inside the transport.
 *
 * What Live gives us, and what it does not. There is no VAD, no speech-stopped,
 * and no per-turn boundary: the only evidence that the user is talking is input
 * transcript fragments. That evidence is exactly as echo-prone as Realtime's
 * VAD -- the assistant's own voice coming back through an open speaker
 * transcribes as the user talking -- which is why NIM-1472's VoiceBargeInPolicy
 * exists and why this coordinator drives that same policy rather than routing
 * around it. A false flush cuts the assistant off mid-word, which is worse than
 * the bug being fixed.
 *
 * How the decision is made, and what changed. An earlier version treated a
 * second fragment for the same utterance as proof of a real barge-in and
 * flushed immediately. That was wrong in both directions and measurably so: a
 * two-fragment echo blip flushed at 120ms (inside the probation window that was
 * supposed to protect against exactly that), while a genuine one-word "stop"
 * produced a single fragment and never flushed at all. Fragment *count* does
 * not separate those cases, and no timing threshold does either -- both are
 * short.
 *
 * What does separate them is content. Live transcribes both sides natively, so
 * residual echo arrives as a transcript of words the assistant just said, while
 * a real interruption does not. So:
 *
 *  1. The probation window always elapses. Nothing flushes early, ever.
 *  2. At expiry the accumulated utterance text is compared against what the
 *     assistant actually said in the last few seconds. High overlap is echo and
 *     is suppressed; different words are the user, and are flushed.
 *  3. When no assistant transcript is available to compare against (native
 *     transcription can lag), the fallback is the conservative one: only
 *     sustained speech flushes, because cutting the assistant off on a maybe is
 *     the worse error.
 *  4. A suppressed utterance that keeps producing fragments is re-judged rather
 *     than written off, so a late-transcribed barge-in flushes late instead of
 *     never.
 *
 * This is still a heuristic over a noisy signal, and it is instrumented as one:
 * every decision lands in VoiceBargeInPolicy's echo/genuine/suppressed counters
 * so the false-interruption rate is measurable before the engine is defaulted
 * on. What it is not is a coin flip on fragment arrival order.
 *
 * Pure (clock, timer and callbacks injected, no electron, no socket) because the
 * interesting behavior is ordering-sensitive.
 */

import { VoiceBargeInPolicy, type BargeInSessionMetrics } from '../../voiceBargeInPolicy';

/** How much recently-spoken assistant text an echo can be matched against. */
export const BARGE_IN_ECHO_LOOKBACK_MS = 12_000;
/** Speech at least this long counts as sustained when content cannot decide. */
export const BARGE_IN_MIN_SUSTAINED_MS = 300;
/** Or this many transcribed words, for a fast speaker inside the window. */
export const BARGE_IN_MIN_SUSTAINED_TOKENS = 3;
/** Share of the utterance's words the assistant just said, above which it is echo. */
export const BARGE_IN_ECHO_OVERLAP_RATIO = 0.6;
/**
 * A gap this long between assistant transcript fragments is a boundary, not a
 * word break. Fragments closer together are parts of one continuous stream and
 * are concatenated verbatim; see `assistantRecentText`.
 */
export const BARGE_IN_ASSISTANT_FRAGMENT_GAP_MS = 1_000;

export type BargeInVerdict =
  /** The user is talking over us; drop the queued audio. */
  | 'interrupt'
  /** These are our own words coming back; keep playing. */
  | 'echo'
  /** Not enough evidence either way; keep playing (the safer error). */
  | 'insufficient';

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);

/**
 * The barge-in judgement, as a pure function of the facts collected during the
 * probation window. Exported because this is the part worth testing directly:
 * every interesting case is a different combination of these three inputs.
 */
export function judgeSpeechEvidence(input: {
  /** Everything transcribed for this utterance so far. */
  text: string;
  /** How long the utterance has been producing transcript, in ms. */
  speechMs: number;
  /** What the assistant said recently, for echo comparison. */
  assistantRecentText: string;
}): BargeInVerdict {
  const tokens = tokenize(input.text);
  if (tokens.length === 0) return 'insufficient';

  const assistantTokens = new Set(tokenize(input.assistantRecentText));
  if (assistantTokens.size > 0) {
    const matched = tokens.filter((token) => assistantTokens.has(token)).length;
    if (matched / tokens.length >= BARGE_IN_ECHO_OVERLAP_RATIO) return 'echo';
    // Words we did not just say. That is the user, however short.
    return 'interrupt';
  }

  // Nothing to compare against: fall back to the min-duration heuristic.
  const sustained =
    input.speechMs >= BARGE_IN_MIN_SUSTAINED_MS ||
    tokens.length >= BARGE_IN_MIN_SUSTAINED_TOKENS;
  return sustained ? 'interrupt' : 'insufficient';
}

export interface LiveBargeInOptions {
  /** Is the assistant currently audible in the renderer? */
  isPlaybackActive: () => boolean;
  /** Drop the renderer's queued assistant audio. */
  flushPlayback: () => void;
  /** Injected clock (ms). */
  now?: () => number;
  /** Injected timer, so tests drive the probation window deterministically. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** One user utterance, under judgement. */
interface SpeechWindow {
  /** The utterance being judged. Null until its opening fragment arrives. */
  groupId: string | null;
  openedAt: number;
  firstFragmentAt: number | null;
  lastFragmentAt: number | null;
  text: string;
  timer: unknown;
  /** The probation window has elapsed and a verdict was reached. */
  decided: boolean;
  /** We already flushed for this utterance; there is nothing left to decide. */
  flushed: boolean;
}

interface AssistantFragment {
  at: number;
  text: string;
}

export class LiveBargeInCoordinator {
  private readonly policy: VoiceBargeInPolicy;
  private readonly opts: Required<LiveBargeInOptions>;
  private current: SpeechWindow | null = null;
  private assistantFragments: AssistantFragment[] = [];

  constructor(options: LiveBargeInOptions) {
    this.opts = {
      isPlaybackActive: options.isPlaybackActive,
      flushPlayback: options.flushPlayback,
      now: options.now ?? Date.now,
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)),
    };
    this.policy = new VoiceBargeInPolicy(this.opts.now);
  }

  get metrics(): BargeInSessionMetrics {
    return this.policy.metrics;
  }

  /** Renderer-reported audible playback state. */
  setPlaybackActive(active: boolean): void {
    if (active) {
      this.policy.notePlaybackStarted();
      return;
    }
    this.policy.notePlaybackStopped();
    // Playback drained on its own; there is nothing left to interrupt and the
    // pending probation would only produce a flush of an empty queue.
    this.closeWindow();
  }

  /**
   * Assistant speech, as text, for the echo comparison. This is the only thing
   * that can tell "the user said stop" from "the speaker played our word back
   * into the microphone", so it is kept for a few seconds and no longer.
   */
  noteAssistantText(text: string): void {
    if (!text) return;
    const now = this.opts.now();
    this.assistantFragments.push({ at: now, text });
    this.pruneAssistantText(now);
  }

  /**
   * The user began a new utterance. Nothing audible means nothing to flush, so
   * the trigger is recorded and dropped. While the assistant is audible the
   * utterance is echo-suspect and enters the policy's probation window -- which
   * from here on always runs to completion.
   */
  onUserSpeechStarted(): void {
    const playbackActive = this.opts.isPlaybackActive();
    const decision = this.policy.onSpeechStarted(playbackActive);
    this.closeWindow();
    if (!playbackActive || decision.deferInterruptMs === null) return;

    const now = this.opts.now();
    this.current = {
      groupId: null,
      openedAt: now,
      firstFragmentAt: null,
      lastFragmentAt: null,
      text: '',
      timer: this.opts.setTimer(() => this.onProbationExpired(), decision.deferInterruptMs),
      decided: false,
      flushed: false,
    };
  }

  /**
   * A transcript fragment for the user's current utterance. Fragments are
   * evidence, not a trigger: they accumulate the text and timing the verdict is
   * made from, and never flush on their own before the window has elapsed.
   */
  onUserTranscriptDelta(groupId: string, delta = ''): void {
    const window = this.current;
    if (!window) return;
    if (window.groupId === null) window.groupId = groupId;
    else if (window.groupId !== groupId) return;

    const now = this.opts.now();
    if (window.firstFragmentAt === null) window.firstFragmentAt = now;
    window.lastFragmentAt = now;
    window.text += delta;

    // The probation window already expired and suppressed this utterance, but
    // it is still going. Re-judge it rather than treating one expired window as
    // a permanent verdict: a late flush beats none.
    if (window.decided && !window.flushed) this.rejudge(window);
  }

  /** End of the voice session. */
  reset(): void {
    this.closeWindow();
    this.assistantFragments = [];
    this.policy.resetSession();
  }

  private onProbationExpired(): void {
    const window = this.current;
    if (!window) return;
    window.timer = null;
    window.decided = true;

    const playbackActive = this.opts.isPlaybackActive();
    const verdict = playbackActive ? this.judge(window) : 'insufficient';
    if (verdict === 'interrupt') {
      const decision = this.policy.onDeferredInterruptTimeout(playbackActive);
      if (decision.shouldInterrupt) this.flush(window);
      return;
    }
    // Not the user, or not enough to act on. Telling the policy the speech
    // stopped is what makes it classify (and count) this as suppressed echo.
    this.policy.onSpeechStopped();
    this.policy.onDeferredInterruptTimeout(playbackActive);
  }

  /** A suppressed utterance that kept talking. */
  private rejudge(window: SpeechWindow): void {
    if (!this.opts.isPlaybackActive()) return;
    if (this.judge(window) !== 'interrupt') return;
    // Re-arm the policy's speech clock so this counts as the interruption it is
    // rather than as another suppressed echo.
    this.policy.onSpeechStarted(true);
    const decision = this.policy.onDeferredInterruptTimeout(true);
    if (decision.shouldInterrupt) this.flush(window);
  }

  private judge(window: SpeechWindow): BargeInVerdict {
    const now = this.opts.now();
    this.pruneAssistantText(now);
    const speechMs =
      window.firstFragmentAt === null
        ? 0
        : (window.lastFragmentAt ?? window.firstFragmentAt) - window.firstFragmentAt;
    return judgeSpeechEvidence({
      text: window.text,
      speechMs,
      assistantRecentText: this.assistantRecentText(),
    });
  }

  /**
   * Reassemble the retained assistant fragments into the text that was actually
   * spoken. Native transcription chunks a stream at arbitrary offsets, so a
   * fragment boundary is not a word boundary: joining with a separator turns
   * `"con"` + `"text"` into two words the assistant never said, and the user's
   * echo of the real one then matches nothing and gets flushed as genuine.
   * Contiguous fragments are therefore concatenated verbatim -- deltas already
   * carry their own leading whitespace -- while a real pause between them is
   * treated as the turn boundary it is, so two turns never fuse into a word
   * either.
   */
  private assistantRecentText(): string {
    let text = '';
    let previousAt: number | null = null;
    for (const fragment of this.assistantFragments) {
      if (previousAt !== null && fragment.at - previousAt >= BARGE_IN_ASSISTANT_FRAGMENT_GAP_MS) {
        text += ' ';
      }
      text += fragment.text;
      previousAt = fragment.at;
    }
    return text;
  }

  private flush(window: SpeechWindow): void {
    window.flushed = true;
    // Our own queued words are gone, so they can no longer come back as echo
    // for the next utterance.
    this.assistantFragments = [];
    this.opts.flushPlayback();
  }

  private pruneAssistantText(now: number): void {
    const cutoff = now - BARGE_IN_ECHO_LOOKBACK_MS;
    if (this.assistantFragments.length === 0) return;
    this.assistantFragments = this.assistantFragments.filter((fragment) => fragment.at >= cutoff);
  }

  private closeWindow(): void {
    const window = this.current;
    this.current = null;
    if (!window) return;
    if (window.timer !== null) this.opts.clearTimer(window.timer);
  }
}
