/**
 * Atoms for Ollama usage tracking
 *
 * Mirrors geminiUsageAtoms.ts's shape (data atom + availability atom + color
 * atoms). The Ollama meter is a stable gutter control: it remains visible
 * before the first fetch and when credentials are missing, showing `--` and a
 * truthful setup/error state instead of silently disappearing.
 */

import { atom } from 'jotai';
import { formatResetTime } from './claudeUsageAtoms';
import type { OllamaRequestUsage } from '../../../shared/ollamaUsage';
import type { OllamaResetTimeStatus, OllamaDurationSource } from '../../../shared/ollamaResetWindows';

export { formatResetTime };

export interface OllamaUsageModelBreakdown {
  name: string;
  requestCount: number;
}

export interface OllamaUsageWindow {
  utilization: number; // 0-100 percentage
  resetsAt: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  durationSource?: OllamaDurationSource;
  models: OllamaUsageModelBreakdown[];
  modelCountsAvailable?: boolean;
}

export interface OllamaUsageData {
  limitsAvailable: boolean;
  source?: 'ollama-dashboard';
  authStatus?: 'connected' | 'sign-in-required' | 'error';
  creditBalanceUSD?: number;
  plan?: string;
  modelCountsPeriod?: 'this-week';
  requestUsage?: OllamaRequestUsage;
  limitsUnavailableReason?: string;
  session?: OllamaUsageWindow;
  weekly?: OllamaUsageWindow;
  costUSD?: number;
  costPeriod?: { type: string; startingAt: string; endingAt: string };
  lastUpdated: number;
  error?: string;
  cookieExpired?: boolean;
  resetTimeStatus?: OllamaResetTimeStatus;
  resetTimeRetryAt?: number;
}

export const ollamaUsageAtom = atom<OllamaUsageData | null>(null);

// Rail visibility follows the same NavigationGutter customization set as the
// other usage indicators -- see the note in geminiUsageAtoms.ts.

export const ollamaUsageAvailableAtom = atom(true);

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
