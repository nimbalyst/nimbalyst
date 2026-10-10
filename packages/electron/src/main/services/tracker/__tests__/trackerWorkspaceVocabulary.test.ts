// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { TrackerDataModelRegistry, type LabelRegistry } from '@nimbalyst/tracker-schema';
import { readTrackerWorkspaceVocabulary, type TrackerWorkspaceVocabularyDeps } from '../trackerWorkspaceVocabulary';

const ACTIVE: LabelRegistry = { labels: [{ id: 'active', label: 'Active' }], properties: [], claimProperties: {} };
const LAYER: LabelRegistry = { labels: [{ id: 'layer', label: 'Layer' }], properties: [], claimProperties: {} };
const FILE: LabelRegistry = { labels: [{ id: 'file', label: 'File' }], properties: [], claimProperties: {} };
const predicate = (id: string) => ({ id, label: id, subjectKinds: ['*'], valueShape: 'text' as const, direction: 'directed' as const });

function deps(registry: TrackerDataModelRegistry): TrackerWorkspaceVocabularyDeps {
  return {
    registry,
    activeWorkspacePath: '/active',
    // The real scope helper routes getAllPredicates to the workspace layer; this
    // registry has no scope provider, so a non-active read has no layer.
    runScoped: () => [] as never,
    readLabels: vi.fn(() => FILE),
    readPredicates: vi.fn(() => [predicate('from-file')]),
  };
}

describe('readTrackerWorkspaceVocabulary', () => {
  it('answers the active workspace from memory and another from its layer or files, without installing anything', () => {
    const registry = new TrackerDataModelRegistry();
    registry.setActiveWorkspace('/active');
    registry.setLabels(ACTIVE);
    registry.setPredicates([predicate('active')]);
    const d = deps(registry);

    expect(readTrackerWorkspaceVocabulary('/active', d).labels).toBe(ACTIVE);

    const other = readTrackerWorkspaceVocabulary('/other', d);
    expect(other.labels).toBe(FILE);
    expect(other.predicates.map((p) => p.id)).toEqual(['from-file']);
    expect(d.readLabels).toHaveBeenCalledWith('/other');

    registry.setWorkspaceLabelLayer('/other', LAYER);
    expect(readTrackerWorkspaceVocabulary('/other', d).labels).toBe(LAYER);

    // The active view was never touched.
    expect(registry.getLabelRegistry()).toBe(ACTIVE);
    expect(registry.getAllPredicates().map((p) => p.id)).toEqual(['active']);
  });

  it('fails fast without a workspace path', () => {
    expect(() => readTrackerWorkspaceVocabulary('', deps(new TrackerDataModelRegistry()))).toThrow('workspacePath is required');
  });
});
