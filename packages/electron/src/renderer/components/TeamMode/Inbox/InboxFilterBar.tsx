import React from 'react';

import { INBOX_FILTERS } from './inboxViewModel';
import { InboxScopeMenu } from './InboxScopeMenu';
import type { InboxFilterId, InboxScope, InboxScopeOptions } from './inboxTypes';

/**
 * Filter chips plus the scope control.
 *
 * Counts are unread-within-filter, taken from the same normalized rows the list
 * renders (inside the active scope, independent of the search query — search
 * refines a filter, it does not change how much is waiting in it).
 */
export function InboxFilterBar({
  filter,
  counts,
  scope,
  scopeOptions,
  disabled,
  onFilterChange,
  onScopeChange,
}: {
  filter: InboxFilterId;
  counts: Record<InboxFilterId, number>;
  scope: InboxScope;
  scopeOptions: InboxScopeOptions;
  disabled: boolean;
  onFilterChange: (filter: InboxFilterId) => void;
  onScopeChange: (scope: InboxScope) => void;
}) {
  return (
    <div
      className="inbox-filter-bar flex flex-wrap items-center gap-2"
      data-testid="inbox-filter-bar"
      data-component="InboxFilterBar"
      role="tablist"
      aria-label="Inbox filters"
    >
      {INBOX_FILTERS.map(({ id, label }) => {
        const isActive = filter === id;
        const count = counts[id] ?? 0;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            disabled={disabled}
            aria-selected={isActive}
            data-testid={`inbox-filter-${id}`}
            onClick={() => onFilterChange(id)}
            className={`inbox-filter-chip org-window-no-drag flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] ${
              disabled
                ? 'cursor-not-allowed bg-transparent text-[var(--nim-text-disabled)]'
                : isActive
                  ? 'bg-[var(--nim-primary)] font-medium text-[var(--nim-on-primary)]'
                  : 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]'
            }`}
          >
            {label}
            {count > 0 && (
              <span
                className={`inbox-filter-count rounded-full px-1.5 text-[10px] font-semibold leading-4 ${
                  isActive
                    ? 'bg-[color-mix(in_srgb,var(--nim-on-primary)_25%,transparent)] text-[var(--nim-on-primary)]'
                    : 'bg-[var(--nim-bg-active)] text-[var(--nim-text-muted)]'
                }`}
                data-testid={`inbox-filter-count-${id}`}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}

      <div className="inbox-filter-bar-spacer ml-auto" />
      <InboxScopeMenu scope={scope} options={scopeOptions} disabled={disabled} onChange={onScopeChange} />
    </div>
  );
}
