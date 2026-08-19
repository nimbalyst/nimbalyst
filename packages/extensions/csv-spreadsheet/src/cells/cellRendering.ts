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

import { parseTrackerCell, parseUrlCell } from '../utils/formatters';
import { trackerStatusTone, type TrackerResolutionStore } from './trackerResolution';

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
