/**
 * Translates the tracker column registry into RevoGrid columns and rows.
 *
 * Source rows carry the *raw stored values* (not display strings) so cell
 * editors seed from real values and sorting/comparison stay type-correct;
 * `cellTemplate` is responsible for turning those into display text.
 */

import type { ColumnRegular, HyperFunc, VNode, CellTemplateProp } from '@revolist/revogrid';
import {
  formatTrackerDateCell,
  getFieldForColumn,
  getPriorityColor,
  getStatusColor,
  getTypeColor,
  getTypeIcon,
  resolveColumnFieldName,
  type TrackerColumnDef,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerColumns';
import {
  normalizeRelationshipValue,
  resolveRelationshipLabel,
  type TrackerRelationshipLabelResolver,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { compareCellValues } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerRowData';
import { resolveCellEditor } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerCellEditors';
import {
  createRowAwareTrackerCellEditor,
  createTrackerCellEditor,
  type TrackerEditorContext,
} from './trackerGridEditors';
import {
  buildGridSource,
  ROW_ACTIONS,
  ROW_ITEM_ID,
  ROW_ITEM_TYPE,
} from '@nimbalyst/collab-client/trackers';

export { buildGridSource, ROW_ACTIONS, ROW_ITEM_ID, ROW_ITEM_TYPE };

function textNode(createElement: HyperFunc<VNode>, text: string, title?: string): VNode {
  return createElement('span', { class: 'tracker-grid-cell-text', ...(title ? { title } : {}) }, text);
}

/**
 * The hue is handed over as `--tracker-swatch` and `trackerGrid.css` derives the
 * fill, border and text from it against the theme, the same way the list and
 * board pills do. The previous `${color}22` / `${color}66` arithmetic printed a
 * 600-level schema hue at full strength on a tint of itself, which is under AA
 * on every dark theme.
 */
function badgeNode(createElement: HyperFunc<VNode>, text: string, color: string): VNode {
  return createElement(
    'span',
    { class: 'tracker-grid-cell-badge', style: { '--tracker-swatch': color } },
    text,
  );
}

/**
 * The display values of a multi-chip column, one entry per stored value.
 *
 * The renderer reads this rather than re-splitting `formatValue`'s joined
 * string: a title that itself contains ', ' -- "Tampa, FL client meeting" --
 * came back as two chips, so a field holding one link looked like it held two
 * (nimbalyst#1424). Returns null for columns that are not chip-rendered.
 */
function formatValueParts(
  col: TrackerColumnDef,
  value: unknown,
  resolveLabel?: TrackerRelationshipLabelResolver,
): string[] | null {
  if (value === undefined || value === null || value === '') return null;

  switch (col.render) {
    case 'tags':
      return (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
    case 'relationship':
      // The live record's title, not the snapshot on the link: a collection
      // linked from the other side carries no title at all, so the chip would
      // otherwise read as a raw item id.
      return normalizeRelationshipValue(value)
        .map(link => resolveRelationshipLabel(link, resolveLabel))
        .filter(Boolean);
    default:
      return null;
  }
}

/** Human-readable text for a stored value, by column render type. */
function formatValue(
  col: TrackerColumnDef,
  value: unknown,
  trackerType: string,
  resolveLabel?: TrackerRelationshipLabelResolver,
): string {
  if (value === undefined || value === null || value === '') return '';

  switch (col.render) {
    case 'date':
      // formatTrackerDateCell, not `new Date`: a calendar-day string is local
      // midnight, not UTC midnight, and reads by day rather than by elapsed
      // time (nimbalyst#1135, #1156).
      return formatTrackerDateCell(value).display;
    case 'tags':
      return (formatValueParts(col, value, resolveLabel) ?? []).join(', ');
    case 'url': {
      if (typeof value === 'object' && value !== null && 'url' in (value as any)) {
        const url = value as { url: string; label?: string };
        return url.label ?? url.url;
      }
      return String(value);
    }
    case 'relationship':
      return (formatValueParts(col, value, resolveLabel) ?? []).join(', ');
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
      const field = getFieldForColumn(trackerType, resolveColumnFieldName(trackerType, col));
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

/**
 * The Type cell: the schema's icon in the schema's hue, with the type name on
 * hover.
 *
 * The column registry declares Type as `width: 64, minWidth: 64,
 * render: 'type-icon'` because 64px is an icon, which is how desktop's
 * `TrackerTable` draws it. This template had no `type-icon` branch, so the
 * column fell through to the text badge below and every value clipped mid-word
 * -- `githu`, `decis`, `comp`. The name stays reachable as the cell's title
 * rather than being widened into the row.
 */
function typeIconNode(
  createElement: HyperFunc<VNode>,
  type: string,
  label: string,
): VNode {
  return createElement(
    'span',
    {
      class: 'tracker-grid-cell-type-icon',
      style: { color: getTypeColor(type) },
      title: label,
    },
    createElement('span', { class: 'material-symbols-outlined' }, getTypeIcon(type)),
  );
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

/** Discoverable trigger that reuses TrackerGridView's existing right-click path. */
function contextMenuNode(
  createElement: HyperFunc<VNode>,
  placement: 'title' | 'column',
): VNode {
  return createElement(
    'button',
    {
      type: 'button',
      class: `tracker-grid-cell-menu tracker-grid-cell-menu-${placement}`,
      title: 'Item actions',
      'aria-label': 'Item actions',
      // Preserve RevoGrid's current range so opening the menu can apply to the
      // whole selection when this row is already inside it.
      onPointerDown: (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
      },
      onClick: (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const target = e.currentTarget as HTMLElement;
        target.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: e.clientX,
          clientY: e.clientY,
          button: 2,
        }));
      },
    },
    createElement(
      'span',
      { class: 'material-symbols-outlined tracker-grid-cell-menu-icon' },
      'more_horiz',
    ),
  );
}

/**
 * The Key cell doubles as the row's open affordance: the key itself opens the
 * detail pane, and an expand icon appears on row hover to open the row as a
 * document.
 *
 * Key is the one column that is never editable, so it is the only cell that can
 * carry a gesture without competing with cell editing. That is what lets a plain
 * click everywhere else mean nothing but "select this cell" -- previously *any*
 * click opened the detail pane, so the grid could not be browsed without the
 * panel following the cursor.
 */
function keyLinkNode(
  createElement: HyperFunc<VNode>,
  text: string,
  itemId: string,
  keyLink: KeyLinkOptions,
): VNode {
  const swallow = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
  };
  const openDetail = (e: MouseEvent): void => {
    swallow(e);
    keyLink.onOpenDetail(itemId);
  };

  // Not every row has a key -- imported and frontmatter-projected items may
  // never get one -- and a blank cell would leave those rows with nothing to
  // click. The expand icon stands in for the missing number and carries the
  // key's gesture, staying visible because there is no text beside it to
  // suggest the cell is clickable at all.
  if (!text) {
    return createElement('span', { class: 'tracker-grid-cell-key' }, [
      createElement(
        'button',
        {
          type: 'button',
          class: 'tracker-grid-cell-key-link is-icon-only',
          title: 'Open details',
          'aria-label': 'Open details',
          onClick: openDetail,
        },
        createElement(
          'span',
          { class: 'material-symbols-outlined tracker-grid-cell-key-open-icon' },
          'open_in_full',
        ),
      ),
    ]);
  }

  return createElement('span', { class: 'tracker-grid-cell-key' }, [
    createElement(
      'button',
      {
        type: 'button',
        class: 'tracker-grid-cell-key-link',
        title: 'Open details',
        onClick: openDetail,
      },
      text,
    ),
    ...(keyLink.onOpenDocument
      ? [createElement(
        'span',
        {
          class: 'tracker-grid-cell-key-open',
          title: 'Open as a document',
          'aria-label': 'Open as a document',
          // The grid focuses a cell on pointerdown; keep this a pure action so
          // the icon does not also move the selection out from under the click.
          onPointerDown: swallow,
          onClick: (e: MouseEvent) => {
            swallow(e);
            keyLink.onOpenDocument?.(itemId);
          },
        },
        createElement(
          'span',
          { class: 'material-symbols-outlined tracker-grid-cell-key-open-icon' },
          'open_in_full',
        ),
      )]
      : []),
  ]);
}

interface CellTemplateOptions {
  favorites?: FavoritesOptions;
  rowActions?: boolean;
  resolveLabel?: TrackerRelationshipLabelResolver;
  keyLink?: KeyLinkOptions;
}

/** Colored-badge columns get a pill; everything else renders as plain text. */
function buildCellTemplate(
  col: TrackerColumnDef,
  trackerType: string,
  { favorites, rowActions = false, resolveLabel, keyLink }: CellTemplateOptions = {},
) {
  return (createElement: HyperFunc<VNode>, props: CellTemplateProp): VNode => {
    const value = props.model?.[col.id];
    const rowType = trackerType || String(props.model?.[ROW_ITEM_TYPE] ?? '');
    const text = formatValue(col, value, rowType, resolveLabel);

    // The title column carries its inline affordances, so it renders even when
    // the title itself is empty.
    if ((favorites || rowActions) && (col.role === 'title' || col.id === 'title')) {
      const itemId = String(props.model?.[ROW_ITEM_ID] ?? '');
      return createElement('span', { class: 'tracker-grid-cell-title' }, [
        ...(favorites
          ? [favoriteNode(
            createElement,
            itemId,
            favorites.favoriteItemIds.has(itemId),
            favorites.onToggleFavorite,
          )]
          : []),
        textNode(createElement, text),
        ...(rowActions ? [contextMenuNode(createElement, 'title')] : []),
      ]);
    }

    if (keyLink && col.id === 'key') {
      return keyLinkNode(
        createElement,
        text,
        String(props.model?.[ROW_ITEM_ID] ?? ''),
        keyLink,
      );
    }

    if (!text) return textNode(createElement, '');

    if (col.render === 'type-icon') {
      return typeIconNode(createElement, String(value), text);
    }

    if (col.render === 'badge') {
      const color = col.role === 'workflowStatus'
        ? getStatusColor(String(value), rowType)
        : col.role === 'priority'
          ? getPriorityColor(String(value))
          : getTypeColor(String(value));
      return badgeNode(createElement, text, color);
    }

    if (col.render === 'tags' || col.render === 'relationship') {
      const parts = formatValueParts(col, value, resolveLabel) ?? [];
      return createElement(
        'span',
        { class: 'tracker-grid-cell-tags' },
        parts.map(p => badgeNode(createElement, p, '#6b7280')),
      );
    }

    // A relative label ("in 5 days") hides the real value, so keep the exact
    // date reachable on hover.
    if (col.render === 'date') {
      return textNode(createElement, text, formatTrackerDateCell(value).title);
    }

    return textNode(createElement, text);
  };
}

export interface FavoritesOptions {
  favoriteItemIds: ReadonlySet<string>;
  onToggleFavorite: (itemId: string) => void;
}

/** Turns the Key cell into the row's open affordance; omit to leave it plain text. */
export interface KeyLinkOptions {
  /** Clicking the key opens the row in the detail pane. */
  onOpenDetail: (itemId: string) => void;
  /** Hover affordance inside the key cell; omit where documents are unavailable. */
  onOpenDocument?: (itemId: string) => void;
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
  /** Also renders the overflow trigger inside the title cell. */
  rowActions?: boolean;
  /** Makes the Key cell the row's open affordance. */
  keyLink?: KeyLinkOptions;
  /** Names a relationship target from the live record rather than the link snapshot. */
  resolveRelationshipLabel?: TrackerRelationshipLabelResolver;
}

/** Always-present trailing action column, separate from editable tracker fields. */
export function buildGridActionsColumn(): ColumnRegular {
  return {
    prop: ROW_ACTIONS,
    name: '',
    size: 36,
    minSize: 36,
    maxSize: 36,
    pin: 'colPinEnd',
    sortable: false,
    readonly: true,
    cellTemplate: (createElement: HyperFunc<VNode>) => contextMenuNode(createElement, 'column'),
  };
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
    rowActions = false,
    keyLink,
    resolveRelationshipLabel: resolveLabel,
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
          const rowField = getFieldForColumn(rowType, resolveColumnFieldName(rowType, col));
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
          const rowField = getFieldForColumn(rowType, resolveColumnFieldName(rowType, col));
          if (resolveCellEditor(rowField).kind === 'readonly') return true;
        }
        return typeof itemId === 'string' ? !isRowEditable(itemId) : true;
      },
      cellTemplate: buildCellTemplate(col, trackerType, {
        favorites,
        rowActions,
        resolveLabel,
        keyLink,
      }),
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
