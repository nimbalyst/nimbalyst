/**
 * Centralized IPC listeners for Ollama usage tracking
 *
 * Follows the pattern from centralized-ipc-listener-architecture.md:
 * - Components NEVER subscribe to IPC events directly
 * - Central listeners update atoms
 * - Components read from atoms
 */

import { store } from '../index';
import { ollamaUsageAtom, type OllamaUsageData } from '../atoms/ollamaUsageAtoms';
import { activeWorkspacePathAtom } from '../atoms/openProjects';

type ScopedUsageUpdate = { workspacePath: string; usage: OllamaUsageData };

export function initOllamaUsageListeners(): () => void {
  const cleanups: Array<() => void> = [];
  let requestSequence = 0;

  const handleUsageUpdate = ({ workspacePath, usage }: ScopedUsageUpdate) => {
    if (workspacePath === store.get(activeWorkspacePathAtom)) {
      store.set(ollamaUsageAtom, usage);
    }
  };

  cleanups.push(
    window.electronAPI.on('ollama-usage:update', handleUsageUpdate)
  );

  const loadActiveWorkspace = () => {
    const workspacePath = store.get(activeWorkspacePathAtom);
    const sequence = ++requestSequence;
    store.set(ollamaUsageAtom, null);
    if (!workspacePath) return;
    window.electronAPI.invoke('ollama-usage:get', workspacePath).then((data: OllamaUsageData | null) => {
      if (sequence === requestSequence && workspacePath === store.get(activeWorkspacePathAtom)) {
        store.set(ollamaUsageAtom, data);
      }
    }).catch((error: Error) => {
      console.error('[OllamaUsageListeners] Failed to get usage:', error);
    });
  };
  cleanups.push(store.sub(activeWorkspacePathAtom, loadActiveWorkspace));
  loadActiveWorkspace();

  return () => {
    requestSequence++;
    cleanups.forEach(fn => fn?.());
  };
}

export async function recordOllamaActivity(): Promise<void> {
  try {
    const workspacePath = store.get(activeWorkspacePathAtom);
    if (workspacePath) await window.electronAPI.invoke('ollama-usage:activity', workspacePath);
  } catch (error) {
    console.error('[OllamaUsageListeners] Failed to record activity:', error);
  }
}

export async function refreshOllamaUsage(): Promise<OllamaUsageData | null> {
  try {
    const workspacePath = store.get(activeWorkspacePathAtom);
    if (!workspacePath) return null;
    const data = await window.electronAPI.invoke('ollama-usage:refresh', workspacePath);
    if (workspacePath === store.get(activeWorkspacePathAtom)) store.set(ollamaUsageAtom, data);
    return data;
  } catch (error) {
    console.error('[OllamaUsageListeners] Failed to refresh usage:', error);
    return null;
  }
}

/** Called by the visible panel, never by background usage/activity polling. */
export async function loadOllamaResetTimes(): Promise<OllamaUsageData | null> {
  const workspacePath = store.get(activeWorkspacePathAtom);
  if (!workspacePath) return null;
  try {
    const data = await window.electronAPI.invoke('ollama-usage:reset-times', workspacePath);
    if (workspacePath === store.get(activeWorkspacePathAtom)) store.set(ollamaUsageAtom, data);
    return data;
  } catch { return null; }
}
