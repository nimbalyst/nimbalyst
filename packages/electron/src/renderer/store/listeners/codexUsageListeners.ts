/**
 * Centralized IPC listeners for Codex usage tracking
 *
 * Follows the pattern from centralized-ipc-listener-architecture.md:
 * - Components NEVER subscribe to IPC events directly
 * - Central listeners update atoms
 * - Components read from atoms
 */

import { store } from '../index';
import { codexUsageAtom, CodexUsageData } from '../atoms/codexUsageAtoms';

export function initCodexUsageListeners(): () => void {
  const cleanups: Array<() => void> = [];

  const handleUsageUpdate = (data: CodexUsageData) => {
    store.set(codexUsageAtom, data);
  };

  cleanups.push(
    window.electronAPI.on('codex-usage:update', handleUsageUpdate)
  );

  // Fetch initial usage data on startup
  window.electronAPI.invoke('codex-usage:get').then((data: CodexUsageData | null) => {
    if (data) {
      store.set(codexUsageAtom, data);
    }
  }).catch((error: Error) => {
    console.error('[CodexUsageListeners] Failed to get initial usage:', error);
  });

  return () => {
    cleanups.forEach(fn => fn?.());
  };
}

export async function recordCodexActivity(): Promise<void> {
  try {
    await window.electronAPI.invoke('codex-usage:activity');
  } catch (error) {
    console.error('[CodexUsageListeners] Failed to record activity:', error);
  }
}

export async function refreshCodexUsage(): Promise<CodexUsageData | null> {
  try {
    const data = await window.electronAPI.invoke('codex-usage:refresh');
    return data;
  } catch (error) {
    console.error('[CodexUsageListeners] Failed to refresh usage:', error);
    return null;
  }
}
