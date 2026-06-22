import { describe, it, expect, beforeEach } from 'vitest';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel';
import type { TrackerDataModel } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel';
import { propagateInverseRelationships } from '../inverseRelationshipWrites';

/**
 * Phase 3 inverse propagation orchestration. The pure delta math is covered in
 * the runtime model tests; here we verify the service wiring: the right target
 * items get the right inverse-field writes, dangling/private targets are skipped,
 * and a target type without the inverse field is left to the derived backlink.
 */

function model(type: string, fields: TrackerDataModel['fields']): TrackerDataModel {
  return {
    type,
    displayName: type,
    displayNamePlural: `${type}s`,
    icon: 'label',
    color: '#888',
    modes: { inline: true, fullDocument: false },
    idPrefix: type.toUpperCase(),
    idFormat: 'ulid',
    fields,
  };
}

const PLAN = model('plan', [
  { name: 'title', type: 'string' },
  {
    name: 'dependsOn', type: 'relationship', relationshipTypeKey: 'depends-on', multiValue: true,
    inverseFieldId: 'blockedBy', inverseRelationshipTypeKey: 'blocks',
  },
]);
const BUG = model('bug', [
  { name: 'title', type: 'string' },
  { name: 'blockedBy', type: 'relationship', relationshipTypeKey: 'blocks', multiValue: true },
]);

interface FakeTarget { id: string; type: string; data: Record<string, unknown> }

function makeDeps(targets: FakeTarget[]) {
  const writes: Array<{ itemId: string; fieldName: string; value: unknown }> = [];
  const byId = new Map(targets.map((t) => [t.id, t]));
  return {
    writes,
    deps: {
      loadItem: async (id: string) => byId.get(id) ?? null,
      applyTargetUpdate: async (itemId: string, fieldName: string, value: unknown) => {
        writes.push({ itemId, fieldName, value });
      },
    },
  };
}

describe('propagateInverseRelationships', () => {
  beforeEach(() => {
    globalRegistry.register(PLAN);
    globalRegistry.register(BUG);
  });

  it('writes the inverse value on a newly-linked target', async () => {
    const { writes, deps } = makeDeps([{ id: 'bug-1', type: 'bug', data: {} }]);
    const res = await propagateInverseRelationships(
      { id: 'plan-1', type: 'plan', issueKey: 'NIM-1', title: 'Plan One' },
      { dependsOn: [{ itemId: 'bug-1' }] },
      {},
      deps,
    );
    expect(res.targetsUpdated).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].itemId).toBe('bug-1');
    expect(writes[0].fieldName).toBe('blockedBy');
    expect(writes[0].value).toEqual([
      expect.objectContaining({ itemId: 'plan-1', issueKey: 'NIM-1', relationshipTypeKey: 'blocks' }),
    ]);
  });

  it('removes the inverse value when a link is dropped', async () => {
    const { writes, deps } = makeDeps([
      { id: 'bug-1', type: 'bug', data: { blockedBy: [{ itemId: 'plan-1', relationshipTypeKey: 'blocks' }] } },
    ]);
    await propagateInverseRelationships(
      { id: 'plan-1', type: 'plan' },
      { dependsOn: [] },
      { dependsOn: [{ itemId: 'bug-1' }] },
      deps,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ itemId: 'bug-1', fieldName: 'blockedBy' });
    expect(writes[0].value).toEqual([]);
  });

  it('skips targets that are not present locally (dangling/private)', async () => {
    const { writes, deps } = makeDeps([]); // bug-1 not loadable
    const res = await propagateInverseRelationships(
      { id: 'plan-1', type: 'plan' },
      { dependsOn: [{ itemId: 'bug-1' }] },
      {},
      deps,
    );
    expect(res.targetsUpdated).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it('skips when the target type does not declare the inverse field', async () => {
    globalRegistry.register(model('note', [{ name: 'title', type: 'string' }]));
    const { writes, deps } = makeDeps([{ id: 'note-1', type: 'note', data: {} }]);
    await propagateInverseRelationships(
      { id: 'plan-1', type: 'plan' },
      { dependsOn: [{ itemId: 'note-1' }] },
      {},
      deps,
    );
    expect(writes).toHaveLength(0);
  });

  it('ignores relationship fields that did not change in this update', async () => {
    const { writes, deps } = makeDeps([{ id: 'bug-1', type: 'bug', data: {} }]);
    await propagateInverseRelationships(
      { id: 'plan-1', type: 'plan' },
      { title: 'renamed' }, // dependsOn absent → no propagation
      { dependsOn: [{ itemId: 'bug-1' }] },
      deps,
    );
    expect(writes).toHaveLength(0);
  });
});
