/**
 * TipService - Client-side service for tip state management
 *
 * Reuses walkthrough IPC channels for persistence since tips share
 * the same store (tip IDs are prefixed with 'tip-' to avoid collisions).
 */

import type { WalkthroughState } from '../walkthroughs/types';
import type { TipDefinition } from './types';

/**
 * Check if a tip should be shown based on current walkthrough/tip state.
 * Tips reuse the walkthrough completed/dismissed arrays.
 */
export function shouldShowTip(
  state: WalkthroughState,
  tip: TipDefinition,
): boolean {
  // Globally disabled (shared with walkthroughs)
  if (!state.enabled) return false;

  // Newer versions should re-show even if the previous version was dismissed
  // or completed. History tracks the last version the user saw.
  if (tip.version !== undefined) {
    const history = state.history?.[tip.id];
    if (history?.version !== undefined && history.version !== tip.version) {
      return true;
    }
  }

  // Already completed (user clicked primary action)
  if (state.completed.includes(tip.id)) return false;

  // Legacy: tips are no longer dismissible, but honor any historical dismissed
  // entries from the shared walkthrough store so they stay hidden.
  if (state.dismissed.includes(tip.id)) return false;

  return true;
}

/**
 * Mark a tip as completed (user clicked primary action).
 * Persisted -- won't show again for this version.
 */
export async function markTipCompleted(tipId: string, version?: number): Promise<void> {
  return window.electronAPI.invoke('walkthroughs:mark-completed', tipId, version);
}

/**
 * Record that a tip was shown (for analytics tracking).
 */
export async function recordTipShown(tipId: string, version?: number): Promise<void> {
  return window.electronAPI.invoke('walkthroughs:record-shown', tipId, version);
}

/**
 * Register tip metadata with main process for dynamic Developer menu generation.
 */
export async function registerTipMenuEntries(
  entries: Array<{ id: string; name: string }>
): Promise<void> {
  return window.electronAPI.invoke('tips:register-menu-entries', entries);
}

/**
 * Reset dismissed/completed state for all tips (removes tip- entries from walkthrough store).
 * Used from Developer menu for testing.
 */
export async function resetTipState(): Promise<void> {
  return window.electronAPI.invoke('tips:reset');
}
