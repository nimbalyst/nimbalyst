/**
 * Translates the tracker column registry into RevoGrid columns and rows.
 *
 * Source rows carry the *raw stored values* (not display strings) so cell
 * editors seed from real values and sorting/comparison stay type-correct;
 * `cellTemplate` is responsible for turning those into display text.
 */

import type { ColumnRegular, DataType, HyperFunc, VNode, CellTemplateProp } from '@revolist/revogrid';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { TrackerColumnDef } from '@nimbalyst/runtime/plugins/TrackerPlugin';
import {
  getCellValue,
  getStatusColor,
  getPriorityColor,
  getTypeColor,
  getFieldForColumn,
  formatRelativeDate,
} from '@nimbalyst/runtime/plugins/TrackerPlugin';
import { resolveRoleFieldName } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { compareCellValues } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerRowData';
import { resolveCellEditor } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerCellEditors';
import {
  createRowAwareTrackerCellEditor,
  createTrackerCellEditor,
  type TrackerEditorContext,
} from './trackerGridEditors';

/** Row key holding the tracker item id; prefixed so it can't collide with a field name. */
export const ROW_ITEM_ID = '__trackerItemId';
/** Row key holding the primary tracker type for mixed-schema editor resolution. */
export const ROW_ITEM_TYPE = '__trackerItemType';

function fieldNameForColumn(recordType: string, column: TrackerColumnDef): string {
  return column.role ? resolveRoleFieldName(recordType, column.role) : column.id;
}

/** Build one RevoGrid source row per record, keyed by column id. */
export function buildGridSource(
  items: TrackerRecord[],
  columns: TrackerColumnDef[],
): DataType[] {
  return items.map(item => {
    const row: DataType = {
      [ROW_ITEM_ID]: item.id,
      [ROW_ITEM_TYPE]: item.primaryType,
    };
    for (const col of columns) {
      row[col.id] = getCellValue(item, fieldNameForColumn(item.primaryType, col));
    }
    return row;
  });
}

function textNode(createElement: HyperFunc<VNode>, text: string): VNode {
  return createElement('span', { class: 'tracker-grid-cell-text' }, text);
}

function badgeNode(createElement: HyperFunc<VNode>, text: string, color: string): VNode {
  return createElement(
    'span',
    {
      class: 'tracker-grid-cell-badge',
      style: { backgroundColor: `${color}22`, color, borderColor: `${color}66` },
    },
    text,
  );
}

/** Human-readable text for a stored value, by column render type. */
function formatValue(col: TrackerColumnDef, value: unknown, trackerType: string): string {
  if (value === undefined || value === null || value === '') return '';

  switch (col.render) {
    case 'date': {
      const date = value instanceof Date ? value : new Date(String(value));
      return Number.isNaN(date.getTime()) ? String(value) : formatRelativeDate(date);
    }
    case 'tags':
      return Array.isArray(value) ? value.join(', ') : String(value);
    case 'url': {
      if (typeof value === 'object' && value !== null && 'url' in (value as any)) {
        const url = value as { url: string; label?: string };
        return url.label ?? url.url;
      }
      return String(value);
    }
    case 'relationship': {
      const list = Array.isArray(value) ? value : [value];
      return list
        .map((v: any) => (typeof v === 'string' ? v : v?.issueKey ?? v?.title ?? v?.itemId ?? ''))
        .filter(Boolean)
        .join(', ');
    }
    case 'avatar': {
      if (typeof value === 'object' && value !== null) {
        const identity = value as {
          displayName?: unknown;
          email?: unknown;
          gitEmail?: unknown;
          gitName?: unknown;
        };
        return String(
          identity.displayName
          ?? identity.email
          ?? identity.gitEmail
          ?? identity.gitName
          ?? '',
        );
      }
      return String(value);
    }
    case 'badge': {
      // Prefer the schema option's label over the raw stored value.
      const field = getFieldForColumn(trackerType, fieldNameForColumn(trackerType, col));
      const option = field?.options?.find(o => o.value === String(value));
      return option?.label ?? String(value);
    }
    case 'progress':
      return typeof value === 'number' ? `${value}%` : String(value);
    default:
      if (typeof value === 'boolean') return value ? 'Yes' : 'No';
      return String(value);
  }
}

/** Favorite affordance for the title cell, matching the list view's star. */
function favoriteNode(
  createElement: HyperFunc<VNode>,
  itemId: string,
  isFavorite: boolean,
  onToggleFavorite: (itemId: string) => void,
): VNode {
  return createElement(
    'span',
    {
      class: isFavorite
        ? 'tracker-grid-cell-favorite is-favorite'
        : 'tracker-grid-cell-favorite',
      title: isFavorite ? 'Remove from favorites' : 'Add to favorites',
      // The grid focuses a cell on pointerdown, which would open the detail
      // panel behind the star. Swallow both events so the star is a pure toggle.
      onPointerDown: (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
      },
      onClick: (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onToggleFavorite(itemId);
      },
    },
    createElement(
      'span',
      { class: 'material-symbols-outlined tracker-grid-cell-favorite-icon' },
      isFavorite ? 'star' : 'star_outline',
    ),
  );
}

/** Colored-badge columns get a pill; everything else renders as plain text. */
function buildCellTemplate(
  col: TrackerColumnDef,
  trackerType: string,
  favorites?: FavoritesOptions,
) {
  return (createElement: HyperFunc<VNode>, props: CellTemplateProp): VNode => {
    const value = props.model?.[col.id];
    const rowType = trackerType || String(props.model?.[ROW_ITEM_TYPE] ?? '');
    const text = formatValue(col, value, rowType);

    // The title column carries the favorite star, so it renders even when the
    // title itself is empty.
    if (favorites && col.role === 'title') {
      const itemId = String(props.model?.[ROW_ITEM_ID] ?? '');
      return createElement('span', { class: 'tracker-grid-cell-title' }, [
        favoriteNode(
          createElement,
          itemId,
          favorites.favoriteItemIds.has(itemId),
          favorites.onToggleFavorite,
        ),
        textNode(createElement, text),
      ]);
    }

    if (!text) return textNode(createElement, '');

    if (col.render === 'badge' || col.render === 'type-icon') {
      const color = col.role === 'workflowStatus'
        ? getStatusColor(String(value), rowType)
        : col.role === 'priority'
          ? getPriorityColor(String(value))
          : getTypeColor(String(value));
      return badgeNode(createElement, text, color);
    }

    if (col.render === 'tags' || col.render === 'relationship') {
      const parts = text.split(', ').filter(Boolean);
      return createElement(
        'span',
        { class: 'tracker-grid-cell-tags' },
        parts.map(p => badgeNode(createElement, p, '#6b7280')),
      );
    }

    return textNode(createElement, text);
  };
}

export interface FavoritesOptions {
  favoriteItemIds: ReadonlySet<string>;
  onToggleFavorite: (itemId: string) => void;
}

export interface BuildGridColumnsOptions {
  /** Active tracker type; `'all'` means a mixed-type view. */
  trackerType: string;
  /** Persisted per-column width overrides. */
  columnWidths?: Record<string, number>;
  /** Whether this record's cells may be edited at all (source/permission gate). */
  isRowEditable: (itemId: string) => boolean;
  /** Extra context handed to editors (relationship candidates). */
  editorContext?: TrackerEditorContext;
  /** Column ids that currently have an active filter, for the header indicator. */
  filteredColumnIds?: ReadonlySet<string>;
  /** Open the column filter popover, anchored to the clicked header cell. */
  onOpenFilter?: (columnId: string, anchorRect: DOMRect) => void;
  /** Let RevoGrid own sortable header clicks and its built-in sort indicator. */
  sortingEnabled?: boolean;
  /** Renders the favorite star in the title cell; omit to hide it. */
  favorites?: FavoritesOptions;
}

/**
 * Header template: the label plus a filter affordance. Rendered in RevoGrid's
 * hyperscript, so the click handler hands the anchor rect back to React and the
 * popover itself is an ordinary floating-ui component.
 */
function buildColumnTemplate(
  col: TrackerColumnDef,
  isFiltered: boolean,
  onOpenFilter?: (columnId: string, anchorRect: DOMRect) => void,
) {
  return (createElement: HyperFunc<VNode>): VNode => createElement(
    'span',
    { class: 'tracker-grid-header' },
    [
      createElement('span', { class: 'tracker-grid-header-label' }, col.label),
      createElement('span', { class: 'tracker-grid-header-actions' }, [
        ...(onOpenFilter
          ? [createElement(
            'span',
            {
              class: isFiltered
                ? 'tracker-grid-header-filter is-filtered'
                : 'tracker-grid-header-filter',
              title: isFiltered ? 'Column filtered' : `Filter ${col.label}`,
              onClick: (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                const target = e.currentTarget as HTMLElement | null;
                const rect = target?.getBoundingClientRect()
                  ?? DOMRect.fromRect({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
                onOpenFilter(col.id, rect);
              },
            },
            createElement(
              'span',
              { class: 'material-symbols-outlined tracker-grid-header-filter-icon' },
              'filter_alt',
            ),
          )]
          : []),
      ]),
    ],
  );
}

/**
 * Map visible tracker columns to RevoGrid columns, attaching the per-field
 * editor and a per-cell readonly gate.
 */
export function buildGridColumns(
  columns: TrackerColumnDef[],
  {
    trackerType,
    columnWidths = {},
    isRowEditable,
    editorContext = {},
    filteredColumnIds,
    onOpenFilter,
    sortingEnabled = false,
    favorites,
  }: BuildGridColumnsOptions,
): ColumnRegular[] {
  return columns.map((col): ColumnRegular => {
    const field = getFieldForColumn(trackerType, col.id);
    const descriptor = resolveCellEditor(field);
    const editor = !col.editable
      ? undefined
      : trackerType
        ? createTrackerCellEditor(descriptor, editorContext)
        : createRowAwareTrackerCellEditor((editCell) => {
          const rowType = String(editCell?.model?.[ROW_ITEM_TYPE] ?? '');
          const rowField = getFieldForColumn(rowType, fieldNameForColumn(rowType, col));
          return resolveCellEditor(rowField);
        }, editorContext);

    return {
      prop: col.id,
      name: col.label,
      size: columnWidths[col.id] ?? (typeof col.width === 'number' ? col.width : 280),
      minSize: col.minWidth ?? 60,
      sortable: sortingEnabled && col.sortable,
      // RevoGrid re-sorts `source` on every assignment using the sorting config,
      // so its comparer -- not the pre-sort in TrackerGridView -- decides the
      // final row order. Its default stringifies everything; delegate to the
      // shared comparator so both surfaces agree and dates stay chronological.
      cellCompare: (prop, a, b) => compareCellValues(a?.[prop], b?.[prop], col.render),
      editor,
      readonly: ({ model }) => {
        if (!editor) return true;
        const itemId = model?.[ROW_ITEM_ID];
        if (!trackerType) {
          const rowType = String(model?.[ROW_ITEM_TYPE] ?? '');
          const rowField = getFieldForColumn(rowType, fieldNameForColumn(rowType, col));
          if (resolveCellEditor(rowField).kind === 'readonly') return true;
        }
        return typeof itemId === 'string' ? !isRowEditable(itemId) : true;
      },
      cellTemplate: buildCellTemplate(col, trackerType, favorites),
      ...(onOpenFilter
        ? {
          columnTemplate: buildColumnTemplate(
            col,
            filteredColumnIds?.has(col.id) ?? false,
            onOpenFilter,
          ),
        }
        : {}),
    };
  });
}
