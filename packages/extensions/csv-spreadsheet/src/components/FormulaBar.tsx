/**
 * FormulaBar Component
 *
 * Displays the current cell reference and allows editing cell values/formulas.
 * Uses imperative updates to avoid parent re-renders on selection change.
 */

import { useCallback, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { shouldIsolateFromGrid } from '../editors/editorKeyActions';

interface FormulaBarProps {
  /** Called when the value changes */
  onChange: (value: string) => void;
  /** Show the selected cell's value but refuse edits (diff review, read-only host). */
  readOnly?: boolean;
}

export interface FormulaBarHandle {
  /** Update the displayed cell reference and value */
  update: (cellRef: string, value: string, isFormula: boolean) => void;
}

export const FormulaBar = forwardRef<FormulaBarHandle, FormulaBarProps>(
  function FormulaBar({ onChange, readOnly = false }, ref) {
    const [cellRef, setCellRef] = useState('');
    const [displayValue, setDisplayValue] = useState('');
    const [localValue, setLocalValue] = useState('');
    const [isFormula, setIsFormula] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    // Expose imperative update method
    useImperativeHandle(ref, () => ({
      update: (newCellRef: string, newValue: string, newIsFormula: boolean) => {
        setCellRef(newCellRef);
        setDisplayValue(newValue);
        setLocalValue(newValue);
        setIsFormula(newIsFormula);
      },
    }), []);

    const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setLocalValue(e.target.value);
    }, []);

    const handleBlur = useCallback(() => {
      if (readOnly) return;
      if (localValue !== displayValue) {
        onChange(localValue);
      }
    }, [readOnly, localValue, displayValue, onChange]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        // A formula being typed here is not grid input -- see
        // `shouldIsolateFromGrid`. Without this the arrow keys walk the grid
        // selection while the caret should be moving through the formula, and
        // Backspace at an empty field clears the selected cells.
        if (shouldIsolateFromGrid(e)) e.stopPropagation();
        if (e.key === 'Enter') {
          if (!readOnly && localValue !== displayValue) {
            onChange(localValue);
          }
          inputRef.current?.blur();
        } else if (e.key === 'Escape') {
          setLocalValue(displayValue);
          inputRef.current?.blur();
        }
      },
      [readOnly, localValue, displayValue, onChange]
    );

    return (
      // Fills the toolbar strip: the strip owns the background and bottom
      // border, this owns the row. Without `flex-1` the bar collapsed to its
      // content width and left most of the strip empty.
      <div className="csv-formula-bar flex flex-1 min-w-0 items-center gap-2 px-3 py-1 min-h-[32px]">
        <div className="csv-formula-bar-ref font-mono text-[12px] font-semibold min-w-[52px] px-2 py-0.5 bg-nim-tertiary rounded text-center text-nim-muted">
          {cellRef || '-'}
        </div>
        <div className="font-mono text-[12px] italic text-[var(--nim-primary)] w-[16px] shrink-0">
          {isFormula ? 'fx' : ''}
        </div>
        <input
          ref={inputRef}
          type="text"
          className={`flex-1 min-w-0 px-2.5 py-1 font-mono text-[12px] border border-nim rounded text-nim outline-none focus:border-[var(--nim-primary)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--nim-primary)_20%,transparent)] disabled:bg-nim-secondary disabled:text-nim-faint disabled:cursor-not-allowed placeholder:text-nim-faint ${
            readOnly ? 'bg-nim-secondary cursor-default' : 'bg-nim'
          }`}
          value={localValue}
          onChange={handleChange}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          // `readOnly` rather than `disabled`: the value still has to be
          // selectable and copyable while a diff is being reviewed.
          readOnly={readOnly}
          placeholder={cellRef ? (readOnly ? '' : 'Enter value') : 'Select a cell'}
          disabled={!cellRef}
        />
      </div>
    );
  }
);
