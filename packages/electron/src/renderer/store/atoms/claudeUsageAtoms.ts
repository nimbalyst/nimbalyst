/**
 * Atoms for Claude Code usage tracking
 *
 * These atoms store the current usage data from Anthropic's API,
 * including 5-hour session and 7-day weekly utilization percentages.
 */

import { atom } from 'jotai';

export interface ClaudeUsageWindow {
  utilization: number; // 0-100 percentage
  resetsAt: string | null; // ISO timestamp
}

export interface ClaudeUsageData {
  fiveHour: ClaudeUsageWindow;
  sevenDay: ClaudeUsageWindow;
  sevenDayOpus?: ClaudeUsageWindow;
  lastUpdated: number; // Unix timestamp
  error?: string;
}

/**
 * Current Claude usage data from the API.
 * Updated by the centralized IPC listener when main process sends updates.
 */
export const claudeUsageAtom = atom<ClaudeUsageData | null>(null);

// Rail visibility of the usage indicator is governed by the NavigationGutter
// customization set (the single source of truth). Read it with
// `useAtomValue(hiddenGutterItemsAtom)` and toggle it with
// `useSetAtom(toggleGutterItemHiddenAtom)({ id: 'claude-usage', hidden })` from
// `store/atoms/appSettings`. The gutter's right-click "Show Claude Usage" /
// "Customize Gutter…" / "Show All" affordances read the same set, so hiding the
// indicator always has a matching rail-side restore. (The legacy
// `ai.showUsageIndicator` setting is inert -- kept only for the one-shot
// `usageIndicatorsMigratedToGutter` migration in main/utils/store.ts.)

/**
 * Derived atom: whether usage data is available to display.
 * Shows the indicator whenever we have received any usage payload from main process.
 * Error payloads still render the indicator so users can hover/click for the reason.
 */
export const claudeUsageAvailableAtom = atom((get) => {
  const usage = get(claudeUsageAtom);
  return Boolean(usage);
});

/**
 * Derived atom: color for the session (5-hour) indicator
 */
export const claudeUsageSessionColorAtom = atom((get) => {
  const usage = get(claudeUsageAtom);
  if (!usage) return 'muted';
  const util = usage.fiveHour.utilization;
  if (util >= 80) return 'red';
  if (util >= 50) return 'yellow';
  return 'green';
});

/**
 * Derived atom: color for the weekly (7-day) indicator
 */
export const claudeUsageWeeklyColorAtom = atom((get) => {
  const usage = get(claudeUsageAtom);
  if (!usage) return 'muted';
  const util = usage.sevenDay.utilization;
  if (util >= 80) return 'red';
  if (util >= 50) return 'yellow';
  return 'green';
});

/**
 * Helper to format reset time as human-readable string
 */
export function formatResetTime(resetsAt: string | null): string {
  if (!resetsAt) return 'Unknown';

  const resetDate = new Date(resetsAt);
  const now = new Date();
  const diffMs = resetDate.getTime() - now.getTime();

  if (diffMs < 0) return 'Now';

  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    const remainingHours = diffHours % 24;
    return `${diffDays}d ${remainingHours}h`;
  }
  if (diffHours > 0) {
    const remainingMinutes = diffMinutes % 60;
    return `${diffHours}h ${remainingMinutes}m`;
  }
  return `${diffMinutes}m`;
}
