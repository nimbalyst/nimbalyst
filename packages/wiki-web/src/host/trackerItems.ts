/**
 * Library tracker items as the tracker UI reads them, and UI writes back as the
 * library stores them.
 *
 * The library keeps a relationship field as the target's bare id (a list of ids
 * when multi-valued), because that is what a CSV cell or a frontmatter key can
 * hold. The UI expects `{ itemId, title, trackerType }`, so reads enrich ids
 * against every item the wiki holds, and writes reduce values back to ids.
 */
import type { TrackerItem } from '@nimbalyst/collab-bundle/trackers-ui';
import type { LocalTrackerItem } from '@nimbalyst/local-wiki';
import type { WikiTypeInfo } from '../api/client';

/** Keys `TrackerItem` carries itself; every other field is a custom field. */
const ITEM_FIELD_KEYS = new Set(['title', 'status', 'priority', 'description', 'tags']);

export interface RelationshipRef {
  itemId: string;
  title?: string;
  trackerType?: string;
}

export type ItemLookup = ReadonlyMap<string, { title: string; type: string }>;

function relationshipFields(def: WikiTypeInfo | undefined): Map<string, boolean> {
  return new Map((def?.fields ?? []).filter((field) => field.type === 'relationship').map((field) => [field.name, field.multiValue === true]));
}

function enrich(value: unknown, lookup: ItemLookup): RelationshipRef | unknown {
  if (typeof value !== 'string' || !value) return value;
  const target = lookup.get(value);
  return target ? { itemId: value, title: target.title, trackerType: target.type } : { itemId: value };
}

/** A relationship value as the UI shows it: one ref, or a list when multi-valued. */
export function enrichRelationship(value: unknown, multiValue: boolean, lookup: ItemLookup): unknown {
  if (value === null || value === undefined || value === '') return multiValue ? [] : undefined;
  if (Array.isArray(value)) {
    const refs = value.map((entry) => enrich(entry, lookup));
    return multiValue ? refs : refs[0];
  }
  const ref = enrich(value, lookup);
  return multiValue ? [ref] : ref;
}

function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (value && typeof value === 'object' && typeof (value as RelationshipRef).itemId === 'string') return (value as RelationshipRef).itemId;
  return null;
}

/** A relationship value from the UI as the library stores it: an id, a list of ids, or null to clear. */
export function relationshipToStored(value: unknown, multiValue: boolean): string | string[] | null {
  if (value === null || value === undefined) return null;
  const ids = (Array.isArray(value) ? value : [value]).map(idOf).filter((id): id is string => id !== null);
  if (multiValue) return ids.length > 0 ? ids : null;
  return ids[0] ?? null;
}

export function toTrackerItem(item: LocalTrackerItem, def: WikiTypeInfo | undefined, lookup: ItemLookup, workspace: string): TrackerItem {
  const relations = relationshipFields(def);
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item.fields)) {
    fields[key] = relations.has(key) ? enrichRelationship(value, relations.get(key)!, lookup) : value;
  }
  const customFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ITEM_FIELD_KEYS.has(key)) customFields[key] = value;
  }
  // A table type's title column is a field like any other; the UI reads `title`.
  if (def && def.titleField !== 'title') delete customFields[def.titleField];
  return {
    id: item.id,
    type: item.type,
    typeTags: [item.type],
    title: item.title,
    status: typeof fields.status === 'string' ? fields.status : '',
    priority: typeof fields.priority === 'string' ? (fields.priority as TrackerItem['priority']) : undefined,
    description: typeof fields.description === 'string' ? fields.description : undefined,
    tags: Array.isArray(fields.tags) ? fields.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
    module: '',
    workspace,
    created: new Date(item.createdAt).toISOString(),
    updated: new Date(item.updatedAt).toISOString(),
    lastIndexed: new Date(item.updatedAt),
    archived: false,
    customFields,
  } as TrackerItem;
}

/**
 * An update from the UI as library field writes. `title` is written to the
 * type's title column for a table type, and relationship refs become ids.
 */
export function toStoredUpdates(updates: Record<string, unknown>, def: WikiTypeInfo | undefined): Record<string, unknown> {
  const relations = relationshipFields(def);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    const target = key === 'title' && def?.storage === 'table' ? def.titleField : key;
    out[target] = relations.has(key) ? relationshipToStored(value, relations.get(key)!) : value;
  }
  return out;
}
