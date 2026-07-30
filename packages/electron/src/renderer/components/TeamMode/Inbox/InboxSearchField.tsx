import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

/**
 * Inbox search.
 *
 * Matches as you type against the locally materialized rows, so it works
 * offline over the cache and needs no round trip. It composes with the active
 * filter rather than replacing it — the caller passes the filter label so the
 * placeholder says what the query is scoped to.
 */
export function InboxSearchField({
  value,
  filterLabel,
  disabled,
  inputRef,
  onChange,
}: {
  value: string;
  filterLabel: string;
  disabled: boolean;
  /** Held by the Inbox so Messages > Search Messages can put the caret here. */
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
}) {
  return (
    <div
      className={`inbox-search-field flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${
        disabled ? 'border-[var(--nim-border)] opacity-60' : 'border-[var(--nim-border)] focus-within:border-[var(--nim-border-focus)]'
      }`}
      data-component="InboxSearchField"
    >
      <MaterialSymbol icon="search" size={16} className="shrink-0 text-[var(--nim-text-faint)]" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        disabled={disabled}
        data-testid="inbox-search-input"
        aria-label={`Search ${filterLabel.toLowerCase()}`}
        placeholder={`Search ${filterLabel.toLowerCase()} by person, conversation, or text`}
        onChange={(event) => onChange(event.target.value)}
        className="inbox-search-input org-window-no-drag min-w-0 flex-1 select-text border-none bg-transparent text-[13px] text-[var(--nim-text)] outline-none placeholder:text-[var(--nim-text-faint)]"
      />
      {value && (
        <button
          type="button"
          className="inbox-search-clear org-window-no-drag shrink-0 rounded p-0.5 text-[var(--nim-text-faint)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
          data-testid="inbox-search-clear"
          aria-label="Clear search"
          onClick={() => onChange('')}
        >
          <MaterialSymbol icon="close" size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * Escalation out of the bounded local index and into federated source search
 * (room FTS, tracker, document). Previews are bounded by contract, so inbox
 * search finds the delivery — not every word of the source.
 */
export function InboxSearchEscalation({
  query,
  matchCount,
  onEscalate,
}: {
  query: string;
  matchCount: number;
  onEscalate: (query: string) => void;
}) {
  return (
    <div className="inbox-search-escalation flex flex-col items-start gap-1.5" data-testid="inbox-search-escalation">
      <p className="m-0 text-[12px] text-[var(--nim-text-faint)]">
        {matchCount === 0
          ? 'Inbox search only covers the bounded previews stored with each delivery.'
          : 'Only delivery previews are searched here — the full message bodies are not.'}
      </p>
      <button
        type="button"
        className="inbox-search-all flex items-center gap-1.5 rounded-md border border-[var(--nim-border)] px-2.5 py-1 text-[12px] text-[var(--nim-link)] hover:bg-[var(--nim-bg-hover)]"
        data-testid="inbox-search-all"
        onClick={() => onEscalate(query)}
      >
        <MaterialSymbol icon="travel_explore" size={14} /> Search all messages
      </button>
    </div>
  );
}
