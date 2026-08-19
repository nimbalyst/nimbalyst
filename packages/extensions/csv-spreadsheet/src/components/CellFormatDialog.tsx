/**
 * Cell Format Dialog
 *
 * Styling for the selected range: weight, emphasis, colors, and alignment.
 * Separate from the column format dialog because these are different questions
 * — one is "what kind of data is this", the other is "how should it look".
 * Nothing here changes a cell's value, so it is safe on formulas and dates.
 */

import { useCallback, useEffect, useState } from 'react';
import type { CellAlignment, CellColor, CellStyle } from '../types';

interface CellFormatDialogProps {
  isOpen: boolean;
  /** A1 label for the selection being styled, e.g. `B2` or `A1:C10`. */
  rangeLabel: string;
  currentStyle: CellStyle | null;
  onSave: (style: CellStyle) => void;
  onClose: () => void;
}

const COLORS: CellColor[] = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
const ALIGNMENTS: (CellAlignment | 'auto')[] = ['auto', 'left', 'center', 'right'];

const LABEL_CLASS = 'text-[13px] font-medium text-nim-muted';
const SELECT_CLASS =
  'px-3 py-2 text-sm bg-nim-secondary border border-nim rounded text-nim outline-none focus:border-[var(--nim-primary)]';

/** Swatch preview so a color name is not the only cue. */
function swatchClass(color: CellColor): string {
  return color === 'default' ? 'csv-swatch-default' : `csv-fill-${color}`;
}

export function CellFormatDialog({
  isOpen,
  rangeLabel,
  currentStyle,
  onSave,
  onClose,
}: CellFormatDialogProps) {
  const [bold, setBold] = useState(false);
  const [italic, setItalic] = useState(false);
  const [underline, setUnderline] = useState(false);
  const [strikethrough, setStrikethrough] = useState(false);
  const [textColor, setTextColor] = useState<CellColor>('default');
  const [fillColor, setFillColor] = useState<CellColor>('default');
  const [align, setAlign] = useState<CellAlignment | 'auto'>('auto');

  useEffect(() => {
    if (!isOpen) return;
    setBold(currentStyle?.bold ?? false);
    setItalic(currentStyle?.italic ?? false);
    setUnderline(currentStyle?.underline ?? false);
    setStrikethrough(currentStyle?.strikethrough ?? false);
    setTextColor(currentStyle?.textColor ?? 'default');
    setFillColor(currentStyle?.fillColor ?? 'default');
    setAlign(currentStyle?.align ?? 'auto');
  }, [isOpen, currentStyle]);

  const handleSave = useCallback(() => {
    // Every field is sent, including the false/`default` ones: an unchecked box
    // has to clear an existing style rather than leave it in place.
    onSave({
      bold,
      italic,
      underline,
      strikethrough,
      textColor,
      fillColor,
      ...(align === 'auto' ? {} : { align }),
    });
    onClose();
  }, [bold, italic, underline, strikethrough, textColor, fillColor, align, onSave, onClose]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') onClose();
    else if (event.key === 'Enter') handleSave();
  }, [onClose, handleSave]);

  if (!isOpen) return null;

  const toggles: [string, boolean, (next: boolean) => void][] = [
    ['Bold', bold, setBold],
    ['Italic', italic, setItalic],
    ['Underline', underline, setUnderline],
    ['Strikethrough', strikethrough, setStrikethrough],
  ];

  return (
    <div className="csv-cell-format-dialog fixed inset-0 bg-black/40 flex items-center justify-center z-[2000]" onClick={onClose}>
      <div
        className="bg-nim border border-nim rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.24)] min-w-[320px] max-w-[380px]"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-nim">
          <h3 className="m-0 text-base font-semibold text-nim">Format Cells {rangeLabel}</h3>
          <button className="bg-none border-none text-xl text-nim-muted cursor-pointer p-0 leading-none hover:text-nim" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="px-5 py-5 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            {toggles.map(([label, value, set]) => (
              <label key={label} className="flex items-center gap-2 cursor-pointer font-normal text-nim">
                <input
                  type="checkbox"
                  checked={value}
                  onChange={(event) => set(event.target.checked)}
                  className="w-4 h-4 accent-[var(--nim-primary)]"
                />
                {label}
              </label>
            ))}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className={LABEL_CLASS}>Text color</label>
            <div className="flex items-center gap-2">
              <span className={`csv-swatch ${swatchClass(textColor)}`} />
              <select
                value={textColor}
                onChange={(event) => setTextColor(event.target.value as CellColor)}
                className={`${SELECT_CLASS} flex-1`}
              >
                {COLORS.map((color) => (
                  <option key={color} value={color}>{color === 'default' ? 'Default' : color}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className={LABEL_CLASS}>Fill</label>
            <div className="flex items-center gap-2">
              <span className={`csv-swatch ${swatchClass(fillColor)}`} />
              <select
                value={fillColor}
                onChange={(event) => setFillColor(event.target.value as CellColor)}
                className={`${SELECT_CLASS} flex-1`}
              >
                {COLORS.map((color) => (
                  <option key={color} value={color}>{color === 'default' ? 'None' : color}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className={LABEL_CLASS}>Alignment</label>
            <select
              value={align}
              onChange={(event) => setAlign(event.target.value as CellAlignment | 'auto')}
              className={SELECT_CLASS}
            >
              {ALIGNMENTS.map((option) => (
                <option key={option} value={option}>
                  {option === 'auto' ? 'Automatic' : option.charAt(0).toUpperCase() + option.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-nim">
          <button
            className="px-4 py-2 text-sm font-medium rounded cursor-pointer bg-nim-secondary border border-nim text-nim hover:bg-nim-hover"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="px-4 py-2 text-sm font-medium rounded cursor-pointer bg-[var(--nim-primary)] border border-[var(--nim-primary)] text-white hover:opacity-90"
            onClick={handleSave}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
