/** Process-local Stop intent, independent of provider/host retirement. */
const stoppedQueues = new Map<string, object>();
const stopLookups = new Map<string, Set<symbol>>();

export function holdQueueAfterStop(sessionId: string): void {
  stoppedQueues.set(sessionId, {});
}

export interface QueueStopRequest {
  finishLookup(): void;
  restorePreviousHold(): void;
}

/** Fence receipt before asynchronous provider lookup. New input may authorize
 * continuation, but cannot start underneath a Stop still being registered.
 */
export function beginQueueStopRequest(sessionId: string): QueueStopRequest {
  const previous = stoppedQueues.get(sessionId);
  const held = {};
  stoppedQueues.set(sessionId, held);
  const lookup = Symbol(sessionId);
  const lookups = stopLookups.get(sessionId) ?? new Set<symbol>();
  lookups.add(lookup);
  stopLookups.set(sessionId, lookups);
  return {
    finishLookup() {
      lookups.delete(lookup);
      if (!lookups.size && stopLookups.get(sessionId) === lookups) stopLookups.delete(sessionId);
    },
    restorePreviousHold() {
      if (stoppedQueues.get(sessionId) !== held) return;
      if (previous) stoppedQueues.set(sessionId, previous);
      else stoppedQueues.delete(sessionId);
    },
  };
}

export function isQueueStopped(sessionId: string): boolean {
  return stoppedQueues.has(sessionId) || stopLookups.has(sessionId);
}

/** Capture at receipt, commit only after the new input is durably saved.
 * A newer Stop always wins over an older asynchronous save/authorization.
 */
export function captureQueueAuthorization(sessionId: string): () => void {
  const stopped = stoppedQueues.get(sessionId);
  return () => {
    if (stoppedQueues.get(sessionId) === stopped) stoppedQueues.delete(sessionId);
  };
}
