/**
 * Event dispatch shared by every voice engine.
 *
 * Two registration modes, because the codebase has both shapes:
 *  - setSingle() is the legacy `setOnAudio(cb)` slot. Registering again
 *    replaces the previous listener, exactly as assigning a callback field did.
 *  - on() is the VoiceEngine subscription. Additive, returns an unsubscribe.
 *
 * Single-slot listeners run before subscribers, so ordering matches the old
 * "call the one callback" behavior for anything that also subscribes.
 */

import type { VoiceEngineEventMap, VoiceEngineEventName } from './voiceEngine';

export class VoiceEngineEventBus {
  private single = new Map<VoiceEngineEventName, unknown>();
  private subscribers = new Map<VoiceEngineEventName, Set<unknown>>();

  /** Replace the single-slot listener for an event (legacy setOnX behavior). */
  setSingle<K extends VoiceEngineEventName>(event: K, listener: VoiceEngineEventMap[K]): void {
    this.single.set(event, listener);
  }

  on<K extends VoiceEngineEventName>(event: K, listener: VoiceEngineEventMap[K]): () => void {
    let set = this.subscribers.get(event);
    if (!set) {
      set = new Set();
      this.subscribers.set(event, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  /** Whether anything is listening (some emitters skip building a payload). */
  has(event: VoiceEngineEventName): boolean {
    return this.single.has(event) || (this.subscribers.get(event)?.size ?? 0) > 0;
  }

  emit<K extends VoiceEngineEventName>(event: K, ...args: Parameters<VoiceEngineEventMap[K]>): void {
    const slot = this.single.get(event) as ((...a: unknown[]) => void) | undefined;
    if (slot) slot(...args);
    const subscribers = this.subscribers.get(event);
    if (!subscribers) return;
    // Copy: a listener may unsubscribe itself (or a sibling) while we iterate.
    for (const listener of [...subscribers]) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }
}
