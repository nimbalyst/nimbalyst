import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

import type { InboxFilterId } from './inboxTypes';

interface EmptyCopy {
  icon: string;
  title: string;
  body: string;
  actionLabel?: string;
}

/**
 * Filter-specific empty states. A generic "nothing here" teaches nobody what
 * the filter means or how to get something into it, so each one explains its
 * own rule and offers the action that resolves it.
 */
const FILTER_EMPTY: Record<InboxFilterId, EmptyCopy> = {
  all: {
    icon: 'inbox',
    title: 'Your inbox is clear',
    body: 'Mentions, assignments, replies, and activity in conversations you follow land here.',
    actionLabel: 'Browse rooms',
  },
  mentions: {
    icon: 'alternate_email',
    title: 'No mentions',
    body: 'Someone has to @mention you — or an agent you own — for a delivery to arrive here.',
    actionLabel: 'Browse rooms',
  },
  assigned: {
    icon: 'assignment_ind',
    title: 'Nothing assigned to you',
    body: 'Tracker assignments and equivalent actionable deliveries collect here.',
    actionLabel: 'Open trackers',
  },
  unread: {
    icon: 'mark_email_read',
    title: 'Nothing unread',
    body: 'You are caught up on deliveries and on the conversations you follow.',
  },
  follows: {
    icon: 'visibility',
    title: 'You are not following anything',
    body: 'Posting in a conversation follows it automatically, or you can follow one explicitly.',
    actionLabel: 'Browse rooms',
  },
};

export function InboxEmptyState({
  filter,
  query,
  scopeActive,
  onClearFilters,
  onBrowse,
  children,
}: {
  filter: InboxFilterId;
  query: string;
  scopeActive: boolean;
  onClearFilters: () => void;
  onBrowse: () => void;
  /** Slot for the `Search all messages` escalation when a query is active. */
  children?: React.ReactNode;
}) {
  const copy = FILTER_EMPTY[filter];
  const narrowed = !!query || scopeActive || filter !== 'all';

  return (
    <div
      className="inbox-empty-state flex flex-col items-center gap-2 px-8 py-14 text-center"
      data-testid="inbox-empty-state"
      data-filter={filter}
      data-component="InboxEmptyState"
    >
      <span className="inbox-empty-icon flex size-11 items-center justify-center rounded-full bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-faint)]">
        <MaterialSymbol icon={query ? 'search_off' : copy.icon} size={22} />
      </span>
      <h3 className="m-0 text-[14px] font-semibold text-[var(--nim-text)]">
        {query ? 'No deliveries match your search' : copy.title}
      </h3>
      <p className="m-0 max-w-[420px] text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
        {query
          ? `Nothing in ${filter === 'all' ? 'your inbox' : `the ${filter} filter`} matches “${query}”.`
          : copy.body}
      </p>

      <div className="inbox-empty-actions mt-1 flex items-center gap-2">
        {narrowed && (
          <button
            type="button"
            className="inbox-empty-clear rounded-md border border-[var(--nim-border)] px-2.5 py-1 text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
            data-testid="inbox-empty-clear-filters"
            onClick={onClearFilters}
          >
            Clear filters
          </button>
        )}
        {!query && copy.actionLabel && (
          <button
            type="button"
            className="inbox-empty-browse rounded-md border border-[var(--nim-border)] px-2.5 py-1 text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
            data-testid="inbox-empty-browse"
            onClick={onBrowse}
          >
            {copy.actionLabel}
          </button>
        )}
      </div>

      {children && <div className="inbox-empty-escalation mt-3">{children}</div>}
    </div>
  );
}

/** No connection and no cached rows to fall back on. */
export function InboxOfflineWithoutCache() {
  return (
    <div
      className="inbox-offline-empty flex flex-col items-center gap-2 px-8 py-14 text-center"
      data-testid="inbox-offline-empty"
      data-component="InboxOfflineWithoutCache"
    >
      <span className="flex size-11 items-center justify-center rounded-full bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-faint)]">
        <MaterialSymbol icon="cloud_off" size={22} />
      </span>
      <h3 className="m-0 text-[14px] font-semibold text-[var(--nim-text)]">Inbox needs a connection</h3>
      <p className="m-0 max-w-[420px] text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
        There are no cached deliveries on this device yet. Unread indicators on your trackers and documents
        keep working offline in the project window.
      </p>
    </div>
  );
}
