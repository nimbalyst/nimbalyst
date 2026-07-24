/**
 * Column Format Dialog
 *
 * Modal dialog for configuring column type and format options.
 */

import { useState, useCallback, useEffect } from 'react';
import type { ColumnFormat, ColumnType, CurrencyCode, DateFormat } from '../types';
import {
  getDefaultFormatForType,
  getColumnTypeName,
  getCurrencyName,
  getDateFormatName,
} from '../utils/formatters';

interface ColumnFormatDialogProps {
  isOpen: boolean;
  columnIndex: number;
  columnLetter: string;
  currentFormat: ColumnFormat | undefined;
  onSave: (format: ColumnFormat | null) => void;
  onClose: () => void;
}

const COLUMN_TYPES: ColumnType[] = ['text', 'number', 'currency', 'percentage', 'date'];
const CURRENCIES: CurrencyCode[] = ['USD', 'EUR', 'GBP', 'JPY', 'CNY'];
const DATE_FORMATS: DateFormat[] = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'MMM D, YYYY'];

export function ColumnFormatDialog({
  isOpen,
  columnIndex: _columnIndex,
  columnLetter,
  currentFormat,
  onSave,
  onClose,
}: ColumnFormatDialogProps) {
  // Initialize state from current format or defaults
  const [type, setType] = useState<ColumnType>(currentFormat?.type ?? 'text');
  const [decimals, setDecimals] = useState<number>(currentFormat?.decimals ?? 2);
  const [showThousandsSeparator, setShowThousandsSeparator] = useState<boolean>(
    currentFormat?.showThousandsSeparator ?? true
  );
  const [currency, setCurrency] = useState<CurrencyCode>(currentFormat?.currency ?? 'USD');
  const [dateFormat, setDateFormat] = useState<DateFormat>(currentFormat?.dateFormat ?? 'MM/DD/YYYY');

  // Reset state when dialog opens with new column
  useEffect(() => {
    if (isOpen) {
      setType(currentFormat?.type ?? 'text');
      setDecimals(currentFormat?.decimals ?? 2);
      setShowThousandsSeparator(currentFormat?.showThousandsSeparator ?? true);
      setCurrency(currentFormat?.currency ?? 'USD');
      setDateFormat(currentFormat?.dateFormat ?? 'MM/DD/YYYY');
    }
  }, [isOpen, currentFormat]);

  // Handle type change - apply default format for new type
  const handleTypeChange = useCallback((newType: ColumnType) => {
    setType(newType);
    const defaults = getDefaultFormatForType(newType);
    setDecimals(defaults.decimals ?? 2);
    setShowThousandsSeparator(defaults.showThousandsSeparator ?? true);
    setCurrency(defaults.currency ?? 'USD');
    setDateFormat(defaults.dateFormat ?? 'MM/DD/YYYY');
  }, []);

  // Handle save
  const handleSave = useCallback(() => {
    if (type === 'text') {
      // Text type doesn't need format options, so we can clear the format
      onSave(null);
    } else {
      const format: ColumnFormat = { type };

      if (type === 'number' || type === 'currency' || type === 'percentage') {
        format.decimals = decimals;
      }

      if (type === 'number' || type === 'currency') {
        format.showThousandsSeparator = showThousandsSeparator;
      }

      if (type === 'currency') {
        format.currency = currency;
      }

      if (type === 'date') {
        format.dateFormat = dateFormat;
      }

      onSave(format);
    }
    onClose();
  }, [type, decimals, showThousandsSeparator, currency, dateFormat, onSave, onClose]);

  // Handle keyboard
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter') {
        handleSave();
      }
    },
    [onClose, handleSave]
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[2000]" onClick={onClose}>
      <div
        className="bg-nim border border-nim rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.24)] min-w-[320px] max-w-[400px]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-nim">
          <h3 className="m-0 text-base font-semibold text-nim">Format Column {columnLetter}</h3>
          <button className="bg-none border-none text-xl text-nim-muted cursor-pointer p-0 leading-none hover:text-nim" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="px-5 py-5 flex flex-col gap-4">
          {/* Column Type */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-medium text-nim-muted">Type</label>
            <select
              value={type}
              onChange={(e) => handleTypeChange(e.target.value as ColumnType)}
              className="px-3 py-2 text-sm bg-nim-secondary border border-nim rounded text-nim outline-none focus:border-[var(--nim-primary)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--nim-primary)_20%,transparent)]"
            >
              {COLUMN_TYPES.map((t) => (
                <option key={t} value={t}>
                  {getColumnTypeName(t)}
                </option>
              ))}
            </select>
          </div>

          {/* Decimal Places (for number, currency, percentage) */}
          {(type === 'number' || type === 'currency' || type === 'percentage') && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[13px] font-medium text-nim-muted">Decimal Places</label>
              <input
                type="number"
                min={0}
                max={10}
                value={decimals}
                onChange={(e) => setDecimals(Math.max(0, Math.min(10, parseInt(e.target.value) || 0)))}
                className="px-3 py-2 text-sm bg-nim-secondary border border-nim rounded text-nim outline-none focus:border-[var(--nim-primary)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--nim-primary)_20%,transparent)]"
              />
            </div>
          )}

          {/* Thousands Separator (for number, currency) */}
          {(type === 'number' || type === 'currency') && (
            <div className="flex flex-row items-center">
              <label className="flex items-center gap-2 cursor-pointer font-normal text-nim">
                <input
                  type="checkbox"
                  checked={showThousandsSeparator}
                  onChange={(e) => setShowThousandsSeparator(e.target.checked)}
                  className="w-4 h-4 accent-[var(--nim-primary)]"
                />
                Show thousands separator
              </label>
            </div>
          )}

          {/* Currency (for currency type) */}
          {type === 'currency' && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[13px] font-medium text-nim-muted">Currency</label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
                className="px-3 py-2 text-sm bg-nim-secondary border border-nim rounded text-nim outline-none focus:border-[var(--nim-primary)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--nim-primary)_20%,transparent)]"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {getCurrencyName(c)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Date Format (for date type) */}
          {type === 'date' && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[13px] font-medium text-nim-muted">Date Format</label>
              <select
                value={dateFormat}
                onChange={(e) => setDateFormat(e.target.value as DateFormat)}
                className="px-3 py-2 text-sm bg-nim-secondary border border-nim rounded text-nim outline-none focus:border-[var(--nim-primary)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--nim-primary)_20%,transparent)]"
              >
                {DATE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {getDateFormatName(f)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-nim">
          <button
            className="px-4 py-2 text-sm font-medium rounded cursor-pointer transition-all bg-nim-secondary border border-nim text-nim hover:bg-nim-hover"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="px-4 py-2 text-sm font-medium rounded cursor-pointer transition-all bg-[var(--nim-primary)] border border-[var(--nim-primary)] text-white hover:opacity-90"
            onClick={handleSave}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
