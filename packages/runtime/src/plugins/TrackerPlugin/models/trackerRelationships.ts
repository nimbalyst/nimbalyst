/**
 * Relationship field value model (Epic C, Phase 1).
 *
 * Relationships are field-backed: a relationship value lives inside the owning
 * tracker item's `fields` bag and syncs on the metadata socket exactly like
 * `labels` (see tracker-relationships-design.md). This module owns the PURE
 * value-model logic — vocabulary, normalize, validate, add/remove — so the
 * service layer, MCP tools, and UI all agree and it is unit-testable without a
 * DB. No I/O here.
 */

import type { FieldDefinition, TrackerRelationshipValue } from './TrackerDataModel';

/** A relationship vocabulary entry (label + behavior hints for a field). */
export interface TrackerRelationshipType {
  key: string;
  displayName: string;
  inverseKey?: string;
  inverseDisplayName?: string;
  category: 'dependency' | 'hierarchy' | 'reference' | 'governance' | 'custom';
  symmetric?: boolean;
  color?: string;
  icon?: string;
  description?: string;
}

/** Built-in relationship vocabulary. Custom keys may be added per workspace. */
export const BUILTIN_RELATIONSHIP_TYPES: TrackerRelationshipType[] = [
  { key: 'depends-on', displayName: 'Depends on', inverseKey: 'blocks', inverseDisplayName: 'Blocks', category: 'dependency' },
  { key: 'blocks', displayName: 'Blocks', inverseKey: 'depends-on', inverseDisplayName: 'Depends on', category: 'dependency' },
  { key: 'relates-to', displayName: 'Relates to', category: 'reference', symmetric: true },
  { key: 'duplicates', displayName: 'Duplicates', category: 'reference' },
  { key: 'supersedes', displayName: 'Supersedes', category: 'reference' },
  { key: 'parent-of', displayName: 'Parent of', inverseKey: 'child-of', inverseDisplayName: 'Child of', category: 'hierarchy' },
  { key: 'child-of', displayName: 'Child of', inverseKey: 'parent-of', inverseDisplayName: 'Parent of', category: 'hierarchy' },
];

const BUILTIN_BY_KEY = new Map(BUILTIN_RELATIONSHIP_TYPES.map((t) => [t.key, t]));

/** Look up a relationship type from the built-in vocabulary (+ optional custom). */
export function resolveRelationshipType(
  key: string | undefined,
  custom?: TrackerRelationshipType[],
): TrackerRelationshipType | undefined {
  if (!key) return undefined;
  return custom?.find((t) => t.key === key) ?? BUILTIN_BY_KEY.get(key);
}

/** True if a field definition is a relationship field (incl. the legacy alias). */
export function isRelationshipField(def: Pick<FieldDefinition, 'type'>): boolean {
  return def.type === 'relationship' || def.type === 'reference';
}

/**
 * Coerce a raw stored value (object, array, or null/undefined) into a normalized
 * array of relationship values, deduped by `itemId` (last write wins for the
 * denormalized display fields). Tolerant of legacy/string-y shapes so reading a
 * pre-existing `reference` value never throws.
 */
export function normalizeRelationshipValue(raw: unknown): TrackerRelationshipValue[] {
  const list: unknown[] = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const byId = new Map<string, TrackerRelationshipValue>();
  for (const entry of list) {
    const v = coerceOne(entry);
    if (v) byId.set(v.itemId, v);
  }
  return [...byId.values()];
}

function coerceOne(entry: unknown): TrackerRelationshipValue | null {
  if (typeof entry === 'string') {
    return entry ? { itemId: entry } : null;
  }
  if (entry && typeof entry === 'object') {
    const o = entry as Record<string, unknown>;
    const itemId = typeof o.itemId === 'string' ? o.itemId : typeof o.id === 'string' ? o.id : '';
    if (!itemId) return null;
    const out: TrackerRelationshipValue = { itemId };
    if (typeof o.issueKey === 'string') out.issueKey = o.issueKey;
    if (typeof o.title === 'string') out.title = o.title;
    if (typeof o.trackerType === 'string') out.trackerType = o.trackerType;
    if (typeof o.relationshipTypeKey === 'string') out.relationshipTypeKey = o.relationshipTypeKey;
    if (o.direction === 'out') out.direction = 'out';
    if (o.metadata && typeof o.metadata === 'object') out.metadata = o.metadata as Record<string, unknown>;
    return out;
  }
  return null;
}

export interface RelationshipValidationContext {
  /** The item the relationship field belongs to (to reject self-links). */
  sourceItemId: string;
  /** Resolver: tracker type for a target item id (for target-type compat checks). */
  targetTypeOf?: (itemId: string) => string | undefined;
}

export interface RelationshipValidationError {
  code: 'self-link' | 'duplicate' | 'too-many' | 'target-type' | 'empty-target';
  itemId?: string;
  message: string;
}

/**
 * Validate a proposed normalized value against the field definition + context.
 * Returns all violations (empty = valid). Pure.
 */
export function validateRelationshipValue(
  def: FieldDefinition,
  values: TrackerRelationshipValue[],
  ctx: RelationshipValidationContext,
): RelationshipValidationError[] {
  const errors: RelationshipValidationError[] = [];

  if (!def.multiValue && values.length > 1) {
    errors.push({ code: 'too-many', message: `Field "${def.name}" is single-value but got ${values.length} targets` });
  }

  const seen = new Set<string>();
  for (const v of values) {
    if (!v.itemId) {
      errors.push({ code: 'empty-target', message: 'Relationship target is missing an itemId' });
      continue;
    }
    if (seen.has(v.itemId)) {
      errors.push({ code: 'duplicate', itemId: v.itemId, message: `Duplicate target ${v.itemId}` });
    }
    seen.add(v.itemId);

    if (v.itemId === ctx.sourceItemId && !def.allowSelfLink) {
      errors.push({ code: 'self-link', itemId: v.itemId, message: 'An item cannot link to itself on this field' });
    }

    if (def.targetTrackerTypes && def.targetTrackerTypes !== '*') {
      const targetType = v.trackerType ?? ctx.targetTypeOf?.(v.itemId);
      if (targetType && !def.targetTrackerTypes.includes(targetType)) {
        errors.push({
          code: 'target-type',
          itemId: v.itemId,
          message: `Target ${v.itemId} is "${targetType}", not one of ${def.targetTrackerTypes.join(', ')}`,
        });
      }
    }
  }

  return errors;
}

/**
 * Add a target to a relationship field's current value (add-wins set; dedup by
 * itemId). For a single-value field, the new target REPLACES the existing one.
 * Returns the new normalized array; does not mutate inputs.
 */
export function addRelationshipValue(
  def: FieldDefinition,
  current: unknown,
  target: TrackerRelationshipValue,
): TrackerRelationshipValue[] {
  const stamped: TrackerRelationshipValue = {
    direction: 'out',
    ...(def.relationshipTypeKey ? { relationshipTypeKey: def.relationshipTypeKey } : {}),
    ...target,
  };
  if (!def.multiValue) return [stamped];
  const existing = normalizeRelationshipValue(current).filter((v) => v.itemId !== target.itemId);
  return [...existing, stamped];
}

/** Remove a target by itemId. Returns the new normalized array. */
export function removeRelationshipValue(current: unknown, itemId: string): TrackerRelationshipValue[] {
  return normalizeRelationshipValue(current).filter((v) => v.itemId !== itemId);
}

/**
 * Serialize a relationship value for storage in the item `fields` bag: a single
 * object (or null) for single-value fields, an array for multi-value fields.
 */
export function serializeRelationshipValue(
  def: FieldDefinition,
  values: TrackerRelationshipValue[],
): TrackerRelationshipValue | TrackerRelationshipValue[] | null {
  if (def.multiValue) return values;
  return values[0] ?? null;
}

/** One derived edge for the local `tracker_relationship_index` projection. */
export interface RelationshipEdge {
  sourceItemId: string;
  sourceFieldId: string;
  relationshipTypeKey?: string;
  targetItemId: string;
  targetTrackerType?: string;
  metadata?: Record<string, unknown>;
}

/** A minimal reference to the source item, stamped onto a target's inverse field. */
export interface InverseSourceRef {
  itemId: string;
  issueKey?: string;
  title?: string;
  trackerType?: string;
}

/** One inverse-field mutation to apply to a target item (Phase 3). */
export interface InverseFieldDelta {
  /** The target item whose inverse field changes. */
  targetItemId: string;
  /** The field name on the target type that holds the inverse value. */
  inverseFieldId: string;
  /** Add (source now links to target) or remove (link was dropped). */
  op: 'add' | 'remove';
  /** The value (referencing the SOURCE item) to add/remove on the target. */
  value: TrackerRelationshipValue;
}

/**
 * Compute the inverse-field mutations for ONE relationship field after a source
 * item's value changed from `prev` to `next` (Phase 3 bidirectional write).
 *
 * Returns [] unless the field declares an `inverseFieldId` — only then is the
 * inverse materialized as a real field on the target. Added targets get an `add`
 * delta; dropped targets get a `remove`. The stamped value references the source
 * item and carries the field's `inverseRelationshipTypeKey` so the target pill
 * reads in the right direction (e.g. source `depends-on` → target `blocks`).
 *
 * Pure: the caller persists the result through the synced write path.
 */
export function computeInverseFieldDeltas(
  def: FieldDefinition,
  source: InverseSourceRef,
  prev: unknown,
  next: unknown,
): InverseFieldDelta[] {
  if (!def.inverseFieldId) return [];
  const prevIds = new Set(normalizeRelationshipValue(prev).map((v) => v.itemId));
  const nextIds = new Set(normalizeRelationshipValue(next).map((v) => v.itemId));

  const value: TrackerRelationshipValue = {
    itemId: source.itemId,
    direction: 'out',
    ...(source.issueKey ? { issueKey: source.issueKey } : {}),
    ...(source.title ? { title: source.title } : {}),
    ...(source.trackerType ? { trackerType: source.trackerType } : {}),
    ...(def.inverseRelationshipTypeKey ? { relationshipTypeKey: def.inverseRelationshipTypeKey } : {}),
  };

  const deltas: InverseFieldDelta[] = [];
  for (const targetItemId of nextIds) {
    if (!prevIds.has(targetItemId)) {
      deltas.push({ targetItemId, inverseFieldId: def.inverseFieldId, op: 'add', value });
    }
  }
  for (const targetItemId of prevIds) {
    if (!nextIds.has(targetItemId)) {
      deltas.push({ targetItemId, inverseFieldId: def.inverseFieldId, op: 'remove', value });
    }
  }
  return deltas;
}

/**
 * Derive the outgoing relationship edges for one item from its `fields` bag and
 * its schema's field definitions. Pure: the index store persists the result.
 * Every relationship-typed field contributes one edge per (deduped) target.
 */
export function deriveRelationshipEdges(
  sourceItemId: string,
  fields: Record<string, unknown> | undefined,
  fieldDefs: FieldDefinition[],
): RelationshipEdge[] {
  if (!fields) return [];
  const edges: RelationshipEdge[] = [];
  for (const def of fieldDefs) {
    if (!isRelationshipField(def)) continue;
    const values = normalizeRelationshipValue(fields[def.name]);
    for (const v of values) {
      if (!v.itemId) continue;
      edges.push({
        sourceItemId,
        sourceFieldId: def.name,
        relationshipTypeKey: v.relationshipTypeKey ?? def.relationshipTypeKey,
        targetItemId: v.itemId,
        targetTrackerType: v.trackerType,
        metadata: v.metadata,
      });
    }
  }
  return edges;
}
