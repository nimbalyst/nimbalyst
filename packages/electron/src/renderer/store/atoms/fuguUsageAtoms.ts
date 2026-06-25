/**
 * Atoms for Sakana Fugu usage tracking.
 */

import { atom } from 'jotai';
import { formatResetTime } from './claudeUsageAtoms';

export { formatResetTime };

export interface FuguUsageData {
  fiveHour: {
    utilization: number;
    resetsAt: string | null;
  };
  sevenDay: {
    utilization: number;
    resetsAt: string | null;
  };
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    sessionCount: number;
    lastSessionUpdatedAt: number | null;
  };
  limitsAvailable?: boolean;
  accountUsageConfigured?: boolean;
  accountUsageError?: string | null;
  lastUpdated: number;
  error?: string;
}

export const fuguUsageAtom = atom<FuguUsageData | null>(null);

export const fuguUsageIndicatorEnabledAtom = atom<boolean>(true);

let fuguUsageIndicatorPersistTimer: ReturnType<typeof setTimeout> | null = null;
const FUGU_USAGE_INDICATOR_PERSIST_DEBOUNCE_MS = 500;

function scheduleFuguUsageIndicatorPersist(enabled: boolean): void {
  if (fuguUsageIndicatorPersistTimer) {
    clearTimeout(fuguUsageIndicatorPersistTimer);
  }
  fuguUsageIndicatorPersistTimer = setTimeout(async () => {
    fuguUsageIndicatorPersistTimer = null;
    if (typeof window !== 'undefined' && window.electronAPI) {
      try {
        await window.electronAPI.aiSaveSettings({ showFuguUsageIndicator: enabled });
      } catch (error) {
        console.error('[fuguUsageAtoms] Failed to save usage indicator setting:', error);
      }
    }
  }, FUGU_USAGE_INDICATOR_PERSIST_DEBOUNCE_MS);
}

export const setFuguUsageIndicatorEnabledAtom = atom(
  null,
  (_get, set, enabled: boolean) => {
    set(fuguUsageIndicatorEnabledAtom, enabled);
    scheduleFuguUsageIndicatorPersist(enabled);
  }
);

export async function initFuguUsageIndicatorSetting(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return false;
  }

  try {
    const settings = await window.electronAPI.aiGetSettings();
    return (settings as Record<string, unknown>)?.showFuguUsageIndicator as boolean ?? true;
  } catch (error) {
    console.error('[fuguUsageAtoms] Failed to load usage indicator setting:', error);
  }

  return true;
}

export const fuguUsageAvailableAtom = atom((get) => {
  const usage = get(fuguUsageAtom);
  if (!usage) return false;
  if (usage.error) return true;
  const hasUsageData =
    usage.fiveHour.utilization > 0 ||
    usage.sevenDay.utilization > 0 ||
    Boolean(usage.fiveHour.resetsAt) ||
    Boolean(usage.sevenDay.resetsAt);
  const hasTokenUsage = (usage.tokenUsage?.totalTokens ?? 0) > 0;
  return hasUsageData || hasTokenUsage;
});

export const fuguUsageSessionColorAtom = atom((get) => {
  const usage = get(fuguUsageAtom);
  if (!usage) return 'muted';
  if (usage.limitsAvailable === false) return 'muted';
  const util = usage.fiveHour.utilization;
  if (util >= 80) return 'red';
  if (util >= 50) return 'yellow';
  return 'green';
});

export const fuguUsageWeeklyColorAtom = atom((get) => {
  const usage = get(fuguUsageAtom);
  if (!usage) return 'muted';
  if (usage.limitsAvailable === false) return 'muted';
  const util = usage.sevenDay.utilization;
  if (util >= 80) return 'red';
  if (util >= 50) return 'yellow';
  return 'green';
});
