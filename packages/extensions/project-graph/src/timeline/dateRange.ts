export interface TimelineDateRange {
  startMs: number;
  endMs: number;
}

function localDateParts(ms: number): [number, number, number] {
  const date = new Date(ms);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()];
}

export function formatDateInput(ms: number): string {
  const [year, month, day] = localDateParts(ms);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
    ? parsed
    : null;
}

export function dateRangeFromInputs(start: string, end: string): TimelineDateRange | null {
  const startDate = parseLocalDate(start);
  const endDate = parseLocalDate(end);
  if (!startDate || !endDate || startDate.getTime() > endDate.getTime()) return null;

  const endExclusive = new Date(endDate);
  endExclusive.setDate(endExclusive.getDate() + 1);
  return { startMs: startDate.getTime(), endMs: endExclusive.getTime() - 1 };
}

export function recentDateRange(days: number, nowMs = Date.now()): TimelineDateRange {
  const end = new Date(nowMs);
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(0, days - 1));
  start.setHours(0, 0, 0, 0);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

export function timeSpansOverlap(startMs: number, endMs: number, range: TimelineDateRange): boolean {
  return startMs <= range.endMs && endMs >= range.startMs;
}

