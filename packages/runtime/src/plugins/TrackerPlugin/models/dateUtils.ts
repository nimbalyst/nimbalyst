/**
 * Date parsing utility for tracker frontmatter values.
 *
 * Handles the variety of formats that appear in YAML frontmatter:
 * - Date objects (YAML parser auto-converts bare dates like `date: 2025-08-25`)
 * - Numbers (timestamps)
 * - ISO strings: 2025-08-25, 2025-08-25T12:00:00Z
 * - US format: 08/25/2025, 8/25/2025
 * - Written: Aug 25, 2025 / August 25, 2025 / 25 Aug 2025
 *
 * Returns null if the value cannot be parsed as a date.
 */
/**
 * Format a Date as a local-timezone date-only string (YYYY-MM-DD).
 * Use this whenever writing dates to frontmatter so they round-trip correctly
 * through parseDate (which treats date-only strings as local midnight).
 */
export function formatLocalDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value !== 'string') return null;

  const s = value.trim();
  if (!s) return null;

  // YYYY-MM-DD or YYYY-MM-DDT00:00:00[.000]Z (construct in local time to avoid UTC midnight timezone
  // shift). The T00:00:00Z form is emitted by AI tools meaning "this date" — treat identically.
  const isoDate = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T00:00:00(?:\.\d+)?Z)?$/);
  if (isoDate) {
    return new Date(+isoDate[1], +isoDate[2] - 1, +isoDate[3]);
  }

  // MM/DD/YYYY or M/D/YYYY
  const usDate = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usDate) {
    return new Date(+usDate[3], +usDate[1] - 1, +usDate[2]);
  }

  // Fallback: let JS parse it (handles ISO datetime, "Aug 25, 2025", etc.)
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
