import { describe, it, expect } from 'vitest';
import {
  BUILTIN_TRACKER_YAML,
  parseBuiltinTrackers,
  loadBuiltinTrackers,
} from '../ModelLoader';
import { globalRegistry, type TrackerDataModel } from '../TrackerDataModel';

/**
 * Guards the migration of the built-in tracker definitions from the old hardcoded
 * `builtinTrackers` array in ModelLoader.ts to bundled YAML under ./builtins.
 *
 * A malformed builtin YAML (or a dropped/renamed required role) must fail CI here
 * instead of silently dropping a type at runtime. The property table also pins the
 * behavior-preserving invariants so the YAML can't quietly diverge from what the
 * code array shipped.
 */

const EXPECTED = [
  'plan',
  'decision',
  'bug',
  'task',
  'idea',
  'milestone',
  'release',
] as const;

// Behavior-preserving invariants carried over from the pre-migration code array.
const INVARIANTS: Record<string, {
  idPrefix: string;
  syncMode: 'local' | 'shared' | 'hybrid';
  creatable?: boolean;
}> = {
  plan: { idPrefix: 'pln', syncMode: 'hybrid' },
  decision: { idPrefix: 'dec', syncMode: 'shared' },
  bug: { idPrefix: 'bug', syncMode: 'shared' },
  task: { idPrefix: 'tsk', syncMode: 'shared' },
  idea: { idPrefix: 'id', syncMode: 'local' },
  // Collection types: both shared, since a sprint or release is a team artifact.
  milestone: { idPrefix: 'mst', syncMode: 'shared' },
  release: { idPrefix: 'rel', syncMode: 'shared' },
};

describe('bundled builtin tracker YAML', () => {
  it('bundles exactly the expected builtin types, in load order', () => {
    expect(BUILTIN_TRACKER_YAML.map((b) => b.type)).toEqual([...EXPECTED]);
  });

  it('parses every bundled builtin without throwing', () => {
    const models = parseBuiltinTrackers();
    expect(models).toHaveLength(EXPECTED.length);
  });

  it('every builtin declares a title role and a workflowStatus role backed by a select field', () => {
    const models = parseBuiltinTrackers();
    for (const model of models) {
      const titleField = model.roles?.title;
      const statusField = model.roles?.workflowStatus;
      expect(titleField, `${model.type} title role`).toBeTruthy();
      expect(statusField, `${model.type} workflowStatus role`).toBeTruthy();

      // The role must resolve to a real field on the model.
      const status = model.fields.find((f) => f.name === statusField);
      expect(status, `${model.type} status field '${statusField}'`).toBeDefined();
      expect(status!.type, `${model.type} status field type`).toBe('select');
      expect(status!.options?.length, `${model.type} status options`).toBeGreaterThan(0);

      // Required-field baseline: a title string field must exist.
      const title = model.fields.find((f) => f.name === titleField);
      expect(title, `${model.type} title field '${titleField}'`).toBeDefined();
      expect(title!.type).toBe('string');
    }
  });

  it('preserves the behavior-preserving invariants from the old code array', () => {
    const byType = new Map<string, TrackerDataModel>(
      parseBuiltinTrackers().map((m) => [m.type, m])
    );
    for (const type of EXPECTED) {
      const model = byType.get(type)!;
      const inv = INVARIANTS[type];
      expect(model.idPrefix, `${type} idPrefix`).toBe(inv.idPrefix);
      expect(model.sync?.mode, `${type} sync mode`).toBe(inv.syncMode);
      if (inv.creatable !== undefined) {
        expect(model.creatable, `${type} creatable`).toBe(inv.creatable);
      }
    }
  });

  it('registers all builtins into the registry as builtin types', () => {
    loadBuiltinTrackers();
    for (const type of EXPECTED) {
      expect(globalRegistry.get(type), `${type} registered`).toBeDefined();
      expect(globalRegistry.isBuiltin(type), `${type} isBuiltin`).toBe(true);
    }
  });
});
