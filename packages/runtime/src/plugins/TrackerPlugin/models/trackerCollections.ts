/**
 * Collection (milestone / release) membership and rollups.
 *
 * A collection is an ordinary tracker item whose `items` relationship field
 * holds its members; each member carries the inverse `collection` field. This
 * module owns the pure logic -- which types are collections, how to add/remove a
 * member, and how to roll member statuses up into a progress summary -- so the
 * grid, detail panel, CLI, and MCP tools all agree.
 *
 * Rollups are computed from a single pass over the already-loaded records. Never
 * fetch per member: a collection with 200 items would otherwise issue 200
 * queries every time its row painted.
 */

import type { TrackerRecord } from '../../../core/TrackerRecord';
import type { FieldDefinition, TrackerRelationshipValue } from './TrackerDataModel';
import { globalRegistry } from './TrackerDataModel';
import {
  normalizeRelationshipValue,
  isRelationshipField,
} from './trackerRelationships';

/** Relationship key a collection uses to point at its members. */
export const COLLECTION_MEMBER_KEY = 'has-item';
/** Relationship key a member uses to point back at its collection. */
export const COLLECTION_INVERSE_KEY = 'in-collection';

/** Built-in tracker types that behave as collections. */
export const COLLECTION_TYPES = ['milestone', 'release'] as const;
export type CollectionType = (typeof COLLECTION_TYPES)[number];

/**
 * Whether a tracker type is a collection.
 *
 * Determined by schema shape (does it own a `has-item` relationship field?) so a
 * user-defined type modeling its own sprint concept rolls up too; the built-in
 * list is only the fallback for types not in the registry.
 */
export function isCollectionType(type: string): boolean {
  const model = globalRegistry.get(type);
  if (!model) return (COLLECTION_TYPES as readonly string[]).includes(type);
  return model.fields.some(
    f => isRelationshipField(f) && f.relationshipTypeKey === COLLECTION_MEMBER_KEY,
  );
}

/** The field holding a collection's members, if the type has one. */
export function getMembersField(type: string): FieldDefinition | undefined {
  return globalRegistry
    .get(type)
    ?.fields.find(f => isRelationshipField(f) && f.relationshipTypeKey === COLLECTION_MEMBER_KEY);
}

/** The field on a member pointing back at its collection(s), if declared. */
export function getCollectionField(type: string): FieldDefinition | undefined {
  return globalRegistry
    .get(type)
    ?.fields.find(f => isRelationshipField(f) && f.relationshipTypeKey === COLLECTION_INVERSE_KEY);
}

/** Member item ids of a collection record, deduped and in stored order. */
export function getMemberIds(collection: TrackerRecord): string[] {
  const field = getMembersField(collection.primaryType);
  if (!field) return [];
  return normalizeRelationshipValue(collection.fields[field.name]).map(v => v.itemId);
}

/**
 * The relationship value to write when adding `members` to `collection`.
 * Add-wins set semantics: existing members are preserved and duplicates collapse.
 */
export function addMembersValue(
  collection: TrackerRecord,
  members: TrackerRecord[],
): TrackerRelationshipValue[] {
  const field = getMembersField(collection.primaryType);
  if (!field) return [];

  const byId = new Map<string, TrackerRelationshipValue>(
    normalizeRelationshipValue(collection.fields[field.name]).map(v => [v.itemId, v]),
  );
  for (const member of members) {
    // Skip self-links -- a collection can never be its own member.
    if (member.id === collection.id) continue;
    byId.set(member.id, {
      itemId: member.id,
      direction: 'out',
      relationshipTypeKey: COLLECTION_MEMBER_KEY,
      ...(member.issueKey ? { issueKey: member.issueKey } : {}),
      ...(member.fields.title ? { title: String(member.fields.title) } : {}),
      trackerType: member.primaryType,
    });
  }
  return [...byId.values()];
}

/** The relationship value to write when removing member ids from a collection. */
export function removeMembersValue(
  collection: TrackerRecord,
  memberIds: string[],
): TrackerRelationshipValue[] {
  const field = getMembersField(collection.primaryType);
  if (!field) return [];
  const drop = new Set(memberIds);
  return normalizeRelationshipValue(collection.fields[field.name]).filter(v => !drop.has(v.itemId));
}

export interface CollectionRollup {
  /** Members referenced by the collection, including any not currently loaded. */
  total: number;
  /** Members that were resolvable in the provided record set. */
  resolved: number;
  /** Member count per workflow status. */
  byStatus: Record<string, number>;
  /** Members in a terminal status. */
  done: number;
  /** `done / resolved` as a 0-100 integer; 0 when nothing is resolved. */
  percentComplete: number;
}

/** Statuses that count as finished for progress purposes. */
const TERMINAL_STATUSES = new Set(['done', 'released', 'cancelled', 'resolved', 'closed', 'approved']);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Roll a collection's members up into counts and a progress percentage.
 *
 * `itemsById` must be a prebuilt index of every candidate member -- build it
 * once for the whole view, not once per collection, so rendering N collections
 * stays O(total members) rather than O(N * all items).
 */
export function computeCollectionRollup(
  collection: TrackerRecord,
  itemsById: ReadonlyMap<string, TrackerRecord>,
  getStatus: (record: TrackerRecord) => string,
): CollectionRollup {
  const memberIds = getMemberIds(collection);
  const byStatus: Record<string, number> = {};
  let resolved = 0;
  let done = 0;

  for (const id of memberIds) {
    const member = itemsById.get(id);
    // An unresolved id is a member we simply haven't loaded (filtered out, or on
    // another machine). Count it in `total` but never in the progress math, so
    // partial data can't report false completion.
    if (!member) continue;
    resolved++;
    const status = getStatus(member) || 'to-do';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (isTerminalStatus(status)) done++;
  }

  return {
    total: memberIds.length,
    resolved,
    byStatus,
    done,
    percentComplete: resolved === 0 ? 0 : Math.round((done / resolved) * 100),
  };
}

/**
 * Roll up many collections in one pass.
 * Builds the member index once and reuses it for every collection.
 */
export function computeCollectionRollups(
  collections: TrackerRecord[],
  allItems: TrackerRecord[],
  getStatus: (record: TrackerRecord) => string,
): Map<string, CollectionRollup> {
  const itemsById = new Map<string, TrackerRecord>();
  for (const item of allItems) itemsById.set(item.id, item);

  const result = new Map<string, CollectionRollup>();
  for (const collection of collections) {
    result.set(collection.id, computeCollectionRollup(collection, itemsById, getStatus));
  }
  return result;
}
