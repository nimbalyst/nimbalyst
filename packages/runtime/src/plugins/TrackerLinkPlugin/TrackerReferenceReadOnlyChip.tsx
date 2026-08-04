/**
 * TrackerReferenceReadOnlyChip — the chip for hosts with no tracker store.
 *
 * {@link TrackerReferenceChip} resolves an item's live title/status through the
 * runtime tracker atoms and opens a click-through preview card. In a host with
 * no tracker store — the web console — every lookup returns null, so it does
 * degrade to a muted key-only chip as documented, but it stays clickable: the
 * card it opens says only that the item could not be resolved and offers no
 * action. A dead-end affordance on every reference is worse than none.
 *
 * This renders the same resting shape (the reader still sees a reference, not
 * bare prose) with no store, no popover and no navigation. Swap it for the live
 * chip in any host that gains a tracker store.
 *
 * Not a size decision: measured against the collab bundle, using the live chip
 * here instead moves the eager editor artifact by 4 gzip bytes, because the
 * runtime barrel already carries it.
 */

import type { JSX } from 'react';
import * as React from 'react';

import type { TrackerReferenceNodeRendererProps } from './TrackerReferenceNodeRenderer';

export function TrackerReferenceReadOnlyChip({
  referenceKey,
}: TrackerReferenceNodeRendererProps): JSX.Element {
  return (
    <span
      className="tracker-reference-chip tracker-reference-chip--read-only"
      data-issue-key={referenceKey}
      data-resolved="false"
      title={referenceKey}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        maxWidth: '100%',
        boxSizing: 'border-box',
        padding: '1px 6px',
        borderRadius: '10px',
        fontSize: '0.85em',
        fontWeight: 700,
        lineHeight: '1.5',
        verticalAlign: 'baseline',
        background: 'var(--nim-bg-secondary)',
        border: '1px solid var(--nim-border)',
        color: 'var(--nim-text)',
        whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
    >
      {referenceKey}
    </span>
  );
}
