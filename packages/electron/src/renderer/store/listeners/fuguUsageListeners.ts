/**
 * Centralized IPC listeners for Sakana Fugu usage tracking.
 */

import { store } from '../index';
import { fuguUsageAtom, FuguUsageData } from '../atoms/fuguUsageAtoms';

export function initFuguUsageListeners(): () => void {
  const cleanups: Array<() => void> = [];

  const handleUsageUpdate = (data: FuguUsageData) => {
    store.set(fuguUsageAtom, data);
  };

  cleanups.push(
    window.electronAPI.on('fugu-usage:update', handleUsageUpdate)
  );

  window.electronAPI.invoke('fugu-usage:get').then((data: FuguUsageData | null) => {
    if (data) {
      store.set(fuguUsageAtom, data);
    }
  }).catch((error: Error) => {
    console.error('[FuguUsageListeners] Failed to get initial usage:', error);
  });

  return () => {
    cleanups.forEach(fn => fn?.());
  };
}

export async function recordFuguActivity(): Promise<void> {
  try {
    await window.electronAPI.invoke('fugu-usage:activity');
  } catch (error) {
    console.error('[FuguUsageListeners] Failed to record activity:', error);
  }
}

export async function refreshFuguUsage(): Promise<FuguUsageData | null> {
  try {
    const data = await window.electronAPI.invoke('fugu-usage:refresh');
    if (data) {
      store.set(fuguUsageAtom, data);
    }
    return data;
  } catch (error) {
    console.error('[FuguUsageListeners] Failed to refresh usage:', error);
    return null;
  }
}
