import type { TrackerRecord } from '../../core/TrackerRecord';
import {
  getRecordPriority,
  getRecordStatus,
  getFieldByRole,
} from './trackerRecordAccessors';

export type TrackerGroupBy = 'none' | 'status' | 'priority' | 'assignee' | 'owner' | 'type' | 'tag';

export interface TrackerGroup {
  /** 分组键：字段值本身；空值桶使用 `''`。 */
  key: string;
  label: string;
  items: TrackerRecord[];
}

export function normalizeTrackerGroupBy(value: string | null | undefined): TrackerGroupBy {
  switch (value) {
    case 'status':
    case 'priority':
    case 'assignee':
    case 'owner':
    case 'type':
    case 'tag':
      return value;
    default:
      return 'none';
  }
}

function titleCase(value: string): string {
  return value
    .split('-')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function normalizeTrackerTagList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  return [];
}

function getTrackerItemTags(item: TrackerRecord): string[] {
  return normalizeTrackerTagList(getFieldByRole(item, 'tags'));
}

function singleGroupValue(item: TrackerRecord, groupBy: Exclude<TrackerGroupBy, 'none' | 'tag'>): string {
  switch (groupBy) {
    case 'status':
      return (getRecordStatus(item) || '').toLowerCase();
    case 'priority':
      return (getRecordPriority(item) || '').toLowerCase();
    case 'type':
      return item.primaryType;
    case 'assignee':
    case 'owner':
      return ((getFieldByRole(item, 'assignee') as string | undefined) || '');
  }
}

/**
 * Tracker 表格和 saved view 共用的分组语义。
 * `owner` 是 Display Options 里的文案值，等价于 schema 的 assignee role。
 */
export function groupTrackerItems(items: TrackerRecord[], rawGroupBy: string | null | undefined): TrackerGroup[] {
  const groupBy = normalizeTrackerGroupBy(rawGroupBy);

  if (groupBy === 'none') {
    return [{ key: '', label: 'All', items }];
  }

  if (groupBy === 'tag') {
    const byTag = new Map<string, TrackerRecord[]>();
    const order: string[] = [];
    const untagged: TrackerRecord[] = [];
    for (const item of items) {
      const tags = Array.from(new Set(getTrackerItemTags(item)));
      if (tags.length === 0) {
        untagged.push(item);
        continue;
      }
      for (const tag of tags) {
        const bucket = byTag.get(tag);
        if (bucket) bucket.push(item);
        else {
          byTag.set(tag, [item]);
          order.push(tag);
        }
      }
    }
    const groups: TrackerGroup[] = order.map((tag) => ({ key: tag, label: `#${tag}`, items: byTag.get(tag)! }));
    if (untagged.length > 0) groups.push({ key: '', label: 'Untagged', items: untagged });
    return groups;
  }

  const buckets = new Map<string, TrackerRecord[]>();
  const order: string[] = [];
  for (const item of items) {
    const value = singleGroupValue(item, groupBy);
    const bucket = buckets.get(value);
    if (bucket) bucket.push(item);
    else {
      buckets.set(value, [item]);
      order.push(value);
    }
  }

  const emptyLabel = groupBy === 'assignee' || groupBy === 'owner' ? 'Unassigned' : 'None';
  const nonEmpty = order.filter((v) => v !== '');
  const groups: TrackerGroup[] = nonEmpty.map((value) => ({
    key: value,
    label: groupBy === 'type' || groupBy === 'assignee' || groupBy === 'owner' ? value : titleCase(value),
    items: buckets.get(value)!,
  }));
  if (buckets.has('')) {
    groups.push({ key: '', label: emptyLabel, items: buckets.get('')! });
  }
  return groups;
}
