/**
 * Local midnight of a calendar day, or null when the day does not exist.
 *
 * `new Date(2026, 1, 31)` silently rolls over to March 3, so every parser that
 * builds a date from typed fields has to check the fields survived.
 */
export function localCalendarDate(year: number, monthIndex: number, day: number): Date | null {
  const date = new Date(year, monthIndex, day);
  return date.getFullYear() === year && date.getMonth() === monthIndex && date.getDate() === day ? date : null;
}
