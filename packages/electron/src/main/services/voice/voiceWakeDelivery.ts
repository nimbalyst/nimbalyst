/**
 * Delivering a question or coding completion to a voice session that may be asleep.
 *
 * The cross-session event queue can decide a question is worth restoring a
 * closed voice session for. On Live that restore reopens a paid transport,
 * which takes a moment -- and the question arrives immediately behind the wake,
 * while the engine is still not connected. Dropping it there discarded the one
 * thing the wake existed to do, and nothing redelivered it.
 *
 * So this waits for the restore instead of giving up on it, and reports whether
 * the question was actually delivered. Pure (engine, clock and sleep injected,
 * no electron) because the interesting behavior is the timing.
 */

export interface WakeDeliveryEngine {
  isConnected(): boolean;
  sendHostAnnouncement(text: string): boolean;
  setListeningPaused(paused: boolean): void;
}

export interface InteractivePromptDelivery {
  promptId: string;
  promptType: string;
  description: string;
}

export interface WakeDeliveryOptions {
  /** How long to wait for the transport to come back. */
  timeoutMs?: number;
  /** How often to check. */
  pollMs?: number;
  /** False once this voice session is no longer the active one. */
  isCurrent?: () => boolean;
  /** Injected for tests; production uses setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** How long an announcement waits for the paid transport to come back. */
export const WAKE_DELIVERY_TIMEOUT_MS = 15_000;
const WAKE_DELIVERY_POLL_MS = 100;

/** The shape the voice agent is given a pending interactive prompt in. */
export function buildInteractivePromptMessage(data: InteractivePromptDelivery): string {
  return `[INTERACTIVE PROMPT: promptId="${data.promptId}" promptType="${data.promptType}"]\n${data.description}`;
}

export async function deliverInteractivePrompt(
  engine: WakeDeliveryEngine,
  data: InteractivePromptDelivery,
  options: WakeDeliveryOptions = {},
): Promise<boolean> {
  return deliverVoiceAnnouncement(engine, buildInteractivePromptMessage(data), options);
}

/** Both late answers and interactive questions must survive asynchronous wake. */
export async function deliverVoiceAnnouncement(
  engine: WakeDeliveryEngine,
  message: string,
  options: WakeDeliveryOptions = {},
): Promise<boolean> {
  const isCurrent = options.isCurrent ?? (() => true);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? WAKE_DELIVERY_TIMEOUT_MS;
  const pollMs = options.pollMs ?? WAKE_DELIVERY_POLL_MS;

  if (!isCurrent()) return false;
  if (engine.isConnected() && engine.sendHostAnnouncement(message)) return true;

  // Reopening is idempotent: the renderer's wake normally started it already.
  engine.setListeningPaused(false);
  let waited = 0;
  while (waited < timeoutMs) {
    if (!isCurrent()) return false;
    if (engine.isConnected() && engine.sendHostAnnouncement(message)) {
      console.info('[VoiceQueue] Delivered announcement after restoring the session');
      return true;
    }
    await sleep(pollMs);
    waited += pollMs;
  }
  console.warn(
    '[VoiceQueue] Announcement delivery failed: the voice engine did not come back',
  );
  return false;
}
