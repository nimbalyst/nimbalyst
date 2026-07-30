/**
 * Centralized IPC listeners for Ollama Cloud usage tracking
 *
 * Follows the pattern from centralized-ipc-listener-architecture.md:
 * - Components NEVER subscribe to IPC events directly
 * - Central listeners update atoms
 * - Components read from atoms
 */

import { store } from '../index';
import { ollamaUsageAtom, OllamaUsageData } from '../atoms/ollamaUsageAtoms';

export function initOllamaUsageListeners(): () => void {
  const cleanups: Array<() => void> = [];

  const handleUsageUpdate = (data: OllamaUsageData) => {
    store.set(ollamaUsageAtom, data);
  };

  cleanups.push(
    window.electronAPI.on('ollama-usage:update', handleUsageUpdate)
  );

  // Fetch initial usage data on startup
  window.electronAPI.invoke('ollama-usage:get').then((data: OllamaUsageData | null) => {
    if (data) {
      store.set(ollamaUsageAtom, data);
    }
  }).catch((error: Error) => {
    console.error('[OllamaUsageListeners] Failed to get initial usage:', error);
  });

  return () => {
    cleanups.forEach(fn => fn?.());
  };
}

export async function recordOllamaActivity(): Promise<void> {
  try {
    await window.electronAPI.invoke('ollama-usage:activity');
  } catch (error) {
    console.error('[OllamaUsageListeners] Failed to record activity:', error);
  }
}

export async function refreshOllamaUsage(): Promise<OllamaUsageData | null> {
  try {
    const data = await window.electronAPI.invoke('ollama-usage:refresh');
    return data;
  } catch (error) {
    console.error('[OllamaUsageListeners] Failed to refresh usage:', error);
    return null;
  }
}
