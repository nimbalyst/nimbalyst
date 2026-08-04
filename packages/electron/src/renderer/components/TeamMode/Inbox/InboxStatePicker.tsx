import React from 'react';

import type { InboxStatus } from './inboxTypes';

/**
 * Fixture-only control that makes every list-level client state reachable for
 * design review without a server. It renders only when the active provider
 * exposes `simulateStatus`, so it disappears the moment the atom-backed
 * provider is wired in.
 */
const STATES: Array<{ id: InboxStatus; label: string }> = [
  { id: 'loading', label: 'Loading' },
  { id: 'ready', label: 'Ready' },
  { id: 'offlineWithCache', label: 'Offline (cached)' },
  { id: 'offlineWithoutCache', label: 'Offline (no cache)' },
  { id: 'reconnecting', label: 'Reconnecting' },
];

export function InboxStatePicker({
  status,
  onChange,
}: {
  status: InboxStatus;
  onChange: (status: InboxStatus) => void;
}) {
  return (
    <div
      className="inbox-state-picker flex shrink-0 items-center gap-1.5 border-t border-dashed border-[var(--nim-border)] px-5 py-2"
      data-testid="inbox-state-picker"
      data-component="InboxStatePicker"
    >
      <span className="text-[11px] uppercase tracking-wide text-[var(--nim-text-faint)]">Preview state</span>
      {STATES.map((state) => (
        <button
          key={state.id}
          type="button"
          data-testid={`inbox-state-${state.id}`}
          onClick={() => onChange(state.id)}
          className={`inbox-state-option rounded px-2 py-0.5 text-[11px] ${
            status === state.id
              ? 'bg-[var(--nim-bg-active)] font-medium text-[var(--nim-text)]'
              : 'bg-transparent text-[var(--nim-text-faint)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]'
          }`}
        >
          {state.label}
        </button>
      ))}
    </div>
  );
}
