/**
 * The hover peek of a quiet tracker reference. Loaded lazily on the first
 * hover or focus so `@floating-ui/react` stays out of the trackers-ui eager
 * graph; the link itself (TrackerReferenceQuietLink) owns open state and timing.
 */

import type { JSX } from 'react';
import { FloatingPortal, autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react';
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';

import type { TrackerItem } from '../../trackers/dataSource';
import { displayKey } from './TrackerReferenceParts';
import type { TrackerReferenceStatusInfo, TrackerReferenceTypeInfo } from './trackerReferenceResolver';

export interface TrackerReferenceQuietPeekProps {
  anchor: HTMLElement;
  item: TrackerItem;
  referenceKey: string;
  typeInfo: TrackerReferenceTypeInfo;
  status: TrackerReferenceStatusInfo | null;
  summary: string | null;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

export function TrackerReferenceQuietPeek({
  anchor,
  item,
  referenceKey,
  typeInfo,
  status,
  summary,
  onPointerEnter,
  onPointerLeave,
}: TrackerReferenceQuietPeekProps): JSX.Element {
  const { refs, floatingStyles } = useFloating({
    open: true,
    elements: { reference: anchor },
    placement: 'bottom-start',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
    whileElementsMounted: autoUpdate,
  });
  return (
    <FloatingPortal>
      <span
        ref={refs.setFloating}
        className="tracker-reference-peek"
        role="tooltip"
        style={floatingStyles}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        <span className="tracker-reference-peek-meta">
          <span>{typeInfo.displayName}{status ? ` · ${status.label}` : ''}</span>
          <span className="tracker-reference-peek-key">{displayKey(item, referenceKey)}</span>
        </span>
        <span className="tracker-reference-peek-title">{item.title}</span>
        {summary ? <span className="tracker-reference-peek-summary">{summary}</span> : null}
      </span>
    </FloatingPortal>
  );
}
