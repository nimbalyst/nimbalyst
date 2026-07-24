import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { getFieldByRole } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';

export interface TrackerTagOption {
  name: string;
  count: number;
}

export function normalizeTrackerTagList(value: unknown): string[] {
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

export function getTrackerItemTags(item: TrackerRecord): string[] {
  return normalizeTrackerTagList(getFieldByRole(item, 'tags'));
}

export function buildTrackerTagOptions(items: TrackerRecord[]): TrackerTagOption[] {
  const counts = new Map<string, number>();

  for (const item of items) {
    const uniqueTags = new Set(getTrackerItemTags(item));
    for (const tag of uniqueTags) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });
}

export function filterTrackerItemsByTags(items: TrackerRecord[], activeTags: string[]): TrackerRecord[] {
  if (activeTags.length === 0) return items;

  const activeSet = new Set(activeTags);
  return items.filter((item) => getTrackerItemTags(item).some((tag) => activeSet.has(tag)));
}

/**
 * A single column of the tag board (NIM-774). `tag` is the tag name the column
 * represents, or `null` for the trailing "Untagged" bucket.
 */
export interface TrackerTagBoardColumn {
  tag: string | null;
  label: string;
  items: TrackerRecord[];
}

/**
 * Group items into tag-board columns. Each distinct tag (from the schema `tags`
 * role / array field) becomes a column; an item carrying multiple tags appears
 * in every matching column. Columns are ordered by item count (desc) then tag
 * name (asc) to keep the busiest tags first and the order stable. Items with no
 * tags collect into a trailing "Untagged" column, which is omitted entirely when
 * every item is tagged.
 */
export function groupTrackerItemsByTag(items: TrackerRecord[]): TrackerTagBoardColumn[] {
  const byTag = new Map<string, TrackerRecord[]>();
  const untagged: TrackerRecord[] = [];

  for (const item of items) {
    const uniqueTags = Array.from(new Set(getTrackerItemTags(item)));
    if (uniqueTags.length === 0) {
      untagged.push(item);
      continue;
    }
    for (const tag of uniqueTags) {
      const bucket = byTag.get(tag);
      if (bucket) bucket.push(item);
      else byTag.set(tag, [item]);
    }
  }

  const columns: TrackerTagBoardColumn[] = Array.from(byTag.entries())
    .map(([tag, tagItems]) => ({ tag, label: tag, items: tagItems }))
    .sort((a, b) => {
      if (b.items.length !== a.items.length) return b.items.length - a.items.length;
      return a.label.localeCompare(b.label);
    });

  if (untagged.length > 0) {
    columns.push({ tag: null, label: 'Untagged', items: untagged });
  }

  return columns;
}
