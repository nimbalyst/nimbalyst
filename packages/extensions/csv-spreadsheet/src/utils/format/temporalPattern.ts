/**
 * Date/time display patterns: the token formatter and the pattern each date
 * and time format resolves to.
 */

import type { ColumnFormat, DateFormat, TimeFormat } from '../../types';

const MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Tokens are matched by a single alternation so a substituted value can never
 * be re-matched — `MMM` yielding `May` must not then have its `M` replaced.
 * Longest tokens come first. `[...]` escapes a literal run.
 */
const PATTERN_TOKENS = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|A|a/g;

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Render a Date through a token pattern.
 *
 * Supported: `YYYY` `YY` `MMMM` `MMM` `MM` `M` `DD` `D` `dddd` `ddd`
 * `HH` `H` (24h) `hh` `h` (12h) `mm` `m` `ss` `s` `A` `a` (meridiem),
 * plus `[literal]` for text that should pass through untouched.
 */
export function formatWithPattern(date: Date, pattern: string): string {
  const hours24 = date.getHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;

  return pattern.replace(PATTERN_TOKENS, (token, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case 'YYYY': return date.getFullYear().toString();
      case 'YY': return date.getFullYear().toString().slice(-2);
      case 'MMMM': return MONTH_NAMES_LONG[date.getMonth()];
      case 'MMM': return MONTH_NAMES_SHORT[date.getMonth()];
      case 'MM': return pad2(date.getMonth() + 1);
      case 'M': return (date.getMonth() + 1).toString();
      case 'DD': return pad2(date.getDate());
      case 'D': return date.getDate().toString();
      case 'dddd': return DAY_NAMES_LONG[date.getDay()];
      case 'ddd': return DAY_NAMES_SHORT[date.getDay()];
      case 'HH': return pad2(hours24);
      case 'H': return hours24.toString();
      case 'hh': return pad2(hours12);
      case 'h': return hours12.toString();
      case 'mm': return pad2(date.getMinutes());
      case 'm': return date.getMinutes().toString();
      case 'ss': return pad2(date.getSeconds());
      case 's': return date.getSeconds().toString();
      case 'A': return hours24 < 12 ? 'AM' : 'PM';
      case 'a': return hours24 < 12 ? 'am' : 'pm';
      default: return token;
    }
  });
}

/** The four named date presets expressed as patterns. */
function datePatternFor(format: DateFormat): string {
  switch (format) {
    case 'DD/MM/YYYY': return 'DD/MM/YYYY';
    case 'YYYY-MM-DD': return 'YYYY-MM-DD';
    case 'MMM D, YYYY': return 'MMM D, YYYY';
    case 'MM/DD/YYYY':
    default:
      return 'MM/DD/YYYY';
  }
}

/** The named time presets expressed as patterns. */
function timePatternFor(format: TimeFormat): string {
  switch (format) {
    case 'h:mm:ss A': return 'h:mm:ss A';
    case 'HH:mm': return 'HH:mm';
    case 'HH:mm:ss': return 'HH:mm:ss';
    case 'h:mm A':
    default:
      return 'h:mm A';
  }
}

/**
 * Resolve the effective pattern for a temporal column — the custom pattern when
 * one is set, otherwise the named presets for the column's type.
 */
export function resolveTemporalPattern(format: ColumnFormat): string {
  if (format.pattern) return format.pattern;
  const datePart = datePatternFor(format.dateFormat ?? 'MM/DD/YYYY');
  const timePart = timePatternFor(format.timeFormat ?? 'h:mm A');
  switch (format.type) {
    case 'time': return timePart;
    case 'datetime': return `${datePart} ${timePart}`;
    case 'date':
    default:
      return datePart;
  }
}
