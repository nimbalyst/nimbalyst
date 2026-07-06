/**
 * PrTrackerBadge — a tracker item's workflow status (and optional priority
 * marker) rendered with the item's own schema colors. Type-agnostic: driven
 * entirely by the workflowStatus / priority roles, so any tracker type that
 * references a PR gets a correct badge.
 */

import { MaterialSymbol } from '@nimbalyst/runtime';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import {
  getRecordStatus,
  getRecordPriority,
  getStatusOptions,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';

const FALLBACK_COLOR = '#6b7280';
const PRIORITY_MARKERS: Record<string, string> = {
  critical: '#ef4444',
  high: '#f97316',
};

export function statusOptionFor(record: TrackerRecord): {
  value: string;
  label: string;
  icon?: string;
  color?: string;
} | null {
  const status = getRecordStatus(record);
  if (!status) return null;
  const option = getStatusOptions(record.primaryType).find((o) => o.value === status);
  return option ?? { value: status, label: status };
}

interface PrTrackerBadgeProps {
  record: TrackerRecord;
  /** Compact list-row variant: smaller, no icon. */
  compact?: boolean;
  onClick?: () => void;
  title?: string;
}

export function PrTrackerBadge({ record, compact, onClick, title }: PrTrackerBadgeProps): JSX.Element | null {
  const option = statusOptionFor(record);
  if (!option) return null;
  const color = option.color || FALLBACK_COLOR;
  const priority = getRecordPriority(record);
  const priorityColor = PRIORITY_MARKERS[priority];

  const inner = (
    <>
      {!compact && option.icon && <MaterialSymbol icon={option.icon} size={12} />}
      {option.label}
      {priorityColor && (
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ backgroundColor: priorityColor }}
          title={`${priority} priority`}
        />
      )}
    </>
  );

  const className = `pr-tracker-badge inline-flex items-center gap-1 rounded font-medium shrink-0 ${
    compact ? 'px-1 py-px text-[10px]' : 'px-1.5 py-0.5 text-[11px]'
  }`;
  const style = { color, backgroundColor: `${color}20` };

  if (onClick) {
    return (
      <button
        type="button"
        className={`${className} hover:brightness-125 transition-[filter]`}
        style={style}
        title={title ?? `${record.issueKey ?? ''} ${option.label}`.trim()}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        {inner}
      </button>
    );
  }
  return (
    <span className={className} style={style} title={title}>
      {inner}
    </span>
  );
}
