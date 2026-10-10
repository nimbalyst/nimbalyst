/**
 * The label and predicate registries of ONE workspace, for a renderer that
 * resolves an item's effective properties (`tracker-schema:get-vocabulary`).
 *
 * The active workspace reads the in-memory registry. Any other workspace reads
 * its in-memory layer when one has been installed, and otherwise its
 * `.nimbalyst/labels.yaml` / `predicates.yaml` directly. Nothing here mutates
 * the registry: answering a second window must not install that window's
 * vocabulary into the active view (the #1035 leak).
 */

import {
  emptyLabelRegistry,
  isLabelRegistryEmpty,
  type LabelRegistry,
  type PredicateDefinition,
  type TrackerDataModelRegistry,
} from '@nimbalyst/tracker-schema';

export interface TrackerWorkspaceVocabulary {
  labels: LabelRegistry;
  predicates: PredicateDefinition[];
}

export interface TrackerWorkspaceVocabularyDeps {
  registry: TrackerDataModelRegistry;
  activeWorkspacePath: string | null;
  /** Run a read scoped to `workspacePath` (`runWithTrackerSchemaWorkspace`). */
  runScoped: <T>(workspacePath: string, read: () => T) => T;
  readLabels: (workspacePath: string) => LabelRegistry | null;
  readPredicates: (workspacePath: string) => PredicateDefinition[] | null;
}

export function readTrackerWorkspaceVocabulary(
  workspacePath: string,
  deps: TrackerWorkspaceVocabularyDeps,
): TrackerWorkspaceVocabulary {
  if (!workspacePath) throw new Error('workspacePath is required');
  const { registry } = deps;
  if (!deps.activeWorkspacePath || workspacePath === deps.activeWorkspacePath) {
    return { labels: registry.getLabelRegistry(), predicates: registry.getAllPredicates() };
  }
  // An empty layer and no layer read the same; either way the file is the answer.
  const layerLabels = registry.getLabelRegistryForWorkspace(workspacePath);
  const layerPredicates = deps.runScoped(workspacePath, () => registry.getAllPredicates());
  return {
    labels: isLabelRegistryEmpty(layerLabels)
      ? deps.readLabels(workspacePath) ?? emptyLabelRegistry()
      : layerLabels,
    predicates: layerPredicates.length > 0
      ? layerPredicates
      : deps.readPredicates(workspacePath) ?? [],
  };
}
