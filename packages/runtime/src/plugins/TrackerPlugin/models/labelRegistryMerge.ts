/**
 * Reconcile a peer's local label registry (`.nimbalyst/labels.yaml`) with the
 * one the room publishes. The algorithm is the predicate registry's (see
 * `predicateRegistryMerge.ts` for the reasoning), applied per entry across the
 * three sections; it lives in `@nimbalyst/tracker-schema` so the collab server
 * merges authored changes with the same code. This module is the lane-facing
 * name, beside its predicate sibling.
 */

export {
  canonicalLabelRegistryJson,
  mergeLabelRegistries,
  type LabelRegistryMergeResult,
} from '@nimbalyst/tracker-schema';
