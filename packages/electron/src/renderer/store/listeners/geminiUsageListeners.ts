/**
 * Centralized IPC listeners for Gemini (Antigravity) usage tracking
 *
 * Follows the pattern from centralized-ipc-listener-architecture.md:
 * - Components NEVER subscribe to IPC events directly
 * - Central listeners update atoms
 * - Components read from atoms
 */

import { store } from '../index';
import { geminiUsageAtom, GeminiUsageData } from '../atoms/geminiUsageAtoms';

export function initGeminiUsageListeners(): () => void {
  const cleanups: Array<() => void> = [];

  const handleUsageUpdate = (data: GeminiUsageData) => {
    store.set(geminiUsageAtom, data);
  };

  cleanups.push(
    window.electronAPI.on('gemini-usage:update', handleUsageUpdate)
  );

  // Fetch initial usage data on startup
  window.electronAPI.invoke('gemini-usage:get').then((data: GeminiUsageData | null) => {
    if (data) {
      store.set(geminiUsageAtom, data);
    }
  }).catch((error: Error) => {
    console.error('[GeminiUsageListeners] Failed to get initial usage:', error);
  });

  return () => {
    cleanups.forEach(fn => fn?.());
  };
}

export async function recordGeminiActivity(): Promise<void> {
  try {
    await window.electronAPI.invoke('gemini-usage:activity');
  } catch (error) {
    console.error('[GeminiUsageListeners] Failed to record activity:', error);
  }
}

export async function refreshGeminiUsage(): Promise<GeminiUsageData | null> {
  try {
    const data = await window.electronAPI.invoke('gemini-usage:refresh');
    return data;
  } catch (error) {
    console.error('[GeminiUsageListeners] Failed to refresh usage:', error);
    return null;
  }
}
