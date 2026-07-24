/**
 * Centralized IPC listeners for Claude usage tracking
 *
 * Follows the pattern from centralized-ipc-listener-architecture.md:
 * - Components NEVER subscribe to IPC events directly
 * - Central listeners update atoms
 * - Components read from atoms
 */

import { store } from '../index';
import { claudeUsageAtom, ClaudeUsageData } from '../atoms/claudeUsageAtoms';

/**
 * Initialize Claude usage IPC listeners.
 * Should be called once at app startup.
 *
 * @returns Cleanup function to remove listeners
 */
export function initClaudeUsageListeners(): () => void {
  const cleanups: Array<() => void> = [];

  // Handle usage updates from main process
  const handleUsageUpdate = (data: ClaudeUsageData) => {
    store.set(claudeUsageAtom, data);
  };

  cleanups.push(
    window.electronAPI.on('claude-usage:update', handleUsageUpdate)
  );

  // Fetch initial usage data on startup
  // This will wake up the service if credentials are available
  window.electronAPI.invoke('claude-usage:get').then((data: ClaudeUsageData | null) => {
    if (data) {
      store.set(claudeUsageAtom, data);
    }
  }).catch((error: Error) => {
    console.error('[ClaudeUsageListeners] Failed to get initial usage:', error);
  });

  // Cleanup function
  return () => {
    cleanups.forEach(fn => fn?.());
  };
}

/**
 * Record activity to wake up the usage service.
 * Call this when user sends a message to a Claude agent session.
 */
export async function recordClaudeActivity(): Promise<void> {
  try {
    await window.electronAPI.invoke('claude-usage:activity');
  } catch (error) {
    console.error('[ClaudeUsageListeners] Failed to record activity:', error);
  }
}

/**
 * Force refresh usage data from the API.
 */
export async function refreshClaudeUsage(): Promise<ClaudeUsageData | null> {
  try {
    const data = await window.electronAPI.invoke('claude-usage:refresh');
    return data;
  } catch (error) {
    console.error('[ClaudeUsageListeners] Failed to refresh usage:', error);
    return null;
  }
}
