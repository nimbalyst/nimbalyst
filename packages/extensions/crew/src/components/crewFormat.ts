/** Display formatting shared by the roster, desk, feed and Hire dialog. */
import type { CrewScheduleSpec, CrewWeekday } from '../shared/types';

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 1_000_000) return `${trimZero((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${trimZero((tokens / 1_000).toFixed(1))}k`;
  return String(Math.round(tokens));
}

function trimZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

function parseIso(iso: string | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "14:12" today, "Mon 09:00" within a week, "Sep 14" beyond that. */
export function formatWhen(iso: string | undefined, now: Date = new Date()): string {
  const date = parseIso(iso);
  if (!date) return '';
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (isSameDay(date, now)) return time;
  if (Math.abs(date.getTime() - now.getTime()) < 6 * 24 * 60 * 60 * 1000) {
    return `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatDay(iso: string | undefined): string {
  const date = parseIso(iso);
  return date ? date.toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
}

/** "Sep 14 - Sep 21", or "Sep 22 - now" for an open range. */
export function formatDateRange(startIso: string, endIso: string | undefined): string {
  const start = formatDay(startIso);
  const end = endIso ? formatDay(endIso) : 'now';
  return start === end ? start : `${start} - ${end}`;
}

export const WEEKDAYS: readonly CrewWeekday[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const WEEKDAY_SHORT: Record<CrewWeekday, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
};

/** The timing half of a schedule entry: "Daily 18:30", "Weekdays 09:00", "Every 90 min". */
export function formatScheduleTiming(spec: CrewScheduleSpec): string {
  if (spec.daily) return `Daily ${spec.daily}`;
  if (spec.weekly) {
    const days = spec.weekly.days;
    const isWeekdays = days.length === 5 && !days.includes('saturday') && !days.includes('sunday');
    const label = isWeekdays
      ? 'Weekdays'
      : [...days].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b)).map((day) => WEEKDAY_SHORT[day]).join(', ');
    return `${label} ${spec.weekly.time}`;
  }
  if (spec.interval) return `Every ${spec.interval.minutes} min`;
  if (spec.at) return `Once, ${formatWhen(spec.at)}`;
  return 'Unscheduled';
}

/** A filename-safe slug from a display name; the member file is `<slug>.md`. */
export function slugifyCrewName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** The name's slug, or the first free `name-2`, `name-3`, ... when it is taken. */
export function freeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!base || !taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
