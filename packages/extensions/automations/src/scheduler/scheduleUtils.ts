/**
 * Schedule calculation utilities.
 *
 * Calculates the next run time for automation schedules.
 */

import type { AutomationSchedule, DayOfWeek } from '../frontmatter/types';

const DAY_MAP: Record<DayOfWeek, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * Parse a "HH:MM" time string into hours and minutes.
 */
function parseTime(time: string): { hours: number; minutes: number } {
  const [h, m] = time.split(':').map(Number);
  return { hours: h ?? 0, minutes: m ?? 0 };
}

/**
 * Calculate the next run time for a given schedule.
 * Returns null if the schedule can never fire (e.g., weekly with no days).
 */
export function calculateNextRun(
  schedule: AutomationSchedule,
  now: Date = new Date(),
): Date | null {
  switch (schedule.type) {
    case 'interval':
      return calculateNextInterval(schedule.intervalMinutes, now);
    case 'daily':
      return calculateNextDaily(schedule.time, now);
    case 'weekly':
      return calculateNextWeekly(schedule.days, schedule.time, now);
    default:
      return null;
  }
}

function calculateNextInterval(intervalMinutes: number, now: Date): Date | null {
  if (intervalMinutes <= 0) return null;
  return new Date(now.getTime() + intervalMinutes * 60_000);
}

function calculateNextDaily(time: string, now: Date): Date {
  const { hours, minutes } = parseTime(time);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);

  // If the time has already passed today, move to tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

function calculateNextWeekly(days: DayOfWeek[], time: string, now: Date): Date | null {
  if (days.length === 0) return null;

  const { hours, minutes } = parseTime(time);
  const targetDays = new Set(days.map((d) => DAY_MAP[d]));

  // Check up to 8 days ahead (covers all cases including same day)
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);

    if (targetDays.has(candidate.getDay()) && candidate > now) {
      return candidate;
    }
  }

  return null;
}

/**
 * Calculate milliseconds until the next run.
 * Returns null if the schedule can never fire.
 */
export function msUntilNextRun(
  schedule: AutomationSchedule,
  now: Date = new Date(),
): number | null {
  const next = calculateNextRun(schedule, now);
  if (!next) return null;
  return next.getTime() - now.getTime();
}

/**
 * Format a schedule as a human-readable string.
 */
export function formatSchedule(schedule: AutomationSchedule): string {
  switch (schedule.type) {
    case 'interval':
      if (schedule.intervalMinutes < 60) {
        return `Every ${schedule.intervalMinutes} minutes`;
      }
      const hours = Math.floor(schedule.intervalMinutes / 60);
      const mins = schedule.intervalMinutes % 60;
      if (mins === 0) {
        return `Every ${hours} hour${hours > 1 ? 's' : ''}`;
      }
      return `Every ${hours}h ${mins}m`;

    case 'daily':
      return `Daily at ${formatTime(schedule.time)}`;

    case 'weekly': {
      const dayStr = formatDayList(schedule.days);
      return `${dayStr} at ${formatTime(schedule.time)}`;
    }
  }
}

function formatTime(time: string): string {
  const { hours, minutes } = parseTime(time);
  const period = hours >= 12 ? 'PM' : 'AM';
  const h = hours % 12 || 12;
  const m = minutes.toString().padStart(2, '0');
  return `${h}:${m} ${period}`;
}

function formatDayList(days: DayOfWeek[]): string {
  const sorted = [...days].sort((a, b) => DAY_MAP[a] - DAY_MAP[b]);

  // Check for common patterns
  const isWeekdays =
    sorted.length === 5 &&
    sorted.every((d) => ['mon', 'tue', 'wed', 'thu', 'fri'].includes(d));
  if (isWeekdays) return 'Weekdays';

  const isWeekends =
    sorted.length === 2 &&
    sorted.every((d) => ['sat', 'sun'].includes(d));
  if (isWeekends) return 'Weekends';

  if (sorted.length === 7) return 'Every day';

  const labels: Record<DayOfWeek, string> = {
    mon: 'Mon',
    tue: 'Tue',
    wed: 'Wed',
    thu: 'Thu',
    fri: 'Fri',
    sat: 'Sat',
    sun: 'Sun',
  };
  return sorted.map((d) => labels[d]).join(', ');
}

/**
 * Format a relative time string (e.g., "2h ago", "in 5 min").
 */
export function formatRelativeTime(date: Date | string, now: Date = new Date()): string {
  const target = typeof date === 'string' ? new Date(date) : date;
  const diffMs = target.getTime() - now.getTime();
  const absDiff = Math.abs(diffMs);
  const isFuture = diffMs > 0;

  if (absDiff < 60_000) return isFuture ? 'in <1 min' : 'just now';
  if (absDiff < 3600_000) {
    const mins = Math.round(absDiff / 60_000);
    return isFuture ? `in ${mins} min` : `${mins}m ago`;
  }
  if (absDiff < 86_400_000) {
    const hours = Math.round(absDiff / 3600_000);
    return isFuture ? `in ${hours}h` : `${hours}h ago`;
  }
  const days = Math.round(absDiff / 86_400_000);
  if (days === 1) return isFuture ? 'Tomorrow' : 'Yesterday';
  return isFuture ? `in ${days} days` : `${days}d ago`;
}
