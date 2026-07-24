/**
 * FormulaBar Component
 *
 * Displays the current cell reference and allows editing cell values/formulas.
 * Uses imperative updates to avoid parent re-renders on selection change.
 */

import { useCallback, useRef, useState, useImperativeHandle, forwardRef } from 'react';

interface FormulaBarProps {
  /** Called when the value changes */
  onChange: (value: string) => void;
}

export interface FormulaBarHandle {
  /** Update the displayed cell reference and value */
  update: (cellRef: string, value: string, isFormula: boolean) => void;
}

export const FormulaBar = forwardRef<FormulaBarHandle, FormulaBarProps>(
  function FormulaBar({ onChange }, ref) {
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
      if (localValue !== displayValue) {
        onChange(localValue);
      }
    }, [localValue, displayValue, onChange]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          if (localValue !== displayValue) {
            onChange(localValue);
          }
          inputRef.current?.blur();
        } else if (e.key === 'Escape') {
          setLocalValue(displayValue);
          inputRef.current?.blur();
        }
      },
      [localValue, displayValue, onChange]
    );

    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-nim-secondary border-b border-nim min-h-[36px]">
        <div className="font-mono text-[13px] font-semibold min-w-[48px] px-2 py-1 bg-nim-tertiary rounded text-center text-nim-muted">
          {cellRef || '-'}
        </div>
        <div className="font-mono text-[13px] italic text-[var(--nim-primary)] min-w-[20px]">
          {isFormula ? 'fx' : ''}
        </div>
        <input
          ref={inputRef}
          type="text"
          className="flex-1 px-2.5 py-1.5 font-mono text-[13px] bg-nim border border-nim rounded text-nim outline-none focus:border-[var(--nim-primary)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--nim-primary)_20%,transparent)] disabled:bg-nim-secondary disabled:text-nim-faint disabled:cursor-not-allowed placeholder:text-nim-faint"
          value={localValue}
          onChange={handleChange}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={cellRef ? 'Enter value' : 'Select a cell'}
          disabled={!cellRef}
        />
      </div>
    );
  }
);
