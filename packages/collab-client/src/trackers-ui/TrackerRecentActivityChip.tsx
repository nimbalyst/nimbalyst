import React, { useMemo } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { TrackerIdentity } from '@nimbalyst/runtime/core/DocumentService';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { getRecentTeammateActivity } from '@nimbalyst/tracker-core';

export interface TrackerRecentActivityChipProps {
  item: TrackerRecord;
  identity?: TrackerIdentity | null;
  windowHours?: number;
  className?: string;
}

/** Quiet coordination hint; absent when no teammate touched the item recently. */
export function TrackerRecentActivityChip({
  item,
  identity,
  windowHours = 24,
  className = '',
}: TrackerRecentActivityChipProps) {
  const nowMs = useMemo(() => Date.now(), [item]);
  const activity = useMemo(
    () => getRecentTeammateActivity(item, identity, nowMs, windowHours),
    [identity, item, nowMs, windowHours],
  );
  if (!activity) return null;
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--nim-warning)]/35 bg-[var(--nim-warning)]/10 px-1.5 py-0.5 text-[10px] text-nim-muted ${className}`}
      title={activity.summary}
      data-testid="tracker-recent-teammate-activity"
    >
      <MaterialSymbol icon="group" size={11} className="shrink-0 text-[var(--nim-warning)]" />
      <span className="truncate">{activity.actor.displayName} · {activity.relativeLabel}</span>
    </span>
  );
}
