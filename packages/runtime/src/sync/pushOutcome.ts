import type { PushChangeOutcome } from './types';

const warnedAt = new Map<string, number>();
const WARNING_INTERVAL_MS = 60_000;
const MAX_WARNING_KEYS = 256;
let suppressed = 0;
let summaryTimer: ReturnType<typeof setTimeout> | undefined;

export function resetPushOutcomeWarnings(): void {
  warnedAt.clear();
  if (summaryTimer !== undefined) clearTimeout(summaryTimer);
  summaryTimer = undefined;
  suppressed = 0;
}

/** Throttle each publisher/session/reason independently; other transports succeeding must not reset it. */
export function warnIfUnpublished(
  log: (message: string) => void,
  sessionId: string,
  what: string,
  outcome: PushChangeOutcome | void,
): void {
  if (!outcome || outcome.published || outcome.retryable === false) return;
  const reason = outcome.reason ?? 'not published';
  const key = JSON.stringify([what, sessionId, reason]);
  const now = Date.now();
  const previous = warnedAt.get(key);
  if (previous !== undefined && now >= previous && now - previous < WARNING_INTERVAL_MS) return;
  warnedAt.delete(key);
  if (warnedAt.size >= MAX_WARNING_KEYS) {
    for (const [existingKey, timestamp] of warnedAt) {
      if (now < timestamp || now - timestamp >= WARNING_INTERVAL_MS) warnedAt.delete(existingKey);
    }
  }
  if (warnedAt.size >= MAX_WARNING_KEYS) {
    suppressed++;
    if (summaryTimer === undefined) {
      summaryTimer = setTimeout(() => {
        const count = suppressed;
        suppressed = 0;
        summaryTimer = undefined;
        log(`[sync] suppressed ${count} further publish failures`);
      }, WARNING_INTERVAL_MS);
      if (typeof summaryTimer === 'object') summaryTimer.unref?.();
    }
    return;
  }
  warnedAt.set(key, now);
  log(`${what} for session ${sessionId}: ${reason}`);
}
