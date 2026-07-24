/**
 * Relationship field write normalization + validation (Epic C).
 *
 * When an agent or user writes a relationship field via tracker_create /
 * tracker_update, the value may arrive as a bare id, a single object, or an
 * array. This canonicalizes it to the stored shape (single object|null for
 * single-value fields, array for multi-value) and enforces the field's rules
 * (self-link, target-type, single-vs-multi, dedup) before persistence. Pure over
 * `data` (mutates the passed bag in place) so it is unit-testable without a DB.
 */
import type { FieldDefinition } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  isRelationshipField,
  normalizeRelationshipValue,
  validateRelationshipValue,
  serializeRelationshipValue,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

export type RelationshipWriteResult =
  | { ok: true }
  | { ok: false; field: string; errors: string[] };

/**
 * Canonicalize + validate every relationship field present in `data` against the
 * schema's field definitions. On the first invalid field, returns its errors and
 * leaves `data` unmodified for that field. `targetTypeOf` optionally resolves a
 * target item's tracker type when the written value omits it.
 */
export function applyRelationshipFieldWrites(
  data: Record<string, unknown>,
  fieldDefs: FieldDefinition[],
  sourceItemId: string,
  targetTypeOf?: (itemId: string) => string | undefined,
): RelationshipWriteResult {
  for (const def of fieldDefs) {
    if (!isRelationshipField(def)) continue;
    if (!(def.name in data)) continue;
    const raw = data[def.name];
    // Allow explicit clears (null/empty) through as an emptied field.
    if (raw == null || (Array.isArray(raw) && raw.length === 0)) {
      data[def.name] = serializeRelationshipValue(def, []);
      continue;
    }
    const normalized = normalizeRelationshipValue(raw);
    const errors = validateRelationshipValue(def, normalized, { sourceItemId, targetTypeOf });
    if (errors.length > 0) {
      return { ok: false, field: def.name, errors: errors.map((e) => e.message) };
    }
    data[def.name] = serializeRelationshipValue(def, normalized);
  }
  return { ok: true };
}
