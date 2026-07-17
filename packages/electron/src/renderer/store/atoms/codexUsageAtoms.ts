/**
 * Atoms and display helpers for Codex account usage.
 *
 * Codex rate-limit slots are not tied to fixed durations. Always derive the
 * user-facing label from windowDurationMins.
 */

import { atom } from 'jotai';
import { formatResetTime } from './claudeUsageAtoms';

export { formatResetTime };

export interface CodexUsageWindow {
  slot: 'primary' | 'secondary';
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: string | null;
}

export interface CodexUsageLimit {
  id: string;
  name: string | null;
  planType: string | null;
  windows: CodexUsageWindow[];
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  individualLimit: {
    limit: string;
    used: string;
    remainingPercent: number;
    resetsAt: string;
  } | null;
  rateLimitReachedType: string | null;
}

export interface CodexUsageData {
  limits: CodexUsageLimit[];
  rateLimitResetCredits?: {
    availableCount: number;
    credits: Array<{
      id: string;
      title: string | null;
      description: string | null;
      expiresAt: string | null;
    }> | null;
  } | null;
  tokenUsage?: {
    totalTokens: number;
    lastTokens: number | null;
  };
  limitsAvailable?: boolean;
  source?: 'account' | 'session';
  lastUpdated: number;
  error?: string;
}

export interface CodexUsageWindowEntry {
  limit: CodexUsageLimit;
  window: CodexUsageWindow;
}

export const codexUsageAtom = atom<CodexUsageData | null>(null);

export function getCodexUsageWindows(usage: CodexUsageData | null): CodexUsageWindowEntry[] {
  // Defensive ??s: the payload may come from a main process older than this
  // renderer (dev HMR mid-migration) or from a cached pre-`limits` snapshot.
  if (!usage) return [];
  return (usage.limits ?? []).flatMap((limit) =>
    (limit.windows ?? []).map((window) => ({ limit, window }))
  );
}

export function getMostConstrainedCodexWindow(
  usage: CodexUsageData | null
): CodexUsageWindowEntry | null {
  return getCodexUsageWindows(usage).reduce<CodexUsageWindowEntry | null>(
    (mostConstrained, entry) =>
      !mostConstrained || entry.window.usedPercent > mostConstrained.window.usedPercent
        ? entry
        : mostConstrained,
    null
  );
}

const APPROXIMATE_WINDOW_TOLERANCE = 0.05;

function isApproximateDuration(actual: number, expected: number): boolean {
  return actual >= expected * (1 - APPROXIMATE_WINDOW_TOLERANCE)
    && actual <= expected * (1 + APPROXIMATE_WINDOW_TOLERANCE);
}

export function formatCodexWindowLabel(window: CodexUsageWindow): string {
  const minutes = window.windowDurationMins;
  if (minutes !== null) {
    if (isApproximateDuration(minutes, 5 * 60)) return 'Session';
    if (isApproximateDuration(minutes, 24 * 60)) return 'Daily';
    if (isApproximateDuration(minutes, 7 * 24 * 60)) return 'Weekly';
    if (isApproximateDuration(minutes, 30 * 24 * 60)) return 'Monthly';
    if (isApproximateDuration(minutes, 365 * 24 * 60)) return 'Annual';
  }
  return window.slot === 'secondary' ? 'Secondary usage' : 'Usage';
}

export function formatCodexWindowSubtitle(window: CodexUsageWindow): string {
  const minutes = window.windowDurationMins;
  if (minutes === null) return 'Usage window';
  if (isApproximateDuration(minutes, 5 * 60)) return '5-hour window';
  if (isApproximateDuration(minutes, 24 * 60)) return '24-hour window';
  if (isApproximateDuration(minutes, 7 * 24 * 60)) return '7-day window';
  if (isApproximateDuration(minutes, 30 * 24 * 60)) return '30-day window';
  if (isApproximateDuration(minutes, 365 * 24 * 60)) return '365-day window';
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

export function codexUsageColor(usedPercent: number): 'green' | 'yellow' | 'red' {
  if (usedPercent >= 80) return 'red';
  if (usedPercent >= 50) return 'yellow';
  return 'green';
}

export const codexUsageAvailableAtom = atom((get) => {
  const usage = get(codexUsageAtom);
  if (!usage) return false;
  if (usage.error) return true;
  return getCodexUsageWindows(usage).length > 0
    || (usage.rateLimitResetCredits?.availableCount ?? 0) > 0
    || (usage.tokenUsage?.totalTokens ?? 0) > 0;
});

export const codexUsageMostConstrainedWindowAtom = atom((get) =>
  getMostConstrainedCodexWindow(get(codexUsageAtom))
);

export const codexUsageIndicatorColorAtom = atom((get) => {
  const entry = get(codexUsageMostConstrainedWindowAtom);
  return entry ? codexUsageColor(entry.window.usedPercent) : 'muted';
});
