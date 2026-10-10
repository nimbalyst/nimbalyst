/**
 * Column types and their defaults: which types are numeric or temporal, the
 * default format for each, currency symbols, and the display names the format
 * dialogs show.
 */

import type {
  BooleanStyle,
  CellAlignment,
  ColumnFormat,
  ColumnType,
  CurrencyCode,
  DateFormat,
  NegativeStyle,
  NumberStyle,
  TimeFormat,
} from '../../types';

/**
 * Currency symbols for supported currencies
 */
export const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CNY: '¥',
};

/**
 * Currency locale mappings for Intl formatting
 */
export const CURRENCY_LOCALES: Record<CurrencyCode, string> = {
  USD: 'en-US',
  EUR: 'de-DE',
  GBP: 'en-GB',
  JPY: 'ja-JP',
  CNY: 'zh-CN',
};

/**
 * Default column format (text, no special formatting)
 */
export const DEFAULT_COLUMN_FORMAT: ColumnFormat = {
  type: 'text',
};

/** Types whose values are fundamentally numeric. */
const NUMERIC_TYPES: ReadonlySet<ColumnType> = new Set<ColumnType>([
  'number',
  'currency',
  'percentage',
]);

/** Types whose values are fundamentally instants. */
const TEMPORAL_TYPES: ReadonlySet<ColumnType> = new Set<ColumnType>([
  'date',
  'datetime',
  'time',
]);

export function isNumericColumnType(type: ColumnType): boolean {
  return NUMERIC_TYPES.has(type);
}

export function isTemporalColumnType(type: ColumnType): boolean {
  return TEMPORAL_TYPES.has(type);
}

/**
 * Get a default format for a column type
 */
export function getDefaultFormatForType(type: ColumnType): ColumnFormat {
  switch (type) {
    case 'number':
      return { type: 'number', decimals: 2, showThousandsSeparator: true, numberStyle: 'standard', negativeStyle: 'minus' };
    case 'currency':
      return { type: 'currency', decimals: 2, showThousandsSeparator: true, currency: 'USD', numberStyle: 'standard', negativeStyle: 'minus' };
    case 'percentage':
      // Explicit rather than guessed: see the `valuesAreFractions` note on ColumnFormat.
      return { type: 'percentage', decimals: 1, valuesAreFractions: true, negativeStyle: 'minus' };
    case 'date':
      return { type: 'date', dateFormat: 'MM/DD/YYYY' };
    case 'datetime':
      return { type: 'datetime', dateFormat: 'MM/DD/YYYY', timeFormat: 'h:mm A' };
    case 'time':
      return { type: 'time', timeFormat: 'h:mm A' };
    case 'boolean':
      return { type: 'boolean', booleanStyle: 'true-false' };
    case 'url':
      return { type: 'url' };
    case 'tracker':
      return { type: 'tracker' };
    case 'text':
    default:
      return { type: 'text' };
  }
}

/**
 * The default alignment for a column type, used when no explicit override is set.
 */
export function getDefaultAlignmentForType(type: ColumnType): CellAlignment | null {
  if (isNumericColumnType(type)) return 'right';
  if (isTemporalColumnType(type)) return 'right';
  if (type === 'boolean') return 'center';
  return null;
}

/**
 * Get display name for a column type
 */
export function getColumnTypeName(type: ColumnType): string {
  switch (type) {
    case 'text': return 'Text';
    case 'number': return 'Number';
    case 'currency': return 'Currency';
    case 'percentage': return 'Percentage';
    case 'date': return 'Date';
    case 'datetime': return 'Date & time';
    case 'time': return 'Time';
    case 'boolean': return 'Checkbox';
    case 'url': return 'Link';
    case 'tracker': return 'Tracker item';
    default: return 'Text';
  }
}

/**
 * Get display name for a currency code
 */
export function getCurrencyName(currency: CurrencyCode): string {
  switch (currency) {
    case 'USD':
      return 'US Dollar ($)';
    case 'EUR':
      return 'Euro (€)';
    case 'GBP':
      return 'British Pound (£)';
    case 'JPY':
      return 'Japanese Yen (¥)';
    case 'CNY':
      return 'Chinese Yuan (¥)';
    default:
      return currency;
  }
}

/**
 * Get display name for a date format
 */
export function getDateFormatName(format: DateFormat): string {
  switch (format) {
    case 'MM/DD/YYYY':
      return 'MM/DD/YYYY (US)';
    case 'DD/MM/YYYY':
      return 'DD/MM/YYYY (EU)';
    case 'YYYY-MM-DD':
      return 'YYYY-MM-DD (ISO)';
    case 'MMM D, YYYY':
      return 'MMM D, YYYY (Long)';
    default:
      return format;
  }
}

/**
 * Get display name for a time format
 */
export function getTimeFormatName(format: TimeFormat): string {
  switch (format) {
    case 'h:mm A': return '1:30 PM';
    case 'h:mm:ss A': return '1:30:00 PM';
    case 'HH:mm': return '13:30';
    case 'HH:mm:ss': return '13:30:00';
    default: return format;
  }
}

/**
 * Get display name for a number style
 */
export function getNumberStyleName(style: NumberStyle): string {
  switch (style) {
    case 'standard': return 'Standard (1,234.57)';
    case 'plain': return 'Plain (1234.567)';
    case 'scientific': return 'Scientific (1.23E+03)';
    case 'accounting': return 'Accounting ($ 1,234.57)';
    default: return style;
  }
}

/**
 * Get display name for a negative style
 */
export function getNegativeStyleName(style: NegativeStyle): string {
  switch (style) {
    case 'minus': return '-1,234.57';
    case 'parens': return '(1,234.57)';
    case 'red': return '-1,234.57 in red';
    case 'parens-red': return '(1,234.57) in red';
    default: return style;
  }
}

/**
 * Get display name for a boolean style
 */
export function getBooleanStyleName(style: BooleanStyle): string {
  switch (style) {
    case 'true-false': return 'TRUE / FALSE';
    case 'yes-no': return 'Yes / No';
    case 'check': return 'Checkmark';
    default: return style;
  }
}
