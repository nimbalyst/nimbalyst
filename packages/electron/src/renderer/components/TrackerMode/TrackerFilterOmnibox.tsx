/**
 * TrackerFilterOmnibox - the one search box Tracker Mode uses everywhere.
 *
 * Greg's ask: "I want to share the text filter we use in the other view, but I
 * want to add typeahead menus to get the full power of the filter dropdown, all
 * from the keyboard input." So this box is not a second filter: it drives the
 * *same* `searchQuery` the toolbar search drove and writes into the *same*
 * persisted column-filter set the filter dropdown writes, and adds a typed
 * grammar (`trackerFilterTokens.ts`) on top so every field, operator, and value
 * in that dropdown is reachable without leaving the keyboard.
 *
 * It is mounted twice -- in the main toolbar and above the document-view list
 * pane -- differing only by `className` and `showPills`, so both surfaces behave
 * identically. `#tag` completion is part of the grammar because the toolbar box
 * it replaced had it; tags stay their own filter list (not clauses) so the
 * existing tag chips keep working.
 *
 * The input's text is `searchQuery` plus, when one is being composed, a trailing
 * filter token. Committing the token turns it into a pill and hands the clause
 * to the shared filter set; the search text it was appended to is untouched.
 */

import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import {
  isClauseComplete,
  OP_LABELS,
  UNARY_OPS,
  withFieldClauses,
  type TrackerFieldFilter,
  type TrackerFilterSet,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
import type { TrackerFilterField } from './TrackerViewHeaderControls';
import {
  buildTokenSuggestions,
  draftToClause,
  parseOmniboxInput,
  serializeClause,
  type TagTokenOption,
  type TokenSuggestion,
} from './trackerFilterTokens';

interface TrackerFilterOmniboxProps {
  /** The shared free-text query. Same state the toolbar search input drives. */
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  /** Filterable fields, with option counts, as built for the filter dropdown. */
  fields: TrackerFilterField[];
  /** The persisted per-type column filters. */
  filters: TrackerFilterSet | null;
  onFiltersChange: (filters: TrackerFilterSet) => void;
  /** Tags offered after `#`, with the active ones already removed. */
  tagOptions?: TagTokenOption[];
  /** Tags currently filtering the view. Their own list, not filter clauses. */
  tagFilter?: string[];
  onTagFilterChange?: (tags: string[]) => void;
  /**
   * Whether the box renders its own filter pills. The main toolbar has its own
   * horizontal pill row beside it, so it opts out -- one set of pills, not two.
   */
  showPills?: boolean;
  /** Layout for the surface this instance sits on (width, padding, borders). */
  className?: string;
  placeholder?: string;
}

function pillLabel(
  clause: TrackerFieldFilter,
  fields: TrackerFilterField[],
): { field: string; op: string; value: string } {
  const field = fields.find(candidate => candidate.id === clause.field);
  const values = (Array.isArray(clause.value) ? clause.value : [clause.value])
    .filter(value => value !== undefined && value !== null && value !== '')
    .map(value => {
      const text = String(value);
      return field?.options?.find(option => option.value === text)?.label ?? text;
    });
  return {
    field: field?.label ?? clause.field,
    op: OP_LABELS[clause.op],
    value: UNARY_OPS.has(clause.op)
      ? ''
      : clause.op === 'in-last' || clause.op === 'not-in-last'
        ? `${values.join(', ')} days`
        : values.join(', '),
  };
}

export function TrackerFilterOmnibox({
  searchQuery,
  onSearchQueryChange,
  fields,
  filters,
  onFiltersChange,
  tagOptions,
  tagFilter,
  onTagFilterChange,
  showPills = true,
  className = '',
  placeholder = 'Search, # for tags, or a field name to filter…',
}: TrackerFilterOmniboxProps): JSX.Element {
  // The token under composition. Everything before it is `searchQuery`, so the
  // two together are exactly what the input shows.
  const [draftToken, setDraftToken] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const menu = useFloatingMenu({
    placement: 'bottom-start',
    open: menuOpen,
    onOpenChange: setMenuOpen,
  });
  const setInputNode = useCallback((node: HTMLInputElement | null) => {
    inputRef.current = node;
    menu.refs.setReference(node);
  }, [menu.refs]);

  const inputValue = searchQuery + draftToken;
  const parsed = useMemo(() => parseOmniboxInput(inputValue, fields), [inputValue, fields]);
  const suggestions = useMemo(
    () => (menuOpen ? buildTokenSuggestions(parsed.draft, fields, { tagOptions }) : []),
    [menuOpen, parsed.draft, fields, tagOptions],
  );
  const activeTags = tagFilter ?? [];

  const activeClauses = useMemo(
    () => (filters?.clauses ?? [])
      .map((clause, index) => ({ clause, index }))
      .filter(({ clause }) => isClauseComplete(clause)),
    [filters],
  );

  // Keep the highlight inside the list as it shrinks under the user's typing.
  useLayoutEffect(() => {
    setHighlightIndex(current => {
      if (current === null) return null;
      if (suggestions.length === 0) return null;
      return Math.min(current, suggestions.length - 1);
    });
  }, [suggestions.length]);

  const applyInput = useCallback((value: string, autoHighlight: boolean) => {
    const next = parseOmniboxInput(value, fields);
    const isToken = next.draft.stage !== 'field';
    setDraftToken(isToken ? next.draft.raw : '');
    onSearchQueryChange(isToken ? next.searchText : value);
    setMenuOpen(true);
    // A colon means the user asked for the filter language, so the first row is
    // pre-selected and Enter commits it. A bare word is still plain search text,
    // so nothing is selected until they press Down or Tab -- otherwise Enter
    // would hijack ordinary typing.
    setHighlightIndex(autoHighlight && isToken ? 0 : null);
  }, [fields, onSearchQueryChange]);

  /**
   * The search text once the draft token is taken out of the input.
   *
   * A field-stage word is still part of the search text while it is being
   * typed, so accepting a suggestion has to reclaim it -- otherwise "auth stat"
   * plus the Status suggestion would leave "auth stat" behind in the query.
   */
  const searchTextWithoutToken = inputValue.slice(0, parsed.tokenStart);

  const commitClause = useCallback((clause: TrackerFieldFilter) => {
    // Replace rather than append this field's clauses, matching the filter
    // dropdown -- two clauses on one field read as an unsatisfiable AND.
    onFiltersChange(withFieldClauses(filters, clause.field, [clause]));
    onSearchQueryChange(searchTextWithoutToken);
    setDraftToken('');
    setMenuOpen(false);
    setHighlightIndex(null);
    inputRef.current?.focus();
  }, [filters, onFiltersChange, onSearchQueryChange, searchTextWithoutToken]);

  const addTag = useCallback((tag: string) => {
    if (!activeTags.includes(tag)) onTagFilterChange?.([...activeTags, tag]);
    onSearchQueryChange(searchTextWithoutToken);
    setDraftToken('');
    setMenuOpen(false);
    setHighlightIndex(null);
    inputRef.current?.focus();
  }, [activeTags, onSearchQueryChange, onTagFilterChange, searchTextWithoutToken]);

  const removeTag = useCallback((tag: string) => {
    onTagFilterChange?.(activeTags.filter(candidate => candidate !== tag));
  }, [activeTags, onTagFilterChange]);

  const applySuggestion = useCallback((suggestion: TokenSuggestion) => {
    if (suggestion.tag) {
      addTag(suggestion.tag);
      return;
    }
    if (suggestion.clause) {
      commitClause(suggestion.clause);
      return;
    }
    if (suggestion.insertText !== undefined) {
      onSearchQueryChange(searchTextWithoutToken);
      setDraftToken(suggestion.insertText);
      setMenuOpen(true);
      setHighlightIndex(0);
      inputRef.current?.focus();
    }
  }, [addTag, commitClause, onSearchQueryChange, searchTextWithoutToken]);

  const removeClause = useCallback((index: number) => {
    onFiltersChange({
      combinator: filters?.combinator ?? 'and',
      clauses: (filters?.clauses ?? []).filter((_, position) => position !== index),
    });
  }, [filters, onFiltersChange]);

  /** Pull a pill back into the input so it can be retyped instead of rebuilt. */
  const editClause = useCallback((clause: TrackerFieldFilter, index: number) => {
    removeClause(index);
    setDraftToken(serializeClause(clause, fields));
    setMenuOpen(true);
    setHighlightIndex(0);
    inputRef.current?.focus();
  }, [fields, removeClause]);

  const clearAll = useCallback(() => {
    setDraftToken('');
    onSearchQueryChange('');
    onFiltersChange({ combinator: filters?.combinator ?? 'and', clauses: [] });
    if (activeTags.length > 0) onTagFilterChange?.([]);
    setMenuOpen(false);
    setHighlightIndex(null);
  }, [activeTags.length, filters?.combinator, onFiltersChange, onSearchQueryChange, onTagFilterChange]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      if (suggestions.length === 0 && !menuOpen) setMenuOpen(true);
      event.preventDefault();
      setHighlightIndex(current => (current === null
        ? 0
        : Math.min(current + 1, Math.max(suggestions.length - 1, 0))));
      return;
    }
    if (event.key === 'ArrowUp') {
      if (highlightIndex === null) return;
      event.preventDefault();
      setHighlightIndex(current => (current === null || current === 0 ? null : current - 1));
      return;
    }
    if (event.key === 'Tab') {
      const target = suggestions[highlightIndex ?? 0];
      if (!target) return;
      event.preventDefault();
      applySuggestion(target);
      return;
    }
    if (event.key === 'Enter') {
      const target = highlightIndex === null ? null : suggestions[highlightIndex];
      if (target) {
        event.preventDefault();
        applySuggestion(target);
        return;
      }
      // No row selected: a fully typed token still commits, so someone who knows
      // the grammar never has to look at the menu.
      const clause = draftToClause(parsed.draft);
      if (clause) {
        event.preventDefault();
        commitClause(clause);
      }
      return;
    }
    if (event.key === 'Escape') {
      if (menuOpen) {
        event.preventDefault();
        event.stopPropagation();
        setMenuOpen(false);
        setHighlightIndex(null);
        return;
      }
      if (draftToken) {
        event.preventDefault();
        event.stopPropagation();
        setDraftToken('');
      }
      return;
    }
    if (event.key === 'Backspace' && inputValue === '') {
      // Tags first: that is what Backspace did in the box this replaced, and
      // someone who has just typed `#ui` expects it back.
      if (activeTags.length > 0) {
        event.preventDefault();
        removeTag(activeTags[activeTags.length - 1]);
        return;
      }
      if (activeClauses.length > 0) {
        event.preventDefault();
        removeClause(activeClauses[activeClauses.length - 1].index);
      }
    }
  }, [
    activeClauses,
    activeTags,
    applySuggestion,
    commitClause,
    draftToken,
    highlightIndex,
    inputValue,
    menuOpen,
    parsed.draft,
    removeClause,
    removeTag,
    suggestions,
  ]);

  const hasAnything = inputValue.length > 0 || activeClauses.length > 0 || activeTags.length > 0;

  return (
    <div
      className={`tracker-filter-omnibox flex min-w-0 flex-col gap-1 ${className}`}
      data-testid="tracker-filter-omnibox"
    >
      <div className="relative flex-1 min-w-0">
        <MaterialSymbol
          icon="search"
          size={14}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-nim-faint pointer-events-none"
        />
        <input
          ref={setInputNode}
          type="text"
          role="combobox"
          aria-expanded={menuOpen && suggestions.length > 0}
          aria-controls="tracker-filter-omnibox-menu"
          aria-label="Search or filter tracker items"
          className="tracker-filter-omnibox-input w-full rounded border border-nim bg-nim-secondary py-1 pl-7 pr-6 text-xs text-nim placeholder:text-nim-faint focus:border-[var(--nim-primary)] focus:outline-none"
          placeholder={placeholder}
          value={inputValue}
          onChange={event => applyInput(event.target.value, true)}
          onFocus={() => setMenuOpen(true)}
          onKeyDown={handleKeyDown}
          data-testid="tracker-filter-omnibox-input"
        />
        {hasAnything && (
          <button
            type="button"
            className="absolute right-1 top-1/2 -translate-y-1/2 text-nim-faint hover:text-nim"
            onClick={clearAll}
            aria-label="Clear search and filters"
            data-testid="tracker-filter-omnibox-clear"
          >
            <MaterialSymbol icon="close" size={13} />
          </button>
        )}
      </div>

      {showPills && (activeClauses.length > 0 || activeTags.length > 0) && (
        <div
          className="tracker-filter-omnibox-pills flex flex-wrap items-center gap-1"
          data-testid="tracker-filter-omnibox-pills"
        >
          {activeTags.map(tag => (
            <button
              key={`tag-${tag}`}
              type="button"
              className="tracker-filter-omnibox-tag-chip flex h-5 shrink-0 items-center gap-1 rounded-full border border-blue-400/30 bg-blue-400/[0.12] px-1.5 text-[10px] text-blue-400 hover:bg-blue-400/[0.18]"
              onClick={() => removeTag(tag)}
              title={`Remove #${tag} filter`}
              data-testid={`tracker-filter-omnibox-tag-chip-${tag}`}
            >
              #{tag}
              <MaterialSymbol icon="close" size={10} />
            </button>
          ))}
          {activeClauses.map(({ clause, index }) => {
            const parts = pillLabel(clause, fields);
            return (
              <div
                key={`${clause.field}-${index}`}
                className="tracker-filter-omnibox-pill flex h-5 max-w-full items-center overflow-hidden rounded-full border border-nim bg-nim-secondary text-[10px] text-nim-muted"
                data-testid={`tracker-filter-omnibox-pill-${index}`}
              >
                <button
                  type="button"
                  className="flex h-full min-w-0 items-center gap-1 px-1.5 hover:bg-nim-tertiary hover:text-nim"
                  onClick={() => editClause(clause, index)}
                  title={`Edit ${serializeClause(clause, fields)}`}
                >
                  <span className="shrink-0 font-medium text-nim">{parts.field}</span>
                  <span className="shrink-0 text-nim-faint">{parts.op}</span>
                  {parts.value && <span className="truncate">{parts.value}</span>}
                </button>
                <button
                  type="button"
                  className="inline-flex h-full w-4 shrink-0 items-center justify-center border-l border-nim text-nim-faint hover:bg-nim-tertiary hover:text-nim"
                  onClick={() => removeClause(index)}
                  aria-label={`Remove ${parts.field} filter`}
                >
                  <MaterialSymbol icon="close" size={10} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {menuOpen && suggestions.length > 0 && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            id="tracker-filter-omnibox-menu"
            className="tracker-filter-omnibox-menu z-[100] overflow-y-auto rounded border border-nim bg-nim-secondary shadow-lg"
            style={{
              ...menu.floatingStyles,
              width: Math.max(inputRef.current?.offsetWidth ?? 240, 240),
            }}
            data-testid="tracker-filter-omnibox-menu"
            {...menu.getFloatingProps()}
          >
            {suggestions.map((suggestion, index) => {
              const previous = suggestions[index - 1];
              return (
                <div key={suggestion.id}>
                  {suggestion.section !== previous?.section && (
                    <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-nim-faint">
                      {suggestion.section}
                    </div>
                  )}
                  <button
                    type="button"
                    className={`flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] transition-colors ${
                      index === highlightIndex
                        ? 'bg-[var(--nim-bg-tertiary)] text-nim'
                        : 'text-nim-muted hover:bg-[var(--nim-bg-tertiary)]'
                    }`}
                    // mousedown so the click lands before the input blurs.
                    onMouseDown={event => {
                      event.preventDefault();
                      applySuggestion(suggestion);
                    }}
                    onMouseEnter={() => setHighlightIndex(index)}
                    data-testid={`tracker-filter-omnibox-option-${suggestion.id}`}
                    data-selected={index === highlightIndex ? 'true' : undefined}
                  >
                    <span className="min-w-0 flex-1 truncate">{suggestion.label}</span>
                    {suggestion.detail && (
                      <span className="shrink-0 text-[10px] text-nim-faint">{suggestion.detail}</span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
