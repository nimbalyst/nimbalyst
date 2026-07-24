/**
 * Per-key trailing debouncer.
 *
 * Multiple `schedule(key, fn)` calls with the same key within `delayMs` collapse
 * into a single trailing invocation of the most recently scheduled `fn`. Distinct
 * keys are independent.
 *
 * Extracted as a standalone (dependency-free) unit so the coalescing behaviour of
 * the file-state listeners can be tested without standing up the whole IPC/store
 * graph. Used to coalesce the git-status refresh triggered by `session-files:updated`,
 * which the file-attribution service emits once per file edit -- hundreds per
 * second during active AI tool execution.
 */
export function createPerKeyDebouncer(delayMs: number): {
  schedule: (key: string, fn: () => void) => void;
  cancel: (key: string) => void;
  cancelAll: () => void;
} {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    schedule(key: string, fn: () => void): void {
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          fn();
        }, delayMs)
      );
    },

    cancel(key: string): void {
      const existing = timers.get(key);
      if (existing) {
        clearTimeout(existing);
        timers.delete(key);
      }
    },

    cancelAll(): void {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    },
  };
}
