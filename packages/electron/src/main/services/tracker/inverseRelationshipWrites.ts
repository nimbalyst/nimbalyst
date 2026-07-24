/**
 * Inverse relationship propagation (Epic C, Phase 3).
 *
 * When a source item's relationship field that declares an `inverseFieldId`
 * changes, the inverse value must be materialized on each affected target item's
 * inverse field — e.g. setting plan.dependsOn += bug means bug.blockedBy += plan.
 * The design (`tracker-relationships-design.md`, "bidirectional relationships
 * need a complete write path") calls for updating inverse fields in one service
 * transaction rather than leaving inverse links derive-only.
 *
 * This module owns the orchestration but stays I/O-agnostic via injected deps so
 * it is unit-testable without a DB or the sync stack. The pure delta math lives
 * in the runtime model (`computeInverseFieldDeltas`).
 *
 * Loop safety: target updates are applied through `deps.applyTargetUpdate`, NOT
 * by re-entering the source write path, so an inverse write never triggers its
 * own inverse propagation back to the source.
 *
 * Cross-room limitation (by design): if a target item is not present locally
 * (private to another member, or in a different shared room) it is skipped — the
 * link remains visible from the source side and renders as a backlink/dangler on
 * the other side. No storage model fixes shared-room A ↔ shared-room B for free.
 */
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel';
import {
  isRelationshipField,
  normalizeRelationshipValue,
  addRelationshipValue,
  removeRelationshipValue,
  serializeRelationshipValue,
  computeInverseFieldDeltas,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { readStoredFieldValue } from './relationshipFieldStorage';

export interface InverseWriteSource {
  id: string;
  type: string;
  issueKey?: string;
  title?: string;
}

export interface InverseWriteDeps {
  /** Load a target item's type + parsed data by canonical id; null if absent. */
  loadItem: (itemId: string) => Promise<{ id: string; type: string; data: Record<string, unknown> } | null>;
  /** Persist one inverse-field value on a target item, then sync + reindex it. */
  applyTargetUpdate: (itemId: string, fieldName: string, value: unknown) => Promise<void>;
}

/**
 * Propagate inverse-field writes for every changed relationship field on the
 * source item. `changedFields` is the update payload (only fields present here
 * are considered); `oldData` is the source item's data BEFORE the update, used to
 * diff added/dropped targets. Returns how many target items were updated.
 */
export async function propagateInverseRelationships(
  source: InverseWriteSource,
  changedFields: Record<string, unknown>,
  oldData: Record<string, unknown>,
  deps: InverseWriteDeps,
): Promise<{ targetsUpdated: number }> {
  const defs = globalRegistry.get(source.type)?.fields ?? [];
  let targetsUpdated = 0;

  for (const def of defs) {
    if (!isRelationshipField(def) || !def.inverseFieldId) continue;
    if (!(def.name in changedFields)) continue;

    const deltas = computeInverseFieldDeltas(
      def,
      { itemId: source.id, issueKey: source.issueKey, title: source.title, trackerType: source.type },
      // Synced items nest relationship values under data.customFields; read the
      // prior value tolerant of both shapes so an unchanged synced value doesn't
      // look like a fresh add (NIM-1305).
      readStoredFieldValue(oldData, def.name),
      changedFields[def.name],
    );

    for (const delta of deltas) {
      const target = await deps.loadItem(delta.targetItemId);
      if (!target) continue; // dangling/private target — backlinks still cover it

      const invDef = (globalRegistry.get(target.type)?.fields ?? []).find((f) => f.name === delta.inverseFieldId);
      // Only materialize when the target type actually declares the inverse field
      // as a relationship; otherwise the derived backlink view is the only surface.
      if (!invDef || !isRelationshipField(invDef)) continue;

      // Read the target's existing inverse array tolerant of the nested
      // customFields storage — reading top-level only would see it as empty and
      // clobber the target's other links on write (NIM-1305).
      const current = normalizeRelationshipValue(readStoredFieldValue(target.data, delta.inverseFieldId));
      const next = delta.op === 'add'
        ? addRelationshipValue(invDef, current, delta.value)
        : removeRelationshipValue(current, delta.value.itemId);

      await deps.applyTargetUpdate(target.id, delta.inverseFieldId, serializeRelationshipValue(invDef, next));
      targetsUpdated++;
    }
  }

  return { targetsUpdated };
}
