import type { ValidationResult } from './TrackerDataModel.js';

/**
 * Narrow a whole-item validation to the fields an update writes or clears.
 *
 * An item created before a field became required (or before a constraint
 * tightened) still lacks or violates it. Validating the whole item on every
 * update made such an item impossible to archive or edit at all; an update
 * answers only for what it changes. Create still validates the whole item.
 * Warnings pass through unchanged: they never block a write.
 */
export function scopeValidationToChanges(
  result: ValidationResult,
  changedFields: Iterable<string>,
): ValidationResult {
  if (result.valid) return result;
  const changed = new Set(changedFields);
  const errors = result.errors.filter((error) => changed.has(rootField(error.field)));
  return { ...result, valid: errors.length === 0, errors };
}

/** `citations[0].source` and `citations.locator` belong to the field `citations`. */
function rootField(path: string): string {
  const end = path.search(/[.[]/);
  return end === -1 ? path : path.slice(0, end);
}
