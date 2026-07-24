/**
 * Cell value formatting utilities
 *
 * Provides functions to format cell values based on column type and format settings.
 */

import type { ColumnFormat, ColumnType, CurrencyCode, DateFormat } from '../types';

/**
 * Currency symbols for supported currencies
 */
const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CNY: '¥',
};

/**
 * Currency locale mappings for Intl formatting
 */
const CURRENCY_LOCALES: Record<CurrencyCode, string> = {
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

/**
 * Get a default format for a column type
 */
export function getDefaultFormatForType(type: ColumnType): ColumnFormat {
  switch (type) {
    case 'number':
      return { type: 'number', decimals: 2, showThousandsSeparator: true };
    case 'currency':
      return { type: 'currency', decimals: 2, showThousandsSeparator: true, currency: 'USD' };
    case 'percentage':
      return { type: 'percentage', decimals: 1 };
    case 'date':
      return { type: 'date', dateFormat: 'MM/DD/YYYY' };
    case 'text':
    default:
      return { type: 'text' };
  }
}

/**
 * Parse a value to a number, returning null if not a valid number
 */
function parseNumber(value: string | number | null): number | null {
  if (value === null || value === '') return null;
  if (typeof value === 'number') return value;

  // Remove common formatting characters (currency symbols, commas, percent signs)
  const cleaned = value.replace(/[$€£¥,\s%]/g, '').trim();
  if (cleaned === '') return null;

  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Parse a date string in various formats
 */
function parseDate(value: string | number | null): Date | null {
  if (value === null || value === '') return null;
  if (typeof value === 'number') {
    // Excel serial date number
    if (value > 0 && value < 2958466) {
      // Excel uses 1900-01-01 as day 1, but has a bug treating 1900 as a leap year
      const excelEpoch = new Date(1899, 11, 30);
      return new Date(excelEpoch.getTime() + value * 24 * 60 * 60 * 1000);
    }
    // Unix timestamp
    return new Date(value);
  }

  const str = value.trim();
  if (str === '') return null;

  // Try various common date formats
  // ISO format: YYYY-MM-DD
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    return new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
  }

  // US format: MM/DD/YYYY or M/D/YYYY
  const usMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    return new Date(parseInt(usMatch[3]), parseInt(usMatch[1]) - 1, parseInt(usMatch[2]));
  }

  // European format: DD/MM/YYYY or D/M/YYYY
  const euMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (euMatch) {
    return new Date(parseInt(euMatch[3]), parseInt(euMatch[2]) - 1, parseInt(euMatch[1]));
  }

  // Try native Date parsing as fallback
  const parsed = new Date(str);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Format a date according to the specified format
 */
function formatDate(date: Date, format: DateFormat): string {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const year = date.getFullYear();

  const pad = (n: number) => n.toString().padStart(2, '0');

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  switch (format) {
    case 'MM/DD/YYYY':
      return `${pad(month)}/${pad(day)}/${year}`;
    case 'DD/MM/YYYY':
      return `${pad(day)}/${pad(month)}/${year}`;
    case 'YYYY-MM-DD':
      return `${year}-${pad(month)}-${pad(day)}`;
    case 'MMM D, YYYY':
      return `${monthNames[date.getMonth()]} ${day}, ${year}`;
    default:
      return `${pad(month)}/${pad(day)}/${year}`;
  }
}

/**
 * Format a number with thousands separator
 */
function formatWithThousandsSeparator(num: number, decimals: number): string {
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format a number without thousands separator
 */
function formatWithoutThousandsSeparator(num: number, decimals: number): string {
  return num.toFixed(decimals);
}

/**
 * Format a cell value according to the column format
 *
 * @param value The raw or computed cell value
 * @param format The column format configuration
 * @returns The formatted string for display
 */
export function formatCellValue(value: string | number | null, format: ColumnFormat): string {
  if (value === null || value === '') return '';

  switch (format.type) {
    case 'text':
      return String(value);

    case 'number': {
      const num = parseNumber(value);
      if (num === null) return String(value);

      const decimals = format.decimals ?? 2;
      if (format.showThousandsSeparator) {
        return formatWithThousandsSeparator(num, decimals);
      }
      return formatWithoutThousandsSeparator(num, decimals);
    }

    case 'currency': {
      const num = parseNumber(value);
      if (num === null) return String(value);

      const decimals = format.decimals ?? 2;
      const currency = format.currency ?? 'USD';
      const locale = CURRENCY_LOCALES[currency];

      try {
        return num.toLocaleString(locale, {
          style: 'currency',
          currency: currency,
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        });
      } catch {
        // Fallback if Intl fails
        const symbol = CURRENCY_SYMBOLS[currency];
        const formatted = format.showThousandsSeparator
          ? formatWithThousandsSeparator(Math.abs(num), decimals)
          : formatWithoutThousandsSeparator(Math.abs(num), decimals);
        return num < 0 ? `-${symbol}${formatted}` : `${symbol}${formatted}`;
      }
    }

    case 'percentage': {
      const num = parseNumber(value);
      if (num === null) return String(value);

      const decimals = format.decimals ?? 1;
      // If the value looks like it's already a percentage (e.g., 50 for 50%), use as is
      // If it's a decimal (e.g., 0.5 for 50%), multiply by 100
      const displayValue = Math.abs(num) <= 1 && num !== 0 ? num * 100 : num;
      return `${displayValue.toFixed(decimals)}%`;
    }

    case 'date': {
      const date = parseDate(value);
      if (date === null) return String(value);

      const dateFormat = format.dateFormat ?? 'MM/DD/YYYY';
      return formatDate(date, dateFormat);
    }

    default:
      return String(value);
  }
}

/**
 * Check if a value looks like a specific column type
 * Used for auto-detection of column types
 */
export function detectValueType(value: string): ColumnType {
  if (value === null || value === '') return 'text';

  const trimmed = value.trim();

  // Check for currency
  if (/^[\$€£¥][\d,]+(\.\d+)?$/.test(trimmed) || /^-?[\$€£¥][\d,]+(\.\d+)?$/.test(trimmed)) {
    return 'currency';
  }

  // Check for percentage
  if (/^-?\d+(\.\d+)?%$/.test(trimmed)) {
    return 'percentage';
  }

  // Check for date patterns
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(trimmed) ||
      /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(trimmed) ||
      /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(trimmed)) {
    return 'date';
  }

  // Check for number
  if (/^-?[\d,]+(\.\d+)?$/.test(trimmed)) {
    return 'number';
  }

  return 'text';
}

/**
 * Get display name for a column type
 */
export function getColumnTypeName(type: ColumnType): string {
  switch (type) {
    case 'text':
      return 'Text';
    case 'number':
      return 'Number';
    case 'currency':
      return 'Currency';
    case 'percentage':
      return 'Percentage';
    case 'date':
      return 'Date';
    default:
      return 'Text';
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
