import React from 'react';

/**
 * Initial-loading skeleton, shown until the first personal-index page arrives.
 * The filter bar and search field stay mounted but disabled, so the surface
 * does not reflow when the rows land.
 */
export function InboxSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="inbox-skeleton" data-testid="inbox-skeleton" data-component="InboxSkeleton" aria-busy="true" aria-label="Loading inbox">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="inbox-skeleton-row flex items-start gap-3 border-b border-[var(--nim-border)] px-4 py-3 last:border-b-0">
          <span className="mt-2 size-2 shrink-0 rounded-full bg-[var(--nim-bg-active)]" />
          <span className="mt-0.5 size-7 shrink-0 animate-pulse rounded-md bg-[var(--nim-bg-tertiary)]" />
          <div className="min-w-0 flex-1">
            <span className="block h-2.5 w-24 animate-pulse rounded bg-[var(--nim-bg-tertiary)]" />
            <span className="mt-2 block h-3 w-1/2 animate-pulse rounded bg-[var(--nim-bg-tertiary)]" />
            <span className="mt-2 block h-2.5 w-4/5 animate-pulse rounded bg-[var(--nim-bg-tertiary)]" />
          </div>
        </div>
      ))}
    </div>
  );
}
