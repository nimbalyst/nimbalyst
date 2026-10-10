// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackerDataModelRegistry, type LabelRegistry } from '@nimbalyst/tracker-schema';
import { applySchemasKeepingVocabulary, loadTrackerVocabulary } from '../trackerVocabularyLoader';

const OLD: LabelRegistry = { labels: [{ id: 'feature', label: 'Feature' }], properties: [], claimProperties: {} };
const NEW: LabelRegistry = { labels: [{ id: 'feature', label: 'Feature' }, { id: 'requirement', label: 'Requirement' }], properties: [], claimProperties: {} };
const PREDICATE = { id: 'made-by', label: 'Made by', subjectKinds: ['*'], valueShape: 'entity' as const, direction: 'directed' as const };

function installApi(getVocabulary: (workspacePath: string) => Promise<unknown>) {
  (window as unknown as { electronAPI: unknown }).electronAPI = { trackerSchema: { getVocabulary } };
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

/** Apply the way the renderer does: clear workspace schemas, then register. */
function applyLike(registry: TrackerDataModelRegistry) {
  return (_schemas: unknown[], options?: { keepVocabulary?: boolean }) => registry.clearWorkspaceSchemas(options);
}

describe('trackerVocabularyLoader', () => {
  it('never leaves an empty vocabulary between a schema change and the refetch', async () => {
    const registry = new TrackerDataModelRegistry();
    registry.setLabels(OLD);
    registry.setPredicates([PREDICATE]);
    let resolveFetch!: (value: unknown) => void;
    const getVocabulary = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    installApi(getVocabulary);

    // A listener reads synchronously inside the notification, as a React
    // subscriber's render does; it must never see the vocabulary missing.
    const seen: Array<[number, number]> = [];
    registry.onChange(() => seen.push([registry.getLabelRegistry().labels.length, registry.getAllPredicates().length]));

    const reload = applySchemasKeepingVocabulary([], applyLike(registry), '/ws', registry);
    expect(seen.filter(([labels, predicates]) => labels === 0 || predicates === 0)).toEqual([]);
    // Schemas applied, fetch still in flight: the previous vocabulary is in force.
    expect(registry.getLabelRegistry().labels.map((label) => label.id)).toEqual(['feature']);
    expect(registry.getAllPredicates().map((predicate) => predicate.id)).toEqual(['made-by']);
    expect(getVocabulary).toHaveBeenCalledWith('/ws');

    resolveFetch({ labels: NEW, predicates: [PREDICATE] });
    await reload;
    expect(registry.getLabelRegistry().labels.map((label) => label.id)).toEqual(['feature', 'requirement']);
  });

  it('keeps the previous vocabulary when the fetch fails or returns an invalid registry', async () => {
    const registry = new TrackerDataModelRegistry();
    registry.setLabels(OLD);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    installApi(() => Promise.reject(new Error('ipc down')));
    await loadTrackerVocabulary('/ws', registry);
    expect(registry.getLabelRegistry()).toBe(OLD);

    installApi(() => Promise.resolve({ labels: { labels: 'nope' }, predicates: [] }));
    await loadTrackerVocabulary('/ws', registry);
    expect(registry.getLabelRegistry()).toBe(OLD);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
