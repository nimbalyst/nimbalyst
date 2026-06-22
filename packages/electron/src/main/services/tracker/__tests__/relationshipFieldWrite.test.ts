import { describe, it, expect } from 'vitest';
import { applyRelationshipFieldWrites } from '../relationshipFieldWrite';
import type { FieldDefinition } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

const defs: FieldDefinition[] = [
  { name: 'title', type: 'string' },
  { name: 'dependsOn', type: 'relationship', relationshipTypeKey: 'depends-on', multiValue: true, targetTrackerTypes: ['bug', 'feature'] },
  { name: 'parent', type: 'relationship', relationshipTypeKey: 'child-of', multiValue: false },
];

describe('applyRelationshipFieldWrites', () => {
  it('canonicalizes a bare id into the stored multi-value array shape', () => {
    const data: Record<string, unknown> = { title: 'P', dependsOn: 'bug-1' };
    const r = applyRelationshipFieldWrites(data, defs, 'plan-1');
    expect(r.ok).toBe(true);
    expect(data.dependsOn).toEqual([{ itemId: 'bug-1' }]);
  });

  it('canonicalizes a single-value field to one object', () => {
    const data: Record<string, unknown> = { parent: [{ itemId: 'plan-0' }] };
    const r = applyRelationshipFieldWrites(data, defs, 'plan-1');
    expect(r.ok).toBe(true);
    expect(data.parent).toEqual({ itemId: 'plan-0' });
  });

  it('rejects a self-link', () => {
    const data: Record<string, unknown> = { dependsOn: [{ itemId: 'plan-1' }] };
    const r = applyRelationshipFieldWrites(data, defs, 'plan-1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.field).toBe('dependsOn');
  });

  it('rejects a disallowed target tracker type', () => {
    const data: Record<string, unknown> = { dependsOn: [{ itemId: 'x', trackerType: 'plan' }] };
    const r = applyRelationshipFieldWrites(data, defs, 'plan-1');
    expect(r.ok).toBe(false);
  });

  it('uses targetTypeOf when the value omits the type', () => {
    const data: Record<string, unknown> = { dependsOn: [{ itemId: 'x' }] };
    const r = applyRelationshipFieldWrites(data, defs, 'plan-1', () => 'plan');
    expect(r.ok).toBe(false);
  });

  it('treats null/empty as an explicit clear', () => {
    const data: Record<string, unknown> = { dependsOn: null, parent: [] };
    const r = applyRelationshipFieldWrites(data, defs, 'plan-1');
    expect(r.ok).toBe(true);
    expect(data.dependsOn).toEqual([]);
    expect(data.parent).toBeNull();
  });

  it('ignores non-relationship and absent fields', () => {
    const data: Record<string, unknown> = { title: 'unchanged' };
    const r = applyRelationshipFieldWrites(data, defs, 'plan-1');
    expect(r.ok).toBe(true);
    expect(data.title).toBe('unchanged');
    expect('dependsOn' in data).toBe(false);
  });
});
