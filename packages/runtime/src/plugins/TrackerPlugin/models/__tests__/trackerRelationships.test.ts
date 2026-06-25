import { describe, it, expect } from 'vitest';
import {
  BUILTIN_RELATIONSHIP_TYPES,
  resolveRelationshipType,
  isRelationshipField,
  normalizeRelationshipValue,
  validateRelationshipValue,
  addRelationshipValue,
  removeRelationshipValue,
  serializeRelationshipValue,
  deriveRelationshipEdges,
  computeInverseFieldDeltas,
} from '../trackerRelationships';
import type { FieldDefinition, TrackerRelationshipValue } from '../TrackerDataModel';

/**
 * Epic C Phase 1: pure relationship value-model. Field-backed relationships sync
 * on the metadata socket like labels; this covers the value normalize/validate/
 * add/remove logic the service + UI + MCP tools share.
 */

function relField(extra?: Partial<FieldDefinition>): FieldDefinition {
  return { name: 'dependsOn', type: 'relationship', relationshipTypeKey: 'depends-on', multiValue: true, ...extra };
}

describe('relationship vocabulary', () => {
  it('exposes built-in types with inverse pairing', () => {
    const dependsOn = resolveRelationshipType('depends-on');
    expect(dependsOn?.inverseKey).toBe('blocks');
    expect(resolveRelationshipType('relates-to')?.symmetric).toBe(true);
    expect(BUILTIN_RELATIONSHIP_TYPES.length).toBeGreaterThan(0);
  });

  it('prefers a custom type over a built-in of the same key', () => {
    const custom = [{ key: 'depends-on', displayName: 'Needs', category: 'custom' as const }];
    expect(resolveRelationshipType('depends-on', custom)?.displayName).toBe('Needs');
  });

  it('treats relationship and legacy reference as relationship fields', () => {
    expect(isRelationshipField({ type: 'relationship' })).toBe(true);
    expect(isRelationshipField({ type: 'reference' })).toBe(true);
    expect(isRelationshipField({ type: 'string' })).toBe(false);
  });
});

describe('normalizeRelationshipValue', () => {
  it('wraps a single object, dedups arrays by itemId (last wins)', () => {
    expect(normalizeRelationshipValue({ itemId: 'a', title: 'A' })).toEqual([{ itemId: 'a', title: 'A' }]);
    const deduped = normalizeRelationshipValue([
      { itemId: 'a', title: 'old' },
      { itemId: 'b' },
      { itemId: 'a', title: 'new' },
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped.find((v) => v.itemId === 'a')?.title).toBe('new');
  });

  it('tolerates null/undefined and bare-string ids', () => {
    expect(normalizeRelationshipValue(null)).toEqual([]);
    expect(normalizeRelationshipValue(undefined)).toEqual([]);
    expect(normalizeRelationshipValue('item-1')).toEqual([{ itemId: 'item-1' }]);
    expect(normalizeRelationshipValue([{ id: 'legacy' }])).toEqual([{ itemId: 'legacy' }]);
  });

  it('drops entries with no resolvable id', () => {
    expect(normalizeRelationshipValue([{ title: 'no id' }, ''])).toEqual([]);
  });
});

describe('validateRelationshipValue', () => {
  it('rejects self-links unless allowed', () => {
    const errs = validateRelationshipValue(relField(), [{ itemId: 'self' }], { sourceItemId: 'self' });
    expect(errs.some((e) => e.code === 'self-link')).toBe(true);

    const ok = validateRelationshipValue(relField({ allowSelfLink: true }), [{ itemId: 'self' }], { sourceItemId: 'self' });
    expect(ok).toHaveLength(0);
  });

  it('rejects more than one target on a single-value field', () => {
    const errs = validateRelationshipValue(relField({ multiValue: false }), [{ itemId: 'a' }, { itemId: 'b' }], { sourceItemId: 's' });
    expect(errs.some((e) => e.code === 'too-many')).toBe(true);
  });

  it('rejects targets whose tracker type is not allowed', () => {
    const def = relField({ targetTrackerTypes: ['bug', 'feature'] });
    const errs = validateRelationshipValue(def, [{ itemId: 'x', trackerType: 'plan' }], { sourceItemId: 's' });
    expect(errs.some((e) => e.code === 'target-type')).toBe(true);

    const ok = validateRelationshipValue(def, [{ itemId: 'x', trackerType: 'bug' }], { sourceItemId: 's' });
    expect(ok).toHaveLength(0);
  });

  it('uses the targetTypeOf resolver when the value omits the type', () => {
    const def = relField({ targetTrackerTypes: ['bug'] });
    const errs = validateRelationshipValue(def, [{ itemId: 'x' }], {
      sourceItemId: 's',
      targetTypeOf: () => 'plan',
    });
    expect(errs.some((e) => e.code === 'target-type')).toBe(true);
  });

  it("accepts '*' target types and flags duplicates", () => {
    const def = relField({ targetTrackerTypes: '*' });
    const errs = validateRelationshipValue(def, [{ itemId: 'a' }, { itemId: 'a' }], { sourceItemId: 's' });
    expect(errs.some((e) => e.code === 'duplicate')).toBe(true);
  });
});

describe('add/remove/serialize', () => {
  it('adds to a multi-value set (add-wins, dedup) and stamps direction+type', () => {
    const def = relField();
    let val = addRelationshipValue(def, null, { itemId: 'a', title: 'A' });
    val = addRelationshipValue(def, val, { itemId: 'b' });
    val = addRelationshipValue(def, val, { itemId: 'a', title: 'A2' }); // re-add updates
    expect(val.map((v) => v.itemId)).toEqual(['b', 'a']);
    const a = val.find((v) => v.itemId === 'a')!;
    expect(a.direction).toBe('out');
    expect(a.relationshipTypeKey).toBe('depends-on');
    expect(a.title).toBe('A2');
  });

  it('replaces the target on a single-value field', () => {
    const def = relField({ multiValue: false });
    const val = addRelationshipValue(def, { itemId: 'old' }, { itemId: 'new' });
    expect(val).toHaveLength(1);
    expect(val[0].itemId).toBe('new');
  });

  it('removes by itemId', () => {
    const start: TrackerRelationshipValue[] = [{ itemId: 'a' }, { itemId: 'b' }];
    expect(removeRelationshipValue(start, 'a')).toEqual([{ itemId: 'b' }]);
  });

  it('serializes single vs multi shape', () => {
    expect(serializeRelationshipValue(relField({ multiValue: false }), [])).toBeNull();
    expect(serializeRelationshipValue(relField({ multiValue: false }), [{ itemId: 'a' }])).toEqual({ itemId: 'a' });
    expect(serializeRelationshipValue(relField(), [{ itemId: 'a' }])).toEqual([{ itemId: 'a' }]);
  });
});

describe('deriveRelationshipEdges', () => {
  const defs: FieldDefinition[] = [
    { name: 'title', type: 'string' },
    relField({ name: 'dependsOn', relationshipTypeKey: 'depends-on' }),
    relField({ name: 'relatesTo', relationshipTypeKey: 'relates-to', multiValue: false }),
  ];

  it('emits one edge per target across relationship fields only', () => {
    const edges = deriveRelationshipEdges('src', {
      title: 'ignored',
      dependsOn: [{ itemId: 'a', trackerType: 'bug' }, { itemId: 'b' }],
      relatesTo: { itemId: 'c' },
    }, defs);

    expect(edges).toHaveLength(3);
    const dep = edges.filter((e) => e.sourceFieldId === 'dependsOn');
    expect(dep.map((e) => e.targetItemId).sort()).toEqual(['a', 'b']);
    expect(dep[0].relationshipTypeKey).toBe('depends-on');
    expect(dep.find((e) => e.targetItemId === 'a')?.targetTrackerType).toBe('bug');
    expect(edges.find((e) => e.sourceFieldId === 'relatesTo')?.relationshipTypeKey).toBe('relates-to');
  });

  it('returns no edges for an item with no relationship values', () => {
    expect(deriveRelationshipEdges('src', { title: 'x' }, defs)).toEqual([]);
    expect(deriveRelationshipEdges('src', undefined, defs)).toEqual([]);
  });

  it('prefers a per-value relationshipTypeKey over the field default', () => {
    const edges = deriveRelationshipEdges('src', {
      dependsOn: [{ itemId: 'a', relationshipTypeKey: 'blocks' }],
    }, defs);
    expect(edges[0].relationshipTypeKey).toBe('blocks');
  });
});

describe('computeInverseFieldDeltas (Phase 3)', () => {
  const def = relField({
    name: 'dependsOn',
    relationshipTypeKey: 'depends-on',
    inverseFieldId: 'blockedBy',
    inverseRelationshipTypeKey: 'blocks',
  });
  const source: { itemId: string; issueKey?: string; trackerType?: string } = {
    itemId: 'plan-1',
    issueKey: 'NIM-1',
    trackerType: 'plan',
  };

  it('returns no deltas when the field has no inverseFieldId', () => {
    const noInverse = relField({ inverseFieldId: undefined });
    expect(computeInverseFieldDeltas(noInverse, source, null, [{ itemId: 'bug-1' }])).toEqual([]);
  });

  it('emits an add for newly-linked targets, stamping the inverse type + source ref', () => {
    const deltas = computeInverseFieldDeltas(def, source, null, [{ itemId: 'bug-1' }]);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ targetItemId: 'bug-1', inverseFieldId: 'blockedBy', op: 'add' });
    expect(deltas[0].value).toMatchObject({
      itemId: 'plan-1',
      issueKey: 'NIM-1',
      trackerType: 'plan',
      relationshipTypeKey: 'blocks',
      direction: 'out',
    });
  });

  it('emits a remove for dropped targets', () => {
    const deltas = computeInverseFieldDeltas(def, source, [{ itemId: 'bug-1' }], []);
    expect(deltas).toEqual([
      expect.objectContaining({ targetItemId: 'bug-1', inverseFieldId: 'blockedBy', op: 'remove' }),
    ]);
  });

  it('emits add+remove together when the set changes', () => {
    const deltas = computeInverseFieldDeltas(def, source, [{ itemId: 'bug-1' }], [{ itemId: 'bug-2' }]);
    expect(deltas.filter((d) => d.op === 'add').map((d) => d.targetItemId)).toEqual(['bug-2']);
    expect(deltas.filter((d) => d.op === 'remove').map((d) => d.targetItemId)).toEqual(['bug-1']);
  });

  it('no-ops when the target set is unchanged', () => {
    expect(computeInverseFieldDeltas(def, source, [{ itemId: 'bug-1' }], [{ itemId: 'bug-1' }])).toEqual([]);
  });
});
