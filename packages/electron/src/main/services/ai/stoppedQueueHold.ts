/** Process-local Stop intent, independent of provider/host retirement. */
const stoppedQueues = new Map<string, object>();
const stopLookups = new Map<string, Set<symbol>>();
const stopGenerations = new Map<string, number>();
let stopGeneration = 0;
const previousHolds = new WeakMap<object, object | undefined>();
const withdrawnHolds = new WeakSet<object>();

export function holdQueueAfterStop(sessionId: string): void {
  stopGenerations.set(sessionId, ++stopGeneration);
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
  stopGenerations.set(sessionId, ++stopGeneration);
  const previous = stoppedQueues.get(sessionId);
  const held = {};
  previousHolds.set(held, previous);
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
      withdrawnHolds.add(held);
      if (stoppedQueues.get(sessionId) !== held) return;
      let restored = previous;
      while (restored && withdrawnHolds.has(restored)) restored = previousHolds.get(restored);
      if (restored) stoppedQueues.set(sessionId, restored);
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
export function captureQueueAuthorization(sessionId: string): () => boolean {
  const stopped = stoppedQueues.get(sessionId);
  const generation = stopGenerations.get(sessionId);
  return () => {
    if (stopGenerations.get(sessionId) !== generation) return false;
    if (stoppedQueues.get(sessionId) === stopped) stoppedQueues.delete(sessionId);
    return true;
  };
}
