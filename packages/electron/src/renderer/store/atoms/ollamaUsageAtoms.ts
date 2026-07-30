/**
 * Atoms for Ollama Cloud usage tracking
 *
 * Mirrors geminiUsageAtoms.ts's shape (data atom + availability atom + color
 * atoms), with one deliberate difference in the availability atom: Gemini's
 * `if (usage.error) return true` latches the indicator permanently visible
 * after ANY failure, including "never configured" -- which is why a user who
 * has never touched Gemini can still see a stuck, muted indicator after one
 * early failed attempt. Ollama's version distinguishes "OLLAMA_API_KEY was
 * never set" (stay hidden -- this IS the "not everybody has Ollama" case)
 * from a transient failure once a key IS configured (stay visible with the
 * error in the tooltip, same as Gemini).
 */

import { atom } from 'jotai';
import { formatResetTime } from './claudeUsageAtoms';

export { formatResetTime };

export interface OllamaUsageModelBreakdown {
  name: string;
  requestCount: number;
}

export interface OllamaUsageWindow {
  utilization: number; // 0-100 percentage
  resetsAt: string | null;
  models: OllamaUsageModelBreakdown[];
}

export interface OllamaUsagePlanTier {
  tier: string;
  concurrentCloudModels: number;
  weeklyGpuQuota: string;
}

export interface OllamaUsageData {
  limitsAvailable: boolean;
  session?: OllamaUsageWindow;
  weekly?: OllamaUsageWindow;
  costUSD?: number;
  costPeriod?: { type: string; startingAt: string; endingAt: string };
  proxyReachable: boolean;
  configuredAliases: string[];
  planTiers: OllamaUsagePlanTier[];
  lastUpdated: number;
  error?: string;
}

export const ollamaUsageAtom = atom<OllamaUsageData | null>(null);

// Rail visibility follows the same NavigationGutter customization set as the
// other usage indicators -- see the note in geminiUsageAtoms.ts.

/** True when `OLLAMA_API_KEY` was never configured -- the "not everybody has Ollama" case. */
function isNeverConfigured(usage: OllamaUsageData): boolean {
  return Boolean(usage.error?.includes('OLLAMA_API_KEY'));
}

export const ollamaUsageAvailableAtom = atom((get) => {
  const usage = get(ollamaUsageAtom);
  if (!usage) return false;
  if (isNeverConfigured(usage)) return false;
  // Keep visible for a TRANSIENT load failure (key is set, API/network hiccup)
  // so the user can see the reason in tooltip/popover -- same spirit as Gemini.
  if (usage.error) return true;
  return Boolean(usage.limitsAvailable || usage.proxyReachable);
});

export const ollamaUsageSessionColorAtom = atom((get) => {
  const usage = get(ollamaUsageAtom);
  if (!usage || !usage.limitsAvailable || !usage.session) return 'muted';
  const util = usage.session.utilization;
  if (util >= 80) return 'red';
  if (util >= 50) return 'yellow';
  return 'green';
});

export const ollamaUsageWeeklyColorAtom = atom((get) => {
  const usage = get(ollamaUsageAtom);
  if (!usage || !usage.limitsAvailable || !usage.weekly) return 'muted';
  const util = usage.weekly.utilization;
  if (util >= 80) return 'red';
  if (util >= 50) return 'yellow';
  return 'green';
});
