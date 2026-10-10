import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { TrackerRelationshipLabelResolver } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { getCellValue, resolveColumnFieldName, resolveColumnsForType } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerColumns';
import { formatValue } from '../grid/trackerGridColumns';

/** The same field labels and values as a table, in the order chosen for this view. */
export function ViewCardFields({ item, columns, resolveLabel }: {
  item: TrackerRecord;
  columns: readonly string[];
  resolveLabel?: TrackerRelationshipLabelResolver;
}) {
  const definitions = resolveColumnsForType(item.primaryType);
  return <span className="view-card-fields flex flex-wrap gap-1">
    {columns.filter(id => id !== 'title').map(id => {
      const column = definitions.find(candidate => candidate.id === id);
      if (!column) return null;
      const value = formatValue(column, getCellValue(item, resolveColumnFieldName(item.primaryType, column)), item.primaryType, resolveLabel);
      return value ? <span key={id} className="max-w-48 truncate rounded bg-nim-tertiary px-1.5 py-0.5 text-[10px] text-nim-muted" title={`${column.label}: ${value}`}>{column.label}: {value}</span> : null;
    })}
  </span>;
}
