/**
 * Date mention helpers: validating `YYYY-MM-DD`, the typeahead's shortcuts,
 * and the relative label a date chip shows. Dates are calendar days with no
 * time zone; every computation here works in the viewer's local calendar so
 * "today" means the viewer's today.
 */

const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  const match = value.match(ISO_DATE_REGEX);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** True for a real calendar date written `YYYY-MM-DD`. */
export function isIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The viewer's local calendar day as `YYYY-MM-DD`. */
export function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Calendar days from `now`'s local day to `iso` (negative in the past). */
export function daysFromToday(iso: string, now: Date): number | null {
  const parsed = parseIsoDate(iso);
  if (!parsed) return null;
  const target = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / DAY_MS);
}

function localDate(iso: string): Date | null {
  const parsed = parseIsoDate(iso);
  return parsed ? new Date(parsed.year, parsed.month - 1, parsed.day) : null;
}

/**
 * What a date chip shows: "today", "tomorrow", "yesterday", "in 6 days" or
 * "3 days ago" within a week, otherwise "Oct 15" (this year) or
 * "Oct 15, 2027".
 */
export function formatRelativeDate(iso: string, now: Date = new Date()): string {
  const days = daysFromToday(iso, now);
  const date = localDate(iso);
  if (days === null || !date) return iso;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 1 && days <= 7) return `in ${days} days`;
  if (days < -1 && days >= -7) return `${-days} days ago`;
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString('en-US', sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The chip's hover text: "Thursday, October 15, 2026". */
export function formatAbsoluteDate(iso: string): string {
  const date = localDate(iso);
  return date
    ? date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : iso;
}

export interface DateShortcut {
  label: string;
  iso: string;
}

function addDays(now: Date, days: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
}

/**
 * The date options the `@` typeahead offers for `query`: today, tomorrow and
 * next week (matched by prefix), or the typed date itself once it is a full
 * `YYYY-MM-DD`.
 */
export function dateShortcuts(query: string, now: Date = new Date()): DateShortcut[] {
  const q = query.trim().toLowerCase();
  if (isIsoDate(q)) return [{ label: q, iso: q }];
  const all: DateShortcut[] = [
    { label: 'Today', iso: toIsoDate(now) },
    { label: 'Tomorrow', iso: toIsoDate(addDays(now, 1)) },
    { label: 'Next week', iso: toIsoDate(addDays(now, 7)) },
  ];
  if (!q) return all;
  return all.filter((shortcut) => shortcut.label.toLowerCase().startsWith(q));
}
