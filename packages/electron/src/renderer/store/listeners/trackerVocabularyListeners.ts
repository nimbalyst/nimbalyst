/**
 * Keep the renderer's label and predicate vocabulary on the visible workspace.
 *
 * The vocabulary is per workspace (`.nimbalyst/labels.yaml` / `predicates.yaml`,
 * or the team's synced `__labels__` / `__predicates__` copies, which main
 * installs into the same registry). The plugin bootstrap runs at module load,
 * before any workspace is known, so it cannot fetch it; this listener does,
 * whenever `activeWorkspacePathAtom` settles on a path, and again on every
 * `tracker-schema:changed` -- main sends that for a schema edit and for a
 * label or predicate registry change, local or synced.
 *
 * A null path (no project open) leaves the last vocabulary in place. A stale
 * fetch from a quick project switch is dropped by the loader's generation
 * check.
 */

import type { Store } from 'jotai/vanilla/store';
import { globalRegistry, type TrackerDataModelRegistry } from '@nimbalyst/tracker-schema';

// The store singleton, not the `store/index` barrel, which would drag every
// renderer atom module in behind it.
import { store as defaultStore } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../atoms/openProjects';
import {
  applySchemasKeepingVocabulary,
  loadTrackerVocabulary,
} from '../../components/TrackerMode/trackerVocabularyLoader';

type ApplySchemas = (schemas: unknown[], options: { keepVocabulary: true }) => void;

interface TrackerVocabularyListenerOptions {
  /** Replaces the registry's workspace schemas (`applySchemasToRegistry`). */
  applySchemas: ApplySchemas;
  store?: Store;
  registry?: TrackerDataModelRegistry;
}

interface SchemaChangeApi {
  onChanged?: (callback: (schemas: unknown[]) => void) => (() => void) | void;
}

let activeCleanup: (() => void) | null = null;

export function initTrackerVocabularyListeners({
  applySchemas,
  store = defaultStore,
  registry = globalRegistry,
}: TrackerVocabularyListenerOptions): () => void {
  // One subscription per renderer, even if the bootstrap runs again under HMR.
  activeCleanup?.();

  let workspacePath: string | null = null;

  const syncWorkspace = () => {
    const next = store.get(activeWorkspacePathAtom);
    if (!next || next === workspacePath) return;
    workspacePath = next;
    void loadTrackerVocabulary(next, registry);
  };

  const unsubscribeAtom = store.sub(activeWorkspacePathAtom, syncWorkspace);
  syncWorkspace();

  const api = (window as { electronAPI?: { trackerSchema?: SchemaChangeApi } }).electronAPI?.trackerSchema;
  const unsubscribeSchemas = api?.onChanged?.((schemas) => {
    void applySchemasKeepingVocabulary(schemas ?? [], applySchemas, workspacePath, registry);
  });

  const cleanup = () => {
    unsubscribeAtom();
    unsubscribeSchemas?.();
    if (activeCleanup === cleanup) activeCleanup = null;
  };
  activeCleanup = cleanup;
  return cleanup;
}
