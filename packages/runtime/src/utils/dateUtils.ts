/**
 * Shared date utilities for formatting and displaying dates/times consistently
 * across the application with error protection
 */

/**
 * Safely parse a timestamp value that could be a number, string, or Date
 * Returns null if the value is invalid
 */
export function parseTimestamp(value: number | string | Date | undefined | null): Date | null {
  if (!value) return null;

  try {
    const date = value instanceof Date ? value : new Date(value);
    // Check if the date is valid
    if (isNaN(date.getTime())) return null;
    return date;
  } catch {
    return null;
  }
}

/**
 * Format a timestamp as relative time (e.g., "5m ago", "2h ago", "3d ago")
 * Returns empty string for invalid timestamps
 */
export function formatTimeAgo(timestamp: number | string | Date | undefined | null): string {
  const date = parseTimestamp(timestamp);
  if (!date) return '';

  try {
    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    const diffWeeks = Math.floor(diffDays / 7);
    if (diffWeeks < 4) return `${diffWeeks}w ago`;
    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths < 12) return `${diffMonths}mo ago`;
    const diffYears = Math.floor(diffDays / 365);
    return `${diffYears}y ago`;
  } catch {
    return '';
  }
}

/**
 * Format duration between two timestamps
 * Returns empty string for invalid timestamps
 */
export function formatDuration(start: number | string | Date | undefined | null, end?: number | string | Date | undefined | null): string {
  const startDate = parseTimestamp(start);
  if (!startDate) return '';

  try {
    const startTime = startDate.getTime();
    const endTime = end ? (parseTimestamp(end)?.getTime() ?? Date.now()) : Date.now();
    const durationMs = endTime - startTime;

    if (durationMs < 0) return '0ms'; // Handle negative durations
    if (durationMs < 1000) return `${durationMs}ms`;
    if (durationMs < 60000) return `${(durationMs / 1000).toFixed(1)}s`;
    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);
    if (minutes < 60) return `${minutes}m ${seconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMins = minutes % 60;
    return `${hours}h ${remainingMins}m`;
  } catch {
    return '';
  }
}

/**
 * Format a timestamp as a full date string with locale support
 * Returns 'Invalid Date' for invalid timestamps
 */
export function formatDate(timestamp: number | string | Date | undefined | null): string {
  const date = parseTimestamp(timestamp);
  if (!date) return 'Invalid Date';

  try {
    return date.toLocaleString();
  } catch {
    return 'Invalid Date';
  }
}

/**
 * Format a timestamp as a short date (date only, no time)
 * Returns 'Invalid Date' for invalid timestamps
 */
export function formatShortDate(timestamp: number | string | Date | undefined | null): string {
  const date = parseTimestamp(timestamp);
  if (!date) return 'Invalid Date';

  try {
    return date.toLocaleDateString();
  } catch {
    return 'Invalid Date';
  }
}

/**
 * Format a timestamp as ISO string
 * Returns empty string for invalid timestamps
 */
export function formatISO(timestamp: number | string | Date | undefined | null): string {
  const date = parseTimestamp(timestamp);
  if (!date) return '';

  try {
    return date.toISOString();
  } catch {
    return '';
  }
}

/**
 * Safely get a valid timestamp value
 * Returns current timestamp if value is invalid
 */
export function safeTimestamp(timestamp: number | string | Date | undefined | null): number {
  const date = parseTimestamp(timestamp);
  return date ? date.getTime() : Date.now();
}

function isSameCalendarDay(date: Date, reference: Date): boolean {
  return (
    date.getDate() === reference.getDate() &&
    date.getMonth() === reference.getMonth() &&
    date.getFullYear() === reference.getFullYear()
  );
}

function formatLowercaseMeridiemTime(date: Date): string {
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const meridiem = hours >= 12 ? 'pm' : 'am';
  const displayHour = hours % 12 || 12;
  return `${displayHour}:${minutes} ${meridiem}`;
}

function formatOrdinalDay(day: number): string {
  const remainder = day % 100;
  if (remainder >= 11 && remainder <= 13) {
    return `${day}th`;
  }
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TURN_FINISHED_AT_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Check if a date is today
 */
export function isToday(date: Date, reference: Date = new Date()): boolean {
  return isSameCalendarDay(date, reference);
}

/**
 * Format a timestamp for message display:
 * - If today: shows time only (e.g., "3:45:30 PM")
 * - If not today: shows short date + time (e.g., "Dec 4, 3:45 PM")
 * Returns empty string for invalid timestamps
 */
export function formatMessageTime(timestamp: number | string | Date | undefined | null): string {
  const date = parseTimestamp(timestamp);
  if (!date) return '';

  try {
    if (isToday(date)) {
      return date.toLocaleTimeString();
    }
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  } catch {
    return '';
  }
}

/**
 * Format a timestamp as short time (HH:MM)
 * Returns empty string for invalid timestamps
 */
export function formatShortTime(timestamp: number | string | Date | undefined | null): string {
  const date = parseTimestamp(timestamp);
  if (!date) return '';

  try {
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '';
  }
}

/**
 * Format a turn-end timestamp for transcript summaries.
 * Returns empty string when the turn finished within the last 5 minutes.
 */
export function formatTurnFinishedAt(
  timestamp: number | string | Date | undefined | null,
  reference: number | string | Date | undefined | null = new Date(),
): string {
  const date = parseTimestamp(timestamp);
  const now = parseTimestamp(reference);
  if (!date || !now) return '';

  if ((now.getTime() - date.getTime()) <= TURN_FINISHED_AT_THRESHOLD_MS) {
    return '';
  }

  const timeLabel = formatLowercaseMeridiemTime(date);
  if (isToday(date, now)) {
    return `at ${timeLabel}`;
  }

  const weekday = WEEKDAY_NAMES[date.getDay()];
  const month = MONTH_NAMES[date.getMonth()];
  const day = formatOrdinalDay(date.getDate());
  return `at ${timeLabel}, ${weekday} ${month} ${day}, ${date.getFullYear()}`;
}
