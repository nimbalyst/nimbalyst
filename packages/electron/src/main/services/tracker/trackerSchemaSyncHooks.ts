/**
 * The desktop's schema-lane hooks: tracker type definitions plus the predicate
 * and label registries, which share the lane under reserved schema types
 * (NIM-6653).
 *
 * The engine sees one lane. This routes each row to its owner, so neither the
 * type-def store nor the registry needs to know the other exists.
 */

import type { TrackerSchemaSyncHooks } from '@nimbalyst/tracker-engine';
import {
  TRACKER_LABEL_REGISTRY_SCHEMA_TYPE,
  TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/schemaSyncPayload';
import {
  applyRemoteLabelRegistry,
  listUnsyncedLabelRegistry,
  markLabelRegistryRejected,
  type LabelRegistryLaneOptions,
} from './trackerLabelRegistrySync';
import {
  applyRemotePredicateRegistry,
  listUnsyncedPredicateRegistry,
  markPredicateRegistryRejected,
  type PredicateRegistryLaneOptions,
} from './trackerPredicateRegistrySync';

export function composeTrackerSchemaSyncHooks(
  workspacePath: string,
  typeDefs: TrackerSchemaSyncHooks,
  registry: PredicateRegistryLaneOptions = {},
  labels: LabelRegistryLaneOptions = {},
): TrackerSchemaSyncHooks {
  return {
    listUnsynced: async () => [
      ...(await typeDefs.listUnsynced()),
      ...listUnsyncedPredicateRegistry(workspacePath, registry),
      ...listUnsyncedLabelRegistry(workspacePath, labels),
    ],
    applyRemote: (def) => {
      if (def.type === TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE) return applyRemotePredicateRegistry(workspacePath, def, registry);
      if (def.type === TRACKER_LABEL_REGISTRY_SCHEMA_TYPE) return applyRemoteLabelRegistry(workspacePath, def, labels);
      return typeDefs.applyRemote(def);
    },
    markRejected: async (type, code) => {
      if (type === TRACKER_PREDICATE_REGISTRY_SCHEMA_TYPE) {
        markPredicateRegistryRejected(workspacePath, registry);
        return;
      }
      if (type === TRACKER_LABEL_REGISTRY_SCHEMA_TYPE) {
        markLabelRegistryRejected(workspacePath, labels);
        return;
      }
      await typeDefs.markRejected?.(type, code);
    },
    onSettled: typeDefs.onSettled,
  };
}
