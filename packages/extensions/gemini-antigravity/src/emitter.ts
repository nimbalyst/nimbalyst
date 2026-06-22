/**
 * Tiny synchronous EventEmitter. Avoids importing node's 'events' module so the
 * bundle stays renderer-safe. The turn bridge subscribes via `on(...)` and the
 * provider emits 'promptAdditions' (and other forwarded events).
 */

type Listener = (...args: unknown[]) => void;

export class TinyEmitter {
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch (error) {
        console.warn(`[gemini-antigravity] listener for '${event}' threw:`, error);
      }
    }
    return true;
  }

  removeAllListeners(event?: string): this {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
    return this;
  }
}
