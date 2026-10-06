/**
 * Pure time-resolution for the "Run later" prompt scheduler. No React, no IPC —
 * kept separate from ScheduleLaterMenu.tsx so the date math is unit-testable
 * without rendering.
 */

import { MIN_WAKEUP_LEAD_MS } from '../../../shared/sessionWakeups';
import type { ClaudeUsageData } from '../../../shared/claudeUsage';

export type ScheduleLaterMode =
  | { kind: 'delay'; ms: number }
  | { kind: 'clockTime'; isoLocal: string }
  | { kind: 'usageReset'; resetsAt: string };

/** Which menu option was used; reported with the `ai_prompt_scheduled` event. */
export type ScheduleLaterChoice = 'in_1h' | 'in_4h' | 'tomorrow_morning' | 'usage_reset' | 'custom';

/**
 * Only Claude Agent / Claude Code CLI sessions draw on the Claude subscription
 * whose reset time `claudeUsageAtom` reports. For any other provider the option
 * would schedule against a limit that session never hits.
 */
export function hasClaudeUsageReset(provider: string | null | undefined): boolean {
  return provider === 'claude-code' || provider === 'claude-code-cli';
}

/**
 * When the account can send again. An exhausted weekly limit outlasts the
 * 5-hour one, so firing at the 5-hour reset would hit the weekly limit again
 * and spend the schedule. Model-scoped weekly limits are left out: they only
 * block some models, and the session may not use one of them.
 */
export function usageResumeAt(usage: Pick<ClaudeUsageData, 'fiveHour' | 'sevenDay'> | null): string | null {
  if (!usage) return null;
  if (usage.sevenDay.utilization >= 100 && usage.sevenDay.resetsAt) return usage.sevenDay.resetsAt;
  return usage.fiveHour.resetsAt;
}

/**
 * Empties the composer before the schedule request goes out and puts the
 * draft back if it fails. Clearing only after the request resolves leaves a
 * window where Enter sends the same prompt immediately as well.
 * `clearDraft` returns the function that restores it.
 */
export async function submitWithDraftCleared<T>(
  clearDraft: () => () => void,
  submit: () => Promise<T>,
): Promise<T> {
  const restoreDraft = clearDraft();
  try {
    return await submit();
  } catch (error) {
    restoreDraft();
    throw error;
  }
}

/**
 * Resolves a schedule mode to an epoch-ms fire time. Returns null when the
 * mode can't produce a valid future time (unparseable date, or a time that's
 * already passed) so the caller can disable submission instead of scheduling
 * something that fires immediately.
 */
export function resolveFireAt(mode: ScheduleLaterMode, now: number = Date.now()): number | null {
  switch (mode.kind) {
    case 'delay': {
      if (!Number.isFinite(mode.ms) || mode.ms < MIN_WAKEUP_LEAD_MS) return null;
      return now + mode.ms;
    }
    case 'clockTime': {
      const parsed = new Date(mode.isoLocal).getTime();
      if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return null;
      if (parsed < now + MIN_WAKEUP_LEAD_MS) return null;
      return parsed;
    }
    case 'usageReset': {
      const parsed = new Date(mode.resetsAt).getTime();
      if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return null;
      if (parsed < now + MIN_WAKEUP_LEAD_MS) return null;
      return parsed;
    }
    default:
      return null;
  }
}

/** 9:00 tomorrow, local time, as epoch ms. */
export function tomorrowMorning(now: number = Date.now()): number {
  const target = new Date(now);
  target.setDate(target.getDate() + 1);
  target.setHours(9, 0, 0, 0);
  return target.getTime();
}

/**
 * A `datetime-local` value (local wall-clock, no zone). `toISOString()` is UTC
 * and would shift the picker by the user's offset.
 */
export function toDateTimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Picker default: an hour out, rounded up to the next quarter hour. */
export function defaultCustomTime(now: number = Date.now()): string {
  const quarter = 15 * 60_000;
  return toDateTimeLocal(Math.ceil((now + 60 * 60_000) / quarter) * quarter);
}

/** Short hint for when an option would fire: "3:45 PM", or "Wed 9:00 AM" on another day. */
export function formatFireAtHint(fireAt: number, now: number = Date.now()): string {
  const target = new Date(fireAt);
  const sameDay = target.toDateString() === new Date(now).toDateString();
  return target.toLocaleString([], {
    ...(sameDay ? {} : { weekday: 'short' as const }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Coarse lead time for analytics; exact times would be noise. */
export function leadTimeBucket(ms: number): '<1h' | '1-4h' | '4-12h' | '12-24h' | '>24h' {
  const hours = ms / 3_600_000;
  if (hours < 1) return '<1h';
  if (hours < 4) return '1-4h';
  if (hours < 12) return '4-12h';
  if (hours < 24) return '12-24h';
  return '>24h';
}
