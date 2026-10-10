/**
 * A query chart's rows: the view's items bucketed by one field (a select,
 * person, yes/no or date field; dates by month), each bucket counting its
 * items or summing a number field. The rows feed the same small chart spec a
 * ```chart fence compiles, so both draw through one renderer.
 *
 * Values are read through `getTrackerFilterValue`, the accessor filters use,
 * so system fields (created, updated, owner) chart the same value a filter on
 * them matches. Buckets are keyed by stable identity (an option's value, a
 * person's email, a month) and labeled separately; two buckets that would
 * share a label are told apart rather than merged.
 */

import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { ChartRow } from '@nimbalyst/runtime/ui/chart/chartSpec';
import { getTrackerFilterValue } from '../../trackers';

/**
 * Row keys for the category and the measure. Tracker field names cannot start
 * with `@`, so a schema field (even one named `count`) never collides with them.
 */
export const CHART_CATEGORY = '@category';
export const CHART_VALUE = '@value';

/** The part of a filter-catalog field the bucketing reads. */
export interface ChartGroupField {
  id: string;
  type?: string;
  options?: ReadonlyArray<string | { value: string; label?: string }>;
}

export interface ChartQuery {
  by: ChartGroupField;
  /** A number field to sum; counts items when absent. */
  sum?: string;
}

export const NO_VALUE_LABEL = '(none)';

interface Bucket {
  key: string;
  label: string;
  /** Shown after the label when another bucket has the same label. */
  detail: string;
}

const PLAIN_DATE = /^(\d{4}-\d{2})-\d{2}$/;

function optionValue(option: string | { value: string; label?: string }): string {
  return typeof option === 'string' ? option : option.value;
}

/**
 * The month a date value falls in. A plain calendar date (`YYYY-MM-DD`) has no
 * time zone and keeps its own month. A datetime (an ISO string with a time,
 * a `Date`, or epoch milliseconds) names an instant, which is bucketed in the
 * viewer's local time zone -- the month the viewer would say it happened in.
 */
function monthOf(value: unknown): string | null {
  if (typeof value === 'string') {
    const plain = PLAIN_DATE.exec(value.trim());
    if (plain) return plain[1];
  }
  const instant = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  if (!instant || Number.isNaN(instant.getTime())) return null;
  return `${instant.getFullYear()}-${String(instant.getMonth() + 1).padStart(2, '0')}`;
}

function personOf(value: unknown): Bucket | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? { key: trimmed.toLowerCase(), label: trimmed, detail: trimmed } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const person = value as Record<string, unknown>;
  const text = (...keys: string[]) => keys.map((key) => person[key]).find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '')?.trim();
  const key = text('email', 'gitEmail', 'displayName', 'name', 'gitName');
  const label = text('displayName', 'name', 'email', 'gitName', 'gitEmail');
  return key && label ? { key: key.toLowerCase(), label, detail: key.toLowerCase() } : null;
}

function bucketOf(value: unknown, field: ChartGroupField): Bucket | null {
  if (value === undefined || value === null || value === '') return null;
  switch (field.type) {
    case 'boolean': {
      const yes = value === true || value === 'true';
      return { key: String(yes), label: yes ? 'Yes' : 'No', detail: String(yes) };
    }
    case 'date':
    case 'datetime': {
      const month = monthOf(value);
      return month ? { key: month, label: month, detail: month } : null;
    }
    case 'user':
      return personOf(value);
    default: {
      const raw = String(value);
      const option = field.options?.find((candidate) => optionValue(candidate) === raw);
      const label = option && typeof option === 'object' && option.label ? option.label : raw;
      return { key: raw, label, detail: raw };
    }
  }
}

function numberOf(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Buckets in a stable reading order: a select's option order, dates
 * ascending, anything else largest first. The no-value bucket goes last.
 */
export function chartData(records: readonly TrackerRecord[], query: ChartQuery): ChartRow[] {
  const totals = new Map<string, { bucket: Bucket; total: number }>();
  let empty: number | null = null;
  for (const record of records) {
    const bucket = bucketOf(getTrackerFilterValue(record, query.by.id), query.by);
    const amount = query.sum ? numberOf(getTrackerFilterValue(record, query.sum)) ?? 0 : 1;
    if (!bucket) {
      empty = (empty ?? 0) + amount;
      continue;
    }
    const entry = totals.get(bucket.key) ?? { bucket, total: 0 };
    entry.total += amount;
    totals.set(bucket.key, entry);
  }
  const entries = [...totals.values()];
  if (query.by.type === 'date' || query.by.type === 'datetime') {
    entries.sort((a, b) => a.bucket.key.localeCompare(b.bucket.key));
  } else if (query.by.options && query.by.type !== 'user') {
    const order = query.by.options.map(optionValue);
    const rank = (key: string) => {
      const index = order.indexOf(key);
      return index === -1 ? order.length : index;
    };
    entries.sort((a, b) => rank(a.bucket.key) - rank(b.bucket.key));
  } else {
    entries.sort((a, b) => b.total - a.total || a.bucket.label.localeCompare(b.bucket.label));
  }
  if (empty !== null) entries.push({ bucket: { key: '', label: NO_VALUE_LABEL, detail: 'no value' }, total: empty });
  const labelCounts = new Map<string, number>();
  for (const { bucket } of entries) labelCounts.set(bucket.label, (labelCounts.get(bucket.label) ?? 0) + 1);
  return entries.map(({ bucket, total }) => ({
    [CHART_CATEGORY]: (labelCounts.get(bucket.label) ?? 0) > 1 ? `${bucket.label} (${bucket.detail})` : bucket.label,
    [CHART_VALUE]: total,
  }));
}
