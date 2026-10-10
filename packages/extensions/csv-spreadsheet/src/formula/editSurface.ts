/**
 * The two places a formula is typed -- the formula bar input and the in-cell
 * editor textarea -- seen through one shape, so point mode, F4 and
 * autocomplete write to both the same way.
 *
 * Writes go through the element's native `value` setter and a bubbling `input`
 * event. React's controlled formula bar picks that up as an ordinary change;
 * the in-cell editor reads the DOM value when it commits (and re-renders with
 * the live value, see `SheetsTextEditor.render`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FunctionCatalogEntry } from './functionCatalog';
import {
  applyAutocomplete,
  cycleReferenceAbsolute,
  getFormulaAutocomplete,
  getSignatureHelp,
  isNamedRangeEntry,
  type FormulaAutocomplete,
  type SignatureHelp,
  type TextEdit,
} from './formulaAssist';

export type FormulaEditElement = HTMLInputElement | HTMLTextAreaElement;

/** Marks the formula bar input; the in-cell editor is `textarea.csv-cell-editor`. */
export const FORMULA_BAR_INPUT_CLASS = 'csv-formula-bar-input';
export const CELL_EDITOR_SELECTOR = 'textarea.csv-cell-editor';

export function isFormulaEditElement(element: Element | null): element is FormulaEditElement {
  if (element instanceof HTMLInputElement) return element.classList.contains(FORMULA_BAR_INPUT_CLASS);
  return element instanceof HTMLTextAreaElement && element.matches(CELL_EDITOR_SELECTOR);
}

export function writeEditText(element: FormulaEditElement, edit: TextEdit): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, edit.text);
  element.setSelectionRange(edit.caret, edit.caret);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

/** F4 on a surface; true when it cycled a reference. */
export function cycleAbsoluteIn(element: FormulaEditElement): boolean {
  const edit = cycleReferenceAbsolute(element.value, element.selectionStart ?? element.value.length);
  if (!edit) return false;
  writeEditText(element, edit);
  return true;
}

export interface EditSnapshot {
  text: string;
  caret: number;
}

export function snapshotOf(element: FormulaEditElement): EditSnapshot {
  return { text: element.value, caret: element.selectionStart ?? element.value.length };
}

/**
 * Track a surface's text and caret. Caret-only moves (arrows, clicks) have no
 * `input` event, so `selectionchange` is filtered to this element.
 */
export function useEditSnapshot(element: FormulaEditElement | null): EditSnapshot | null {
  const [snapshot, setSnapshot] = useState<EditSnapshot | null>(null);
  useEffect(() => {
    if (!element) {
      setSnapshot(null);
      return;
    }
    const read = () => {
      const next = snapshotOf(element);
      setSnapshot((previous) => (previous?.text === next.text && previous.caret === next.caret ? previous : next));
    };
    // Listen on `document` in the bubble phase, i.e. after React's root
    // listener. A state update set from a listener on the element itself is
    // flushed when React starts handling the same `input` event, and that
    // commit puts the formula bar's old controlled value back before its
    // `onChange` runs -- the keystroke is silently lost.
    const onEvent = (event: Event) => {
      if (event.target === element) read();
    };
    const onSelectionChange = () => {
      if (document.activeElement === element) read();
    };
    read();
    for (const type of ['input', 'keyup', 'mouseup']) document.addEventListener(type, onEvent);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      for (const type of ['input', 'keyup', 'mouseup']) document.removeEventListener(type, onEvent);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [element]);
  return snapshot;
}

export interface FormulaAssistState {
  autocomplete: FormulaAutocomplete | null;
  signatureHelp: SignatureHelp | null;
  accept: (entry: FunctionCatalogEntry) => void;
  /** Escape: hide until the text or caret moves. */
  dismiss: () => void;
}

/** Autocomplete and signature help for a surface, ready for `FormulaAssistPopover`. */
export function useFormulaAssist(
  element: FormulaEditElement | null,
  snapshot: EditSnapshot | null,
  /** Read when the snapshot changes, so a name defined mid-edit shows up on the next keystroke. */
  getNamedRanges?: () => Readonly<Record<string, string>>,
): FormulaAssistState {
  const [dismissedAt, setDismissedAt] = useState<EditSnapshot | null>(null);
  const dismissed = !!snapshot && dismissedAt?.text === snapshot.text && dismissedAt.caret === snapshot.caret;

  const { autocomplete, signatureHelp } = useMemo(() => {
    if (!snapshot || dismissed) return { autocomplete: null, signatureHelp: null };
    return {
      autocomplete: getFormulaAutocomplete(snapshot.text, snapshot.caret, undefined, getNamedRanges?.()),
      signatureHelp: getSignatureHelp(snapshot.text, snapshot.caret),
    };
  }, [snapshot, dismissed, getNamedRanges]);

  const accept = useCallback((entry: FunctionCatalogEntry) => {
    if (!element || !autocomplete) return;
    writeEditText(element, applyAutocomplete(element.value, autocomplete, entry.name, !isNamedRangeEntry(entry)));
  }, [element, autocomplete]);

  const dismiss = useCallback(() => setDismissedAt(snapshot), [snapshot]);

  return { autocomplete, signatureHelp, accept, dismiss };
}
