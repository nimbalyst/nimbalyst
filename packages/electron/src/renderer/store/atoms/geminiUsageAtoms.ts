/**
 * Atoms for Gemini (Antigravity) usage tracking
 *
 * These atoms store usage data parsed from the gemini-antigravity backend
 * module's getUsageSnapshot RPC, including a most-constrained model quota
 * (primary ring) and the next-most-constrained (secondary ring). Degrades to a
 * muted "--" state when the language server is not running.
 */

import { atom } from 'jotai';
import { formatResetTime } from './claudeUsageAtoms';

export { formatResetTime };

export interface GeminiUsageData {
  fiveHour: {
    utilization: number; // 0-100 percentage
    resetsAt: string | null; // ISO timestamp
  };
  sevenDay: {
    utilization: number;
    resetsAt: string | null;
  };
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: number | null;
  };
  tokenUsage?: {
    totalTokens: number;
    lastTokens: number | null;
  };
  limitsAvailable?: boolean;
  available?: boolean;
  lastUpdated: number; // Unix timestamp
  error?: string;
  /** True when the backend module has not started yet (benign idle state, not an error). */
  notStarted?: boolean;
}

export const geminiUsageAtom = atom<GeminiUsageData | null>(null);

export const geminiUsageIndicatorEnabledAtom = atom<boolean>(true);

let geminiUsageIndicatorPersistTimer: ReturnType<typeof setTimeout> | null = null;
const GEMINI_USAGE_INDICATOR_PERSIST_DEBOUNCE_MS = 500;

function scheduleGeminiUsageIndicatorPersist(enabled: boolean): void {
  if (geminiUsageIndicatorPersistTimer) {
    clearTimeout(geminiUsageIndicatorPersistTimer);
  }
  geminiUsageIndicatorPersistTimer = setTimeout(async () => {
    geminiUsageIndicatorPersistTimer = null;
    if (typeof window !== 'undefined' && window.electronAPI) {
      try {
        // Send only the changed field -- ai:saveSettings handles partial updates
        await window.electronAPI.aiSaveSettings({ showGeminiUsageIndicator: enabled });
      } catch (error) {
        console.error('[geminiUsageAtoms] Failed to save usage indicator setting:', error);
      }
    }
  }, GEMINI_USAGE_INDICATOR_PERSIST_DEBOUNCE_MS);
}

export const setGeminiUsageIndicatorEnabledAtom = atom(
  null,
  (_get, set, enabled: boolean) => {
    set(geminiUsageIndicatorEnabledAtom, enabled);
    scheduleGeminiUsageIndicatorPersist(enabled);
  }
);

export async function initGeminiUsageIndicatorSetting(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return false;
  }

  try {
    const settings = await window.electronAPI.aiGetSettings();
    return (settings as Record<string, unknown>)?.showGeminiUsageIndicator as boolean ?? true;
  } catch (error) {
    console.error('[geminiUsageAtoms] Failed to load usage indicator setting:', error);
  }

  return true;
}

export const geminiUsageAvailableAtom = atom((get) => {
  const usage = get(geminiUsageAtom);
  if (!usage) return false;
  // Keep the indicator visible for load failures so users can see the reason in tooltip/popover.
  if (usage.error) return true;
  // Show if we have actual usage data (utilization or reset times), or credits info.
  const hasUsageData =
    usage.fiveHour.utilization > 0 ||
    usage.sevenDay.utilization > 0 ||
    Boolean(usage.fiveHour.resetsAt) ||
    Boolean(usage.sevenDay.resetsAt);
  const hasCreditsData = Boolean(usage.credits?.hasCredits) || usage.credits?.balance !== null;
  const hasTokenUsage = (usage.tokenUsage?.totalTokens ?? 0) > 0;
  return hasUsageData || hasCreditsData || hasTokenUsage;
});

export const geminiUsageSessionColorAtom = atom((get) => {
  const usage = get(geminiUsageAtom);
  if (!usage) return 'muted';
  const util = usage.fiveHour.utilization;
  if (util >= 80) return 'red';
  if (util >= 50) return 'yellow';
  return 'green';
});

export const geminiUsageWeeklyColorAtom = atom((get) => {
  const usage = get(geminiUsageAtom);
  if (!usage) return 'muted';
  const util = usage.sevenDay.utilization;
  if (util >= 80) return 'red';
  if (util >= 50) return 'yellow';
  return 'green';
});
