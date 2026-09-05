/**
 * Date formatting for the Pulse views.
 *
 * "Today" and "yesterday" are calendar words. Dividing an elapsed span by
 * 86,400,000 answers a different question: at 6am, an event from 11pm last
 * night is 7 hours old and would read as "today", and across a DST transition
 * every label in the week shifts by a day. Both are computed here from local
 * calendar day boundaries instead.
 */
import { startOfLocalDay } from './pulseBuckets';

export function formatStamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Whole local calendar days between two instants. DST-length days count as one. */
export function calendarDaysBetween(fromMs: number, toMs: number): number {
  const from = startOfLocalDay(fromMs);
  const to = startOfLocalDay(toMs);
  if (to === from) return 0;
  // Midpoint rounding absorbs the 23- and 25-hour days a DST transition
  // produces, which plain division does not.
  return Math.round((to - from) / 86_400_000);
}

/**
 * An inclusive-end interval, printed with the time of day only when it does not
 * sit on local day boundaries.
 *
 * The shell's comparison window is the exact contiguous interval before the
 * current one, so for a range that is still running it starts mid-day. Printing
 * only the dates there would read as two whole days it does not cover — and
 * printing a weekday name would imply a calendar week nobody aligned it to.
 */
export function formatInterval(startMs: number, endMs: number): string {
  const endExclusive = endMs + 1;
  const dayAligned =
    startOfLocalDay(startMs) === startMs && startOfLocalDay(endExclusive) === endExclusive;
  const date: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (dayAligned) {
    // The inclusive end names the last day covered, not the exclusive boundary.
    return `${new Date(startMs).toLocaleDateString(undefined, date)} – ${new Date(
      endMs,
    ).toLocaleDateString(undefined, date)}`;
  }
  const stamp: Intl.DateTimeFormatOptions = { ...date, hour: 'numeric', minute: '2-digit' };
  return `${new Date(startMs).toLocaleString(undefined, stamp)} – ${new Date(
    endExclusive,
  ).toLocaleString(undefined, stamp)}`;
}

export function formatRelative(ms: number, nowMs: number): string {
  if (ms > nowMs) return 'ahead of now';
  const days = calendarDaysBetween(ms, nowMs);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 45) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 24) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}
