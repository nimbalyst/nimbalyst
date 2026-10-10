/**
 * Hyperscript renderers for the cell types that draw more than formatted text.
 *
 * Kept out of `SpreadsheetEditor.tsx` deliberately: that file is already the
 * largest in the extension, and cell presentation has no reason to live in it.
 *
 * Both renderers mark their element with a `data-` attribute rather than
 * attaching handlers. Clicks are picked up by one delegated listener on the
 * editor root, which keeps RevoGrid's own cell mousedown handling intact.
 */

import type { ColumnRegular } from '@revolist/react-datagrid';

import { cellDisplayText, parseTrackerCell, parseUrlCell, shownValue } from '../utils/formatters';
import type { ColumnFormat } from '../types';
import { trackerStatusTone, type TrackerResolutionStore } from './trackerResolution';
import type { ListOption } from '../validation/types';

type CellTemplate = NonNullable<ColumnRegular['cellTemplate']>;
export type HyperFunc = Parameters<CellTemplate>[0];

/** Attribute carrying a link target; read by the delegated click handler. */
export const URL_CELL_ATTRIBUTE = 'data-csv-href';
/** Attribute carrying a tracker item id; read by the delegated click handler. */
export const TRACKER_CELL_ATTRIBUTE = 'data-csv-tracker-item';

/**
 * Render a `url` cell. Values that are not plausible links fall back to plain
 * text — a note typed into a link column should not look like a dead link.
 */
export function renderUrlCell(h: HyperFunc, value: string | number | null): unknown {
  const link = parseUrlCell(value);
  if (!link) return h('span', {}, String(value ?? ''));

  return h(
    'span',
    {
      class: 'csv-url-cell',
      title: link.href,
      [URL_CELL_ATTRIBUTE]: link.href,
    },
    link.label,
  );
}

/**
 * Render a cell as its formatted text. A HYPERLINK result is a link whatever
 * the column format, so a Cmd+K link in an ordinary cell clicks like a url cell.
 */
export function renderValueCell(h: HyperFunc, value: string | number | null, format: ColumnFormat | undefined): unknown {
  if (format?.type === 'url' || shownValue(value) !== value) return renderUrlCell(h, value);
  return h('span', {}, cellDisplayText(value, format));
}

/**
 * Render a `tracker` cell as a live chip: status dot, issue key, and the title
 * resolved from the host's tracker store. An unresolved key (not synced, or
 * from another workspace) degrades to the bare key rather than disappearing.
 */
export function renderTrackerCell(
  h: HyperFunc,
  value: string | number | null,
  store: TrackerResolutionStore,
): unknown {
  const key = parseTrackerCell(value);
  if (!key) return h('span', {}, String(value ?? ''));

  const resolution = store.read(key);
  if (!resolution) {
    return h('span', { class: 'csv-tracker-cell csv-tracker-cell-unresolved', title: key }, key);
  }

  const tone = trackerStatusTone(resolution.status);
  return h(
    'span',
    {
      class: 'csv-tracker-cell',
      title: resolution.title ? `${key} — ${resolution.title}` : key,
      [TRACKER_CELL_ATTRIBUTE]: resolution.itemId,
    },
    [
      h('span', { class: `csv-tracker-status csv-tracker-status-${tone}` }, ''),
      h('span', { class: 'csv-tracker-key' }, key),
      h('span', { class: 'csv-tracker-title' }, resolution.title ?? ''),
    ],
  );
}

/** Attribute on a dropdown chip; the delegated handler opens the option list. */
export const LIST_CELL_ATTRIBUTE = 'data-csv-list';
/** Attribute on a checkbox cell; the delegated handler toggles it. */
export const CHECKBOX_CELL_ATTRIBUTE = 'data-csv-checkbox';

/**
 * A dropdown-validated cell: the value as a colored pill with a caret, or an
 * empty caret target when blank. The pill takes the matching option's color;
 * a value that is not an option keeps the neutral tone (and the cell gets the
 * invalid marker from `cellProperties`).
 */
export function renderListCell(h: HyperFunc, value: string, options: readonly ListOption[]): unknown {
  const option = options.find((candidate) => candidate.value === value.trim());
  const tone = option?.color && option.color !== 'default' ? option.color : 'neutral';
  const caret = h('span', { class: 'csv-chip-caret' }, '▾');
  if (value.trim() === '') {
    return h('span', { class: 'csv-list-cell csv-list-cell-empty', [LIST_CELL_ATTRIBUTE]: '1' }, [caret]);
  }
  return h('span', { class: 'csv-list-cell', [LIST_CELL_ATTRIBUTE]: '1' }, [
    h('span', { class: `csv-chip csv-chip-${tone}` }, [h('span', { class: 'csv-chip-label' }, value), caret]),
  ]);
}

/** A checkbox-validated cell. The stored value stays the rule's checked/unchecked text. */
export function renderCheckboxCell(h: HyperFunc, checked: boolean): unknown {
  return h('span', {
    class: checked ? 'csv-checkbox-cell csv-checkbox-checked' : 'csv-checkbox-cell',
    role: 'checkbox',
    'aria-checked': checked ? 'true' : 'false',
    [CHECKBOX_CELL_ATTRIBUTE]: '1',
  }, checked ? '✓' : '');
}
