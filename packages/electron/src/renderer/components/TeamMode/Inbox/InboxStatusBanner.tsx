import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

import { formatRelativeTimestamp } from './inboxViewModel';
import type { InboxStatus } from './inboxTypes';

/**
 * List-level connection state. Offline-with-cache keeps the rows navigable and
 * says how old they are; reconnecting says why the list has stopped moving.
 */
export function InboxStatusBanner({
  status,
  lastSyncedAt,
  now,
}: {
  status: InboxStatus;
  lastSyncedAt?: number;
  now: number;
}) {
  if (status === 'ready' || status === 'loading' || status === 'offlineWithoutCache') return null;

  const offline = status === 'offlineWithCache';

  return (
    <p
      className="inbox-status-banner m-0 flex items-center gap-1.5 border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-5 py-2 text-[12px] text-[var(--nim-text-muted)]"
      data-testid="inbox-status-banner"
      data-status={status}
      role="status"
    >
      <MaterialSymbol icon={offline ? 'cloud_off' : 'sync'} size={14} className="shrink-0" />
      {offline
        ? (
          <>
            Offline — showing cached deliveries
            {lastSyncedAt ? ` from ${formatRelativeTimestamp(lastSyncedAt, now)} ago` : ''}
            . Previews may be out of date and changes queue until you reconnect.
          </>
        )
        : 'Reconnecting — the list is paused until the canonical sequence is reconciled.'}
    </p>
  );
}
