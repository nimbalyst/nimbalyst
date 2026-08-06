/**
 * Find / find-and-replace state for the spreadsheet.
 *
 * All the searching and replacing lives in `src/filter/` -- this hook only owns
 * the bar's state and re-runs those engines when it changes. It reads the grid's
 * rows on demand rather than mirroring them, so a search always reflects the
 * live sheet (including the rows an active filter has hidden, which
 * `findMatches` skips because the mapping tells it to).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CellReplacement, FindCursor, FindMatch, NormalizedSelectionRange } from '../types';
import {
  createFindCursor,
  findMatches,
  moveFindCursor,
  replaceAll as computeReplaceAll,
  replacementForMatch,
  type FindOptions,
  type SearchRow,
} from '../filter/findReplace';
import type { RowIndexMapping } from '../filter/rowIndexMapping';
import { buildFindHighlight, EMPTY_FIND_HIGHLIGHT, type FindHighlight } from '../filter/findHighlight';

/** Everything the find engines need, read fresh from the live grid. */
export interface FindContext {
  /** Row models indexed by logical row, header rows first. */
  rows: readonly SearchRow[];
  columnCount: number;
  mapping: RowIndexMapping;
}

export interface UseSpreadsheetFindOptions {
  readContext: () => Promise<FindContext | null>;
  getSelection: () => NormalizedSelectionRange | null;
  /**
   * Whether the sheet currently has a multi-cell range. Passed in rather than
   * derived from `getSelection`, because the selection lives in a ref that the
   * editor mutates without re-rendering -- a value derived here would go stale
   * the moment the user selects a range with the bar already open.
   */
  hasSelection: boolean;
  applyReplacements: (replacements: readonly CellReplacement[]) => Promise<void>;
  /** Select and scroll to a match. */
  reveal: (match: FindMatch) => void;
  /** Hand the grid the cells to paint; called with an empty map when closing. */
  setHighlight: (highlight: FindHighlight) => void;
}

export interface SpreadsheetFind {
  isOpen: boolean;
  showReplace: boolean;
  query: string;
  replacement: string;
  caseSensitive: boolean;
  wholeCell: boolean;
  cursor: FindCursor;
  /** True when the sheet has a range of more than one cell to scope replace-all to. */
  hasSelection: boolean;
  open: (withReplace?: boolean) => void;
  toggleReplace: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  setReplacement: (replacement: string) => void;
  setCaseSensitive: (caseSensitive: boolean) => void;
  setWholeCell: (wholeCell: boolean) => void;
  step: (direction: 'next' | 'previous') => void;
  replaceCurrent: () => void;
  replaceAll: (scope: 'sheet' | 'selection') => void;
}

export function useSpreadsheetFind({
  readContext,
  getSelection,
  hasSelection,
  applyReplacements,
  reveal,
  setHighlight,
}: UseSpreadsheetFindOptions): SpreadsheetFind {
  const [isOpen, setIsOpen] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeCell, setWholeCell] = useState(false);
  const [matches, setMatches] = useState<readonly FindMatch[]>([]);
  const [cursor, setCursor] = useState<FindCursor>(createFindCursor([]));

  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const searchOptions = useCallback(
    (mapping: RowIndexMapping, selection?: NormalizedSelectionRange): FindOptions => ({
      mapping,
      caseSensitive,
      wholeCell,
      ...(selection ? { selection } : {}),
    }),
    [caseSensitive, wholeCell],
  );

  /**
   * Monotonic search generation. `readContext` is async, so a search started
   * earlier can resolve later; without this an older result set would overwrite
   * a newer one and leave the bar's stored offsets describing text that is no
   * longer on the sheet.
   */
  const searchGenerationRef = useRef(0);

  /**
   * Re-run the search and republish the highlight. `keepIndex` holds the cursor
   * where it was, which is what a replace wants -- a fresh query wants 0.
   */
  const refresh = useCallback(
    async (keepIndex = false) => {
      const generation = ++searchGenerationRef.current;
      const context = await readContext();
      if (!context || generation !== searchGenerationRef.current) return;

      const found = query === '' ? [] : findMatches(context.rows, context.columnCount, query, searchOptions(context.mapping));
      const next = createFindCursor(found, keepIndex ? cursorRef.current.index : 0);
      setMatches(found);
      setCursor(next);
      setHighlight(buildFindHighlight(context.rows, found, next.index));
      return next;
    },
    [readContext, query, searchOptions, setHighlight],
  );

  useEffect(() => {
    if (!isOpen) return;
    void refresh();
  }, [isOpen, refresh]);

  const open = useCallback((withReplace = false) => {
    setShowReplace((current) => current || withReplace);
    setIsOpen(true);
  }, []);

  const toggleReplace = useCallback(() => setShowReplace((current) => !current), []);

  const close = useCallback(() => {
    setIsOpen(false);
    setShowReplace(false);
    setMatches([]);
    setCursor(createFindCursor([]));
    setHighlight(EMPTY_FIND_HIGHLIGHT);
  }, [setHighlight]);

  const moveTo = useCallback(
    (next: FindCursor, found: readonly FindMatch[], rows: readonly SearchRow[]) => {
      setCursor(next);
      setHighlight(buildFindHighlight(rows, found, next.index));
      if (next.match) reveal(next.match);
    },
    [setHighlight, reveal],
  );

  const step = useCallback(
    (direction: 'next' | 'previous') => {
      void (async () => {
        const context = await readContext();
        if (!context) return;
        const found = matchesRef.current;
        if (found.length === 0) return;
        moveTo(moveFindCursor(found, cursorRef.current.index, direction), found, context.rows);
      })();
    },
    [readContext, moveTo],
  );

  const replaceCurrent = useCallback(() => {
    void (async () => {
      const context = await readContext();
      const match = cursorRef.current.match;
      if (!context || !match) return;
      // `null` means the cell changed under the stored match, so there is
      // nothing safe to write -- re-search and leave the sheet alone.
      const write = replacementForMatch(context.rows, match, replacement, { caseSensitive, wholeCell });
      if (write) await applyReplacements([write]);
      await refresh(true);
    })();
  }, [readContext, applyReplacements, replacement, refresh, caseSensitive, wholeCell]);

  const replaceAll = useCallback(
    (scope: 'sheet' | 'selection') => {
      void (async () => {
        const context = await readContext();
        if (!context || query === '') return;
        const selection = scope === 'selection' ? getSelection() ?? undefined : undefined;
        if (scope === 'selection' && !selection) return;
        const { matches: found, replacements } = computeReplaceAll(
          context.rows,
          context.columnCount,
          query,
          replacement,
          searchOptions(context.mapping, selection),
        );
        if (found.length === 0) return;
        await applyReplacements(replacements);
        await refresh();
      })();
    },
    [readContext, query, getSelection, searchOptions, applyReplacements, replacement, refresh],
  );

  return {
    isOpen,
    showReplace,
    query,
    replacement,
    caseSensitive,
    wholeCell,
    cursor,
    hasSelection,
    open,
    toggleReplace,
    close,
    setQuery,
    setReplacement,
    setCaseSensitive,
    setWholeCell,
    step,
    replaceCurrent,
    replaceAll,
  };
}
