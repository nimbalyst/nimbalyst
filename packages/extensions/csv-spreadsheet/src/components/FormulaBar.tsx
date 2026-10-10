/**
 * FormulaBar Component
 *
 * The name box (the active cell or selection, e.g. `B2` or `A1:C5`; type a
 * reference and press Enter to jump there) and the value/formula input.
 * Uses imperative updates to avoid parent re-renders on selection change.
 *
 * While a formula is shown, each reference is tinted in the color its outline
 * has on the grid. A plain input can't color substrings, so a mirror layer
 * behind it renders the colored text and the input's own text goes
 * transparent; the caret, selection and IME stay on the real input. The two
 * share `FIELD_METRICS` so the characters line up, and the mirror follows the
 * input's horizontal scroll.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { shouldIsolateFromGrid } from '../editors/editorKeyActions';
import type { NormalizedSelectionRange } from '../types';
import { FormulaAssistPopover } from './FormulaAssistPopover';
import { cycleAbsoluteIn, FORMULA_BAR_INPUT_CLASS, useEditSnapshot, useFormulaAssist } from '../formula/editSurface';
import { parseNameBoxReference, referenceHighlights } from '../formula/pointMode';

interface FormulaBarProps {
  /** Called when the value changes */
  onChange: (value: string) => void;
  /** Show the selected cell's value but refuse edits (diff review, read-only host). */
  readOnly?: boolean;
  /** Select a range typed into the name box (A1 rows). */
  onNavigate?: (range: NormalizedSelectionRange) => void;
  /** Named ranges, for autocomplete and name-box jumps. */
  getNamedRanges?: () => Readonly<Record<string, string>>;
}

export interface FormulaBarHandle {
  /** Update the displayed cell reference and value */
  update: (cellRef: string, value: string, isFormula: boolean) => void;
}

/** Shared by the input and its mirror; any difference shows as drifting colors. */
const FIELD_METRICS = 'px-2.5 font-mono text-[12px] leading-[22px] border';

function MirrorText({ text }: { text: string }) {
  const highlights = referenceHighlights(text);
  const parts: React.ReactNode[] = [];
  let index = 0;
  for (const highlight of highlights) {
    if (highlight.start > index) parts.push(text.slice(index, highlight.start));
    parts.push(
      <span key={highlight.start} style={{ color: highlight.color }}>
        {text.slice(highlight.start, highlight.end)}
      </span>,
    );
    index = highlight.end;
  }
  if (index < text.length) parts.push(text.slice(index));
  return <>{parts}</>;
}

export const FormulaBar = forwardRef<FormulaBarHandle, FormulaBarProps>(
  function FormulaBar({ onChange, readOnly = false, onNavigate, getNamedRanges }, ref) {
    const [cellRef, setCellRef] = useState('');
    const [displayValue, setDisplayValue] = useState('');
    const [localValue, setLocalValue] = useState('');
    const [isFormula, setIsFormula] = useState(false);
    const [input, setInput] = useState<HTMLInputElement | null>(null);
    const [focused, setFocused] = useState(false);
    const [nameDraft, setNameDraft] = useState<string | null>(null);
    const [nameInvalid, setNameInvalid] = useState(false);
    const mirrorRef = useRef<HTMLDivElement>(null);
    const nameJustFocusedRef = useRef(false);

    // Expose imperative update method
    useImperativeHandle(ref, () => ({
      update: (newCellRef: string, newValue: string, newIsFormula: boolean) => {
        setCellRef(newCellRef);
        setDisplayValue(newValue);
        setLocalValue(newValue);
        setIsFormula(newIsFormula);
      },
    }), []);

    const snapshot = useEditSnapshot(focused && !readOnly ? input : null);
    const assist = useFormulaAssist(input, snapshot, getNamedRanges);
    const colored = useMemo(() => referenceHighlights(localValue).length > 0, [localValue]);

    const syncMirrorScroll = useCallback(() => {
      if (mirrorRef.current && input) mirrorRef.current.scrollLeft = input.scrollLeft;
    }, [input]);
    useEffect(syncMirrorScroll, [localValue, snapshot, syncMirrorScroll]);

    const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setLocalValue(e.target.value);
    }, []);

    const handleBlur = useCallback(() => {
      setFocused(false);
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
        if (e.key === 'F4' && !readOnly && input && cycleAbsoluteIn(input)) {
          e.preventDefault();
          e.stopPropagation();
        } else if (e.key === 'Enter') {
          if (!readOnly && localValue !== displayValue) {
            onChange(localValue);
          }
          input?.blur();
        } else if (e.key === 'Escape') {
          setLocalValue(displayValue);
          input?.blur();
        }
      },
      [readOnly, localValue, displayValue, onChange, input]
    );

    const handleNameKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const range = parseNameBoxReference(e.currentTarget.value, getNamedRanges?.());
        if (!range) {
          setNameInvalid(true);
          return;
        }
        setNameDraft(null);
        setNameInvalid(false);
        e.currentTarget.blur();
        onNavigate?.(range);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setNameDraft(null);
        setNameInvalid(false);
        e.currentTarget.blur();
      }
    }, [onNavigate, getNamedRanges]);

    return (
      // Fills the toolbar strip: the strip owns the background and bottom
      // border, this owns the row. Without `flex-1` the bar collapsed to its
      // content width and left most of the strip empty.
      <div className="csv-formula-bar flex flex-1 min-w-0 items-center gap-2 px-3 py-1 min-h-[32px]">
        <input
          type="text"
          aria-label="Name box"
          aria-invalid={nameInvalid || undefined}
          spellCheck={false}
          className={`csv-formula-bar-ref font-mono text-[12px] font-semibold w-[84px] px-2 py-0.5 bg-nim-tertiary rounded text-center text-nim-muted border outline-none focus:text-nim focus:border-[var(--nim-primary)] ${
            nameInvalid ? 'border-[var(--nim-error)]' : 'border-transparent'
          }`}
          value={nameDraft ?? (cellRef || '-')}
          readOnly={!onNavigate}
          onFocus={(e) => {
            setNameDraft(cellRef);
            e.target.select();
            nameJustFocusedRef.current = true;
          }}
          // The mouseup of the focusing click would collapse the selection to
          // a caret, and typing would then merge into the old reference.
          onMouseUp={(e) => {
            if (nameJustFocusedRef.current) e.preventDefault();
            nameJustFocusedRef.current = false;
          }}
          onChange={(e) => {
            setNameDraft(e.target.value);
            setNameInvalid(false);
          }}
          onBlur={() => {
            setNameDraft(null);
            setNameInvalid(false);
          }}
          onKeyDown={handleNameKeyDown}
        />
        <div className="font-mono text-[12px] italic text-[var(--nim-primary)] w-[16px] shrink-0">
          {isFormula ? 'fx' : ''}
        </div>
        <div
          className={`csv-formula-bar-field relative flex-1 min-w-0 rounded ${readOnly ? 'bg-nim-secondary' : 'bg-nim'}`}
        >
          {colored && (
            <div
              ref={mirrorRef}
              aria-hidden="true"
              className={`csv-formula-bar-mirror ${FIELD_METRICS} absolute inset-0 border-transparent overflow-hidden whitespace-pre pointer-events-none text-nim`}
            >
              <MirrorText text={localValue} />
            </div>
          )}
          <input
            ref={setInput}
            type="text"
            spellCheck={false}
            className={`${FORMULA_BAR_INPUT_CLASS} ${FIELD_METRICS} relative block w-full bg-transparent border-nim rounded text-nim outline-none focus:border-[var(--nim-primary)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--nim-primary)_20%,transparent)] disabled:text-nim-faint disabled:cursor-not-allowed placeholder:text-nim-faint ${
              readOnly ? 'cursor-default' : ''
            }`}
            // Only the glyphs go transparent; the caret and selection stay.
            style={colored ? { color: 'transparent', caretColor: 'var(--nim-text)' } : undefined}
            value={localValue}
            onChange={handleChange}
            onFocus={() => setFocused(true)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            onScroll={syncMirrorScroll}
            onSelect={syncMirrorScroll}
            // `readOnly` rather than `disabled`: the value still has to be
            // selectable and copyable while a diff is being reviewed.
            readOnly={readOnly}
            placeholder={cellRef ? (readOnly ? '' : 'Enter value') : 'Select a cell'}
            disabled={!cellRef}
          />
        </div>
        <FormulaAssistPopover
          anchor={snapshot ? input : null}
          autocomplete={assist.autocomplete}
          signatureHelp={assist.signatureHelp}
          onAccept={assist.accept}
          onDismiss={assist.dismiss}
        />
      </div>
    );
  }
);
