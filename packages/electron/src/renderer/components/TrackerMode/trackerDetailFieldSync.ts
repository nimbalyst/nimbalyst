/**
 * Pure reconciliation helpers for TrackerItemDetail's in-progress field edits.
 *
 * The detail panel keeps a local override for fields the user is editing
 * (`localCustomFields`) so keystrokes are not reset by atom updates. But an
 * override that outlives the edit becomes stale: `getFieldValue` keeps returning
 * it, so when another writer (MCP, sync, another window) changes that field, the
 * panel both displays the stale value and re-saves it on the next autosave,
 * clobbering the external write (NIM-790).
 *
 * `reconcileExternalFieldChanges` decides which overrides to drop: those whose
 * persisted value changed out from under the override while the user is NOT
 * mid-edit. Dropping an override makes `getFieldValue` fall back to the fresh
 * atom value. Fields with a pending (debounced/in-flight) save are left alone so
 * active typing is never interrupted -- last-write-wins still favors the user's
 * in-flight edit.
 */

export interface FieldOverrideReconcileInput {
  /** Persisted field values the panel last reconciled against (baseline). */
  previousPersisted: Record<string, unknown>;
  /** Current persisted field values from the tracker atom. */
  currentPersisted: Record<string, unknown>;
  /** Field names that currently have an in-progress local override. */
  overriddenFields: readonly string[];
  /** Field names with a pending (debounced/in-flight) local save. */
  pendingFields: ReadonlySet<string>;
}

export function reconcileExternalFieldChanges(
  input: FieldOverrideReconcileInput,
): { clearedFields: string[] } {
  const { previousPersisted, currentPersisted, overriddenFields, pendingFields } = input;
  const clearedFields: string[] = [];
  for (const field of overriddenFields) {
    if (pendingFields.has(field)) continue; // user is mid-edit -- don't interrupt
    if (!Object.is(previousPersisted[field], currentPersisted[field])) {
      clearedFields.push(field);
    }
  }
  return { clearedFields };
}
