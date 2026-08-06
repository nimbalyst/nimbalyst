/**
 * Find / find-and-replace bar.
 *
 * Visual language follows the host's Lexical search bar: a fixed strip under
 * the formula bar rather than a floating overlay, same input/button styles,
 * same "3 of 17" / "No results" counter states.
 */

import { useEffect, useRef } from 'react';
import type { SpreadsheetFind } from '../hooks/useSpreadsheetFind';
import { shouldIsolateFromGrid } from '../editors/editorKeyActions';

const INPUT_CLASS =
  'w-full px-2.5 py-1.5 text-[13px] border border-nim rounded bg-nim text-nim outline-none transition-colors duration-150 focus:border-[var(--nim-primary)] placeholder:text-nim-faint';
const NAV_BUTTON_CLASS =
  'bg-transparent border border-nim rounded w-6 h-6 flex items-center justify-center cursor-pointer text-nim p-0 transition-colors duration-150 hover:enabled:bg-nim-hover disabled:opacity-40 disabled:cursor-not-allowed';
const ACTION_BUTTON_CLASS =
  'px-2 py-1 text-[12px] whitespace-nowrap bg-transparent border border-nim rounded cursor-pointer text-nim-muted transition-colors duration-150 hover:enabled:bg-nim-hover hover:enabled:text-nim disabled:opacity-40 disabled:cursor-not-allowed';

function toggleClass(active: boolean): string {
  return `${ACTION_BUTTON_CLASS} ${active ? 'bg-[var(--nim-primary)] border-[var(--nim-primary)] text-white' : ''}`;
}

const CHEVRON_PATHS = {
  up: 'M3 7.5L6 4.5L9 7.5',
  down: 'M3 4.5L6 7.5L9 4.5',
  right: 'M4.5 3L7.5 6L4.5 9',
} as const;

function Chevron({ direction }: { direction: keyof typeof CHEVRON_PATHS }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d={CHEVRON_PATHS[direction]}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function counterText(count: number, index: number, query: string): string {
  if (count > 0) return `${index + 1} of ${count}`;
  return query ? 'No results' : '';
}

/**
 * `readOnly` keeps find (navigation only) and drops replace. Used during diff
 * review, where any write would land against phantom-row-shifted indices.
 */
export function FindBar({ find, readOnly = false }: { find: SpreadsheetFind; readOnly?: boolean }) {
  const queryInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    queryInputRef.current?.select();
  }, [find.showReplace]);

  /** Escape closes from either input; Enter steps, matching the host's bar. */
  const handleKeyDown = (event: React.KeyboardEvent) => {
    // Typing a query is not grid input -- see `shouldIsolateFromGrid`. Without
    // this, Backspace in the find field clears the selected cells.
    if (shouldIsolateFromGrid(event)) event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      find.close();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      find.step(event.shiftKey ? 'previous' : 'next');
    }
  };

  const noMatches = find.cursor.count === 0;

  return (
    <div className="csv-find-bar flex flex-col gap-2 px-3 py-2 bg-nim-secondary border-b border-nim">
      <div className="csv-find-bar-row flex items-center gap-2">
        {/* Leading chevron expands the replace row, so the only button reading
            "Replace" is the one that actually replaces. Read-only keeps the
            slot so the find input stays aligned with the formula bar above. */}
        {readOnly ? (
          <span className={`${NAV_BUTTON_CLASS} invisible`} aria-hidden="true" />
        ) : (
          <button
            className={NAV_BUTTON_CLASS}
            onClick={find.toggleReplace}
            aria-label="Toggle replace"
            aria-expanded={find.showReplace}
            title="Toggle replace"
          >
            <Chevron direction={find.showReplace ? 'down' : 'right'} />
          </button>
        )}
        <input
          ref={queryInputRef}
          className={INPUT_CLASS}
          value={find.query}
          onChange={(event) => find.setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Find in sheet"
          aria-label="Find"
          autoFocus
        />
        <span className="csv-find-count text-[13px] text-nim-muted min-w-20 text-center select-none">
          {counterText(find.cursor.count, find.cursor.index, find.query)}
        </span>
        <button
          className={NAV_BUTTON_CLASS}
          onClick={() => find.step('previous')}
          disabled={noMatches}
          aria-label="Previous match"
          title="Previous match (Shift+Enter)"
        >
          <Chevron direction="up" />
        </button>
        <button
          className={NAV_BUTTON_CLASS}
          onClick={() => find.step('next')}
          disabled={noMatches}
          aria-label="Next match"
          title="Next match (Enter)"
        >
          <Chevron direction="down" />
        </button>
        <button
          className={toggleClass(find.caseSensitive)}
          onClick={() => find.setCaseSensitive(!find.caseSensitive)}
          title="Match case"
        >
          Aa
        </button>
        <button
          className={toggleClass(find.wholeCell)}
          onClick={() => find.setWholeCell(!find.wholeCell)}
          title="Match entire cell"
        >
          Cell
        </button>
        <button className={ACTION_BUTTON_CLASS} onClick={find.close} title="Close (Esc)" aria-label="Close find">
          &#10005;
        </button>
      </div>

      {find.showReplace && !readOnly && (
        <div className="csv-find-bar-row csv-find-replace-row flex items-center gap-2">
          {/* Keeps the replace input aligned under the find input. */}
          <span className={`${NAV_BUTTON_CLASS} invisible`} aria-hidden="true" />
          <input
            className={INPUT_CLASS}
            value={find.replacement}
            onChange={(event) => find.setReplacement(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Replace with"
            aria-label="Replace with"
          />
          <button className={ACTION_BUTTON_CLASS} onClick={find.replaceCurrent} disabled={noMatches}>
            Replace
          </button>
          <button className={ACTION_BUTTON_CLASS} onClick={() => find.replaceAll('sheet')} disabled={noMatches}>
            Replace all
          </button>
          <button
            className={`csv-find-replace-selection ${ACTION_BUTTON_CLASS}`}
            onClick={() => find.replaceAll('selection')}
            disabled={noMatches || !find.hasSelection}
            title="Replace every match inside the selected range"
          >
            In selection
          </button>
        </div>
      )}
    </div>
  );
}
