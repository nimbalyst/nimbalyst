import type { PrototypeRange } from "./contracts";

/** Adjacent calendar windows; only the current window ends partway through a day. */
export function prototypeRange(
  now: number,
  days: number,
  offset: number
): PrototypeRange {
  const end = new Date(now);
  end.setDate(end.getDate() - offset);
  if (offset > 0) end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

/** Contiguous, equal elapsed duration; label partial/calendar-clipped buckets explicitly. */
export function precedingRange(range: PrototypeRange): PrototypeRange {
  const duration = range.endMs - range.startMs + 1;
  return { startMs: range.startMs - duration, endMs: range.startMs - 1 };
}
