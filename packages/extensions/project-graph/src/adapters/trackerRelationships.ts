/**
 * Recorded tracker-to-tracker relationships.
 *
 * Nimbalyst's relationships are field-backed: a tracker type declares fields of
 * type `relationship`, and an item's value for such a field is the set of items
 * it points at. Everything this module emits is a link somebody actually
 * recorded on an item. Nothing here infers a relation from tags, paths, titles,
 * or co-occurrence.
 *
 * Three properties of the real storage drive the implementation, all verified
 * against this workspace's database:
 *
 *  1. **Values are nested under `data.customFields.<field>`.** That is the
 *     durable form for any item that has ever synced; a top-level
 *     `data.<field>` is a legacy shadow the sync round-trip no longer
 *     maintains. Reading only the top level finds nothing for most items.
 *  2. **The same field NAME means different things on different types.**
 *     `bug.area` is a relationship to feature-module/product-feature;
 *     `github-issue.area` is the string `"performance"`. So the type's field
 *     DEFINITIONS decide what is a relationship, never the field name.
 *  3. **A value may omit its `relationshipTypeKey`.** Real `epic.children`
 *     entries carry only `itemId`/`issueKey`/`title`/`trackerType`; the field
 *     definition supplies the key.
 *
 * This is a small self-contained port of the shapes owned by
 * `@nimbalyst/tracker-core` and `collab-client/trackers/relationshipFieldStorage`.
 * An extension bundles independently and cannot import those, and this module
 * only READS — it never writes a relationship back, which is where the shared
 * helpers' inverse-propagation complexity lives.
 */
import type { EdgeType, ProjectGraphEdge } from '../types';
import { trackerNodeId, type TrackerRow } from './recordMapping';
import { parseJsonColumn } from './recordMapping';

export interface TrackerFieldDefinition {
  name: string;
  type: string;
  relationshipTypeKey?: string;
  inverseRelationshipTypeKey?: string;
  targetTrackerTypes?: string[] | '*';
  multiValue?: boolean;
}

export interface TrackerRelationshipValue {
  itemId: string;
  issueKey?: string;
  title?: string;
  trackerType?: string;
  relationshipTypeKey?: string;
  direction?: 'out';
}

/** True for a relationship field, including the legacy `reference` alias. */
export function isRelationshipField(def: TrackerFieldDefinition): boolean {
  return def.type === 'relationship' || def.type === 'reference';
}

export function relationshipFieldsOf(defs: readonly TrackerFieldDefinition[]): TrackerFieldDefinition[] {
  return defs.filter(isRelationshipField);
}

/**
 * Read a field value tolerant of both storage shapes. The nested `customFields`
 * value wins when present; otherwise fall back to the top-level value.
 */
export function readStoredFieldValue(
  data: Record<string, unknown> | null | undefined,
  name: string,
): unknown {
  const cf = data?.customFields;
  if (cf && typeof cf === 'object' && !Array.isArray(cf)) {
    const bag = cf as Record<string, unknown>;
    if (name in bag && bag[name] !== undefined) return bag[name];
  }
  return data?.[name];
}

/**
 * Coerce a stored value into normalized relationship entries. Tolerant of a
 * bare object (a single-value field), a bare string (the oldest shape), and a
 * mixed array, so reading a pre-existing value never throws.
 */
export function normalizeRelationshipValue(raw: unknown): TrackerRelationshipValue[] {
  const list: unknown[] = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const byId = new Map<string, TrackerRelationshipValue>();
  for (const entry of list) {
    const value = coerce(entry);
    if (value) byId.set(value.itemId, value);
  }
  return [...byId.values()];
}

function coerce(entry: unknown): TrackerRelationshipValue | null {
  if (typeof entry === 'string') return entry ? { itemId: entry } : null;
  if (!entry || typeof entry !== 'object') return null;
  const o = entry as Record<string, unknown>;
  const itemId = typeof o.itemId === 'string' ? o.itemId : typeof o.id === 'string' ? o.id : '';
  if (!itemId) return null;
  const value: TrackerRelationshipValue = { itemId };
  if (typeof o.issueKey === 'string') value.issueKey = o.issueKey;
  if (typeof o.title === 'string') value.title = o.title;
  if (typeof o.trackerType === 'string') value.trackerType = o.trackerType;
  if (typeof o.relationshipTypeKey === 'string') value.relationshipTypeKey = o.relationshipTypeKey;
  if (o.direction === 'out') value.direction = 'out';
  return value;
}

/**
 * How each relationship key maps onto the graph's structural edge vocabulary.
 *
 * `reverse` means the recorded direction and the edge direction differ: an item
 * that records `blocks: [x]` is asserting that **x** is blocked, so the edge
 * runs x -> owner. Getting this wrong inverts a dependency, which is worse than
 * not drawing it.
 *
 * A key with no entry here is NOT dropped and NOT relabelled — it becomes a
 * `related_to` edge that still carries the exact key as its label and basis.
 * The alternative, silently mapping an unknown key onto a structural meaning,
 * would be exactly the inference this layer is supposed to avoid.
 */
const RELATION_EDGE_MAP: Record<string, { type: EdgeType; reverse?: boolean }> = {
  'depends-on': { type: 'depends_on' },
  blocks: { type: 'blocked_by', reverse: true },
  'parent-of': { type: 'contains' },
  'child-of': { type: 'part_of' },
  'has-item': { type: 'contains' },
  'in-collection': { type: 'part_of' },
  'contributes-to': { type: 'part_of' },
  'contributed-by': { type: 'contains' },
  'relates-to': { type: 'related_to' },
  duplicates: { type: 'related_to' },
  supersedes: { type: 'related_to' },
};

/**
 * Every recorded relationship on one tracker row, as graph edges.
 *
 * `fieldDefs` must be the field definitions for THIS row's tracker type. Pass
 * an empty list and nothing is emitted, which is the correct answer for a type
 * whose schema could not be read — a guess would produce phantom edges.
 */
export function trackerRelationshipEdges(
  row: TrackerRow,
  fieldDefs: readonly TrackerFieldDefinition[],
): ProjectGraphEdge[] {
  const data = parseJsonColumn(row.data);
  const ownerId = trackerNodeId(row.id);
  const out: ProjectGraphEdge[] = [];
  const seen = new Set<string>();

  for (const def of relationshipFieldsOf(fieldDefs)) {
    for (const value of normalizeRelationshipValue(readStoredFieldValue(data, def.name))) {
      // A self-link carries no information and would draw a loop on the record.
      if (value.itemId === row.id) continue;
      const targetId = trackerNodeId(value.itemId);
      // The value's own key wins when present; otherwise the field definition
      // is the recorded key for every value in that field.
      const key = value.relationshipTypeKey ?? def.relationshipTypeKey ?? 'related-to';
      const mapping = RELATION_EDGE_MAP[key] ?? { type: 'related_to' as EdgeType };
      const [sourceId, edgeTargetId] = mapping.reverse ? [targetId, ownerId] : [ownerId, targetId];
      const id = `${ownerId}=>${def.name}:${key}=>${targetId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        type: mapping.type,
        sourceId,
        targetId: edgeTargetId,
        // The exact recorded key, never the structural bucket it mapped onto.
        label: key,
        provenance: {
          kind: 'recorded',
          basis:
            `Recorded on ${row.issue_key ?? row.id} in the "${def.name}" relationship field ` +
            `as "${key}".`,
        },
      });
    }
  }

  return out;
}
