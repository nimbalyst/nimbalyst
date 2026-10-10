// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import { TrackerDataModelRegistry, type LabelRegistry } from '@nimbalyst/tracker-schema';
import { activeWorkspacePathAtom } from '../../atoms/openProjects';
import { initTrackerVocabularyListeners } from '../trackerVocabularyListeners';

const labelsFor = (...ids: string[]): LabelRegistry => ({
  labels: ids.map((id) => ({ id, label: id })),
  properties: [],
  claimProperties: {},
});
const predicate = (id: string) => ({ id, label: id, subjectKinds: ['*'], valueShape: 'entity' as const, direction: 'directed' as const });

const VOCABULARY: Record<string, { labels: LabelRegistry; predicates: unknown[] }> = {
  '/ws-a': { labels: labelsFor('feature', 'requirement'), predicates: [predicate('made-by')] },
  '/ws-b': { labels: labelsFor('decision'), predicates: [predicate('depends-on'), predicate('owned-by')] },
};

let schemaChanged: ((schemas: unknown[]) => void) | null;
let getVocabulary: ReturnType<typeof vi.fn>;

beforeEach(() => {
  schemaChanged = null;
  getVocabulary = vi.fn(async (workspacePath: string) => VOCABULARY[workspacePath] ?? null);
  vi.stubGlobal('window', {
    electronAPI: {
      trackerSchema: {
        getVocabulary,
        onChanged: (callback: (schemas: unknown[]) => void) => {
          schemaChanged = callback;
          return () => { schemaChanged = null; };
        },
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const labelIds = (registry: TrackerDataModelRegistry) => registry.getLabelRegistry().labels.map((label) => label.id);
const predicateIds = (registry: TrackerDataModelRegistry) => registry.getAllPredicates().map((p) => p.id);

describe('trackerVocabularyListeners', () => {
  it('loads the active workspace vocabulary, reloads on a switch and on a schema change, and ignores a null path', async () => {
    const store = createStore();
    const registry = new TrackerDataModelRegistry();
    const applySchemas = vi.fn();
    const cleanup = initTrackerVocabularyListeners({ store, registry, applySchemas });

    // No workspace yet: nothing is fetched and the registry stays empty.
    await flush();
    expect(getVocabulary).not.toHaveBeenCalled();
    expect(labelIds(registry)).toEqual([]);

    store.set(activeWorkspacePathAtom, '/ws-a');
    await flush();
    expect(labelIds(registry)).toEqual(['feature', 'requirement']);
    expect(predicateIds(registry)).toEqual(['made-by']);

    store.set(activeWorkspacePathAtom, '/ws-b');
    await flush();
    expect(labelIds(registry)).toEqual(['decision']);
    expect(predicateIds(registry)).toEqual(['depends-on', 'owned-by']);

    // A schema change (including a synced `__labels__` / `__predicates__`
    // update, which main announces the same way) reloads with the CURRENT path.
    getVocabulary.mockClear();
    schemaChanged!([{ type: 'bug' }]);
    await flush();
    expect(applySchemas).toHaveBeenCalledWith([{ type: 'bug' }], { keepVocabulary: true });
    expect(getVocabulary).toHaveBeenCalledWith('/ws-b');

    // Closing the last project leaves the last vocabulary in place.
    getVocabulary.mockClear();
    store.set(activeWorkspacePathAtom, null);
    await flush();
    expect(getVocabulary).not.toHaveBeenCalled();
    expect(labelIds(registry)).toEqual(['decision']);

    cleanup();
    expect(schemaChanged).toBeNull();
    store.set(activeWorkspacePathAtom, '/ws-a');
    await flush();
    expect(getVocabulary).not.toHaveBeenCalled();
  });

  it('loads immediately when the workspace is already known and drops a slower stale load', async () => {
    const store = createStore();
    store.set(activeWorkspacePathAtom, '/ws-a');
    const registry = new TrackerDataModelRegistry();
    let resolveA!: (value: unknown) => void;
    getVocabulary.mockImplementation((workspacePath: string) => workspacePath === '/ws-a'
      ? new Promise((resolve) => { resolveA = resolve; })
      : Promise.resolve(VOCABULARY[workspacePath]));

    const cleanup = initTrackerVocabularyListeners({ store, registry, applySchemas: vi.fn() });
    expect(getVocabulary).toHaveBeenCalledWith('/ws-a');

    store.set(activeWorkspacePathAtom, '/ws-b');
    await flush();
    resolveA(VOCABULARY['/ws-a']);
    await flush();
    expect(labelIds(registry)).toEqual(['decision']);
    cleanup();
  });
});
