// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { FieldDefinition } from '@nimbalyst/tracker-schema';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { fieldRelationLinks } from '../fieldRelationLinks';

const fieldsByType: Record<string, Array<{ name: string; type: string; predicate?: string; relationshipTypeKey?: string }>> = {
  module: [{ name: 'builtOn', type: 'relationship', predicate: 'built-on' }],
  tech: [],
};
const fieldDefs = (type: string) => (fieldsByType[type] ?? []) as unknown as FieldDefinition[];
const record = (id: string, primaryType: string, fields: Record<string, unknown>) => ({
  id, primaryType, issueKey: id.toUpperCase(), fields: { title: id, ...fields }, system: {},
}) as unknown as TrackerRecord;

describe('fieldRelationLinks', () => {
  const records = [
    record('editor', 'module', { builtOn: [{ itemId: 'yjs' }] }),
    // A synced item keeps its relationship value under customFields.
    record('sync', 'module', { customFields: { builtOn: [{ itemId: 'yjs' }] } }),
    record('yjs', 'tech', {}),
  ];

  it('lists a page relation fields going out and the ones pointing at it coming in', () => {
    expect(fieldRelationLinks('editor', records, fieldDefs)).toEqual([
      expect.objectContaining({ direction: 'out', predicateId: 'built-on', otherItemId: 'yjs', otherTypeId: 'tech', sourceFieldId: 'builtOn', sentence: null }),
    ]);
    const incoming = fieldRelationLinks('yjs', records, fieldDefs);
    expect(incoming.map((link) => [link.direction, link.otherItemId, link.otherIssueKey])).toEqual([['in', 'editor', 'EDITOR'], ['in', 'sync', 'SYNC']]);
  });

  it('skips a target that is not in the room', () => {
    expect(fieldRelationLinks('editor', [records[0]!], fieldDefs)).toEqual([]);
  });
});
