import React from 'react';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { getFieldByRole, getRecordStatus, getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { getStatusColor } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerColumns';
import { TrackerSwatchBadge } from './primitives/TrackerSwatchBadge';

export function TrackerStackedRow({ item, selected, showType, onOpen }: {
  item: TrackerRecord; selected: boolean; showType: boolean; onOpen: () => void;
}) {
  const status = getRecordStatus(item);
  const progress = getFieldByRole(item, 'progress');
  const updated = item.system.updatedAt ? new Date(item.system.updatedAt) : null;
  return (
    <button type="button" className={`tracker-stacked-row${selected ? ' is-selected' : ''}`} data-testid="tracker-list-row" data-item-id={item.id} onClick={onOpen}>
      <span className="tracker-stacked-title">{getRecordTitle(item)}</span>
      <span className="tracker-stacked-meta">
        {status ? <TrackerSwatchBadge label={status} color={getStatusColor(status, item.primaryType)} /> : null}
        {typeof progress === 'number' && Number.isFinite(progress) ? <span>{progress}%</span> : null}
        {updated && Number.isFinite(updated.getTime()) ? <time dateTime={updated.toISOString()}>{updated.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time> : null}
        {showType ? <span>{item.primaryType}</span> : null}
        {item.issueKey ? <span className="tracker-stacked-key">{item.issueKey}</span> : null}
      </span>
    </button>
  );
}
