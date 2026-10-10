/**
 * Mirror the project's label and predicate registries into the renderer's
 * tracker registry.
 *
 * The main process owns both registries (`.nimbalyst/labels.yaml` and
 * `predicates.yaml`, plus their sync lanes). The renderer only needs them to
 * resolve an item's effective properties -- which fields a label brings, and
 * which of them are claim-stored -- so it reads them after every schema change.
 *
 * Applying a schema change of the same workspace must not clear the
 * vocabulary with the schemas: label fields would blink out until the fetch
 * landed, and a listener reading inside the change notification would see an
 * empty registry. {@link applySchemasKeepingVocabulary} applies with
 * `keepVocabulary`, so the previous vocabulary stays in force and the fetched
 * one replaces it whole. A failed fetch keeps the previous vocabulary.
 */

import {
  globalRegistry,
  validateLabelRegistry,
  type PredicateDefinition,
  type TrackerDataModelRegistry,
} from '@nimbalyst/tracker-schema';

interface VocabularyApi {
  getVocabulary?: (workspacePath: string) => Promise<{ labels: unknown; predicates: unknown[] } | null>;
}

function vocabularyApi(): VocabularyApi | undefined {
  return (window as { electronAPI?: { trackerSchema?: VocabularyApi } }).electronAPI?.trackerSchema;
}

let generation = 0;

/** Fetch the workspace's vocabulary and swap it in; keep the current one on any failure. */
export async function loadTrackerVocabulary(
  workspacePath: string | null | undefined,
  registry: TrackerDataModelRegistry = globalRegistry,
): Promise<void> {
  const api = vocabularyApi();
  if (!api?.getVocabulary) return;
  if (!workspacePath) {
    console.warn('[trackerVocabularyLoader] No workspace path; label properties stay unavailable');
    return;
  }
  // A slower earlier read must not overwrite a newer one.
  const mine = ++generation;
  try {
    const vocabulary = await api.getVocabulary(workspacePath);
    if (mine !== generation) return;
    if (!vocabulary) throw new Error('empty response');
    const labels = validateLabelRegistry(vocabulary.labels);
    if (!labels.valid) throw new Error(`invalid label registry: ${labels.issues.map(issue => issue.message).join('; ')}`);
    registry.setPredicates(Array.isArray(vocabulary.predicates) ? vocabulary.predicates as PredicateDefinition[] : []);
    registry.setLabels(labels.registry);
  } catch (error) {
    console.error('[trackerVocabularyLoader] Failed to load the vocabulary; keeping the previous one:', error);
  }
}

/**
 * Apply a schema set without the vocabulary ever reading as empty to a
 * renderer: keep it through the apply, then refresh it.
 */
export function applySchemasKeepingVocabulary(
  schemas: unknown[],
  apply: (schemas: unknown[], options: { keepVocabulary: true }) => void,
  workspacePath: string | null | undefined,
  registry: TrackerDataModelRegistry = globalRegistry,
): Promise<void> {
  apply(schemas, { keepVocabulary: true });
  return loadTrackerVocabulary(workspacePath, registry);
}
