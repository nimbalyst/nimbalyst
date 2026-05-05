/**
 * Timestamp utility functions for database operations
 *
 * All timestamp columns use TIMESTAMPTZ (timestamp with time zone).
 * With TIMESTAMPTZ, PGLite returns Date objects that already represent the
 * correct instant in time. Simply call .getTime() to get epoch milliseconds.
 */

/**
 * Convert a database timestamp value to milliseconds since epoch.
 *
 * With TIMESTAMPTZ columns, PGLite returns Date objects that already represent
 * the correct instant in time. Just call getTime() to get epoch milliseconds.
 * Never reconstruct a Date via Date.UTC(d.getFullYear(), d.getMonth(), ...)
 * because that reinterprets local calendar components as UTC and double-shifts
 * the instant. Just call .getTime() on Date inputs.
 *
 * @param value - The timestamp value from the database (Date, string, number, or unknown)
 * @returns Milliseconds since epoch, or null if value is empty or invalid
 */
export function toMillis(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (value == null) return null;

  // With TIMESTAMPTZ columns, PGLite returns Date objects that already represent
  // the correct instant in time. Just call getTime() to get epoch milliseconds.
  if (value instanceof Date) {
    return value.getTime();
  }

  // Fallback for string timestamps (shouldn't happen with TIMESTAMPTZ, but just in case)
  const str = String(value).trim();
  if (!str) return null;
  // Detect timezone: ends with Z, contains +, or has negative offset like -05:00
  const hasTimezone = str.endsWith('Z') || str.includes('+') || /-\d{2}:\d{2}$/.test(str);
  const utcStr = hasTimezone ? str : str.replace(' ', 'T') + 'Z';
  const parsed = new Date(utcStr).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}
