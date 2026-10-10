/**
 * Pieces shared by the live reference views: the inline chip, open handlers,
 * and field readers. Split out so the card and the state menu can live in
 * their own files without importing the view barrel.
 */

import type { JSX, KeyboardEvent, MouseEvent } from 'react';

import type { TrackerItem } from '../../trackers/dataSource';
import { useTrackerReference } from './TrackerReferenceResolverContext';
import type {
  TrackerReferenceResolver,
  TrackerReferenceStatusInfo,
  TrackerReferenceTypeInfo,
  TrackerStatement,
} from './trackerReferenceResolver';

export interface ResolverProps {
  resolver: TrackerReferenceResolver;
  referenceKey: string;
}

export function openHandlers(resolver: TrackerReferenceResolver, itemId: string | null) {
  const open = resolver.openItem;
  if (!open || !itemId) return {};
  const activate = (event: MouseEvent | KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    open(itemId);
  };
  return {
    role: 'link' as const,
    tabIndex: 0,
    onClick: activate,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') activate(event);
    },
  };
}

export function TypeIcon({ typeInfo }: { typeInfo: TrackerReferenceTypeInfo }): JSX.Element | null {
  if (!typeInfo.icon) return null;
  return (
    <span
      className="material-symbols-outlined tracker-reference-type-icon"
      role="img"
      aria-label={typeInfo.displayName}
      style={{ color: typeInfo.color }}
    >
      {typeInfo.icon}
    </span>
  );
}

export function StatusBadge({ status }: { status: TrackerReferenceStatusInfo | null }): JSX.Element | null {
  if (!status) return null;
  return (
    <span className="tracker-reference-status" data-status={status.value}>
      <span className="tracker-reference-status-dot" style={{ background: status.color }} aria-hidden="true" />
      {status.label}
    </span>
  );
}

export function displayKey(item: TrackerItem, fallback: string): string {
  return item.issueKey ?? fallback;
}

export function LiveChip({ resolver, referenceKey }: ResolverProps): JSX.Element {
  const resolution = useTrackerReference(resolver, referenceKey);
  if (resolution.state !== 'resolved') {
    return (
      <span
        className="tracker-reference-live-chip"
        data-issue-key={referenceKey}
        data-resolved="false"
        data-state={resolution.state}
        title={resolution.state === 'loading' ? `${referenceKey} (loading)` : `${referenceKey} (not found)`}
      >
        <span className="tracker-reference-live-chip-key">{referenceKey}</span>
      </span>
    );
  }
  const { item, typeInfo, status } = resolution;
  const done = status?.category === 'done' || status?.category === 'cancelled';
  return (
    <span
      className="tracker-reference-live-chip"
      data-issue-key={referenceKey}
      data-resolved="true"
      data-type={item.type}
      data-completed={done ? 'true' : 'false'}
      title={`${displayKey(item, referenceKey)}: ${item.title}${status ? ` (${status.label})` : ''}`}
      {...openHandlers(resolver, item.id)}
    >
      <TypeIcon typeInfo={typeInfo} />
      {/* The name carries the weight. A type without a key prefix would show
          its raw item id here, so the key is left to the tooltip. */}
      {item.issueKey || !item.title ? (
        <span className="tracker-reference-live-chip-key">{displayKey(item, referenceKey)}</span>
      ) : null}
      {item.title ? <span className="tracker-reference-live-chip-title">{item.title}</span> : null}
      {status ? (
        <span
          className="tracker-reference-status-dot"
          style={{ background: status.color }}
          role="img"
          aria-label={status.label}
        />
      ) : null}
    </span>
  );
}

export function text(resolver: TrackerReferenceResolver, item: TrackerItem, field: string): string | null {
  const value = resolver.fieldValue(item, field);
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function StatementObject({
  resolver,
  statement,
}: {
  resolver: TrackerReferenceResolver;
  statement: Pick<TrackerStatement, 'objectItemId' | 'valueText'>;
}): JSX.Element | null {
  if (statement.objectItemId) return <LiveChip resolver={resolver} referenceKey={statement.objectItemId} />;
  if (statement.valueText) return <span className="tracker-reference-value-text">{statement.valueText}</span>;
  return null;
}
