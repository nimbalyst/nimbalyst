import { describe, it, expect } from 'vitest';
import type { FieldDefinition } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  readStoredFieldValue,
  nestRelationshipFieldsIntoCustomFields,
  flattenDataForRead,
} from '../relationshipFieldStorage';

const defs: FieldDefinition[] = [
  { name: 'title', type: 'string' },
  { name: 'features', type: 'relationship', relationshipTypeKey: 'parent-of', multiValue: true },
  { name: 'parentModule', type: 'relationship', relationshipTypeKey: 'child-of', multiValue: false },
];

describe('readStoredFieldValue', () => {
  it('reads a nested customFields value (synced shape)', () => {
    const data = { title: 'M', customFields: { features: [{ itemId: 'f1' }] } };
    expect(readStoredFieldValue(data, 'features')).toEqual([{ itemId: 'f1' }]);
  });

  it('falls back to the top-level value (legacy/local shape)', () => {
    const data = { title: 'M', features: [{ itemId: 'f1' }] };
    expect(readStoredFieldValue(data, 'features')).toEqual([{ itemId: 'f1' }]);
  });

  it('prefers nested over a stale top-level shadow', () => {
    const data = { features: [{ itemId: 'stale' }], customFields: { features: [{ itemId: 'fresh' }] } };
    expect(readStoredFieldValue(data, 'features')).toEqual([{ itemId: 'fresh' }]);
  });

  it('returns undefined when absent', () => {
    expect(readStoredFieldValue({ title: 'M' }, 'features')).toBeUndefined();
    expect(readStoredFieldValue(null, 'features')).toBeUndefined();
  });
});

describe('nestRelationshipFieldsIntoCustomFields', () => {
  it('moves top-level relationship fields into customFields, preserving siblings', () => {
    const data: Record<string, unknown> = {
      title: 'M',
      features: [{ itemId: 'f1' }],
      customFields: { sourceDocument: 'doc.md', bodyVersion: 0 },
    };
    nestRelationshipFieldsIntoCustomFields(data, defs);
    expect('features' in data).toBe(false); // top-level shadow removed
    expect(data.customFields).toEqual({
      sourceDocument: 'doc.md',
      bodyVersion: 0,
      features: [{ itemId: 'f1' }],
    });
    expect(data.title).toBe('M'); // non-relationship field untouched
  });

  it('creates the customFields bag when none exists', () => {
    const data: Record<string, unknown> = { title: 'M', parentModule: { itemId: 'm0' } };
    nestRelationshipFieldsIntoCustomFields(data, defs);
    expect(data.customFields).toEqual({ parentModule: { itemId: 'm0' } });
    expect('parentModule' in data).toBe(false);
  });

  it('leaves an already-nested relationship field alone (no top-level shadow)', () => {
    const data: Record<string, unknown> = { title: 'M', customFields: { features: [{ itemId: 'f1' }] } };
    nestRelationshipFieldsIntoCustomFields(data, defs);
    expect(data.customFields).toEqual({ features: [{ itemId: 'f1' }] });
  });

  it('drops a stale top-level shadow instead of overwriting the canonical nested value', () => {
    const data: Record<string, unknown> = {
      title: 'M',
      features: [],
      customFields: { features: [{ itemId: 'f1' }], sourceDocument: 'doc.md' },
    };
    nestRelationshipFieldsIntoCustomFields(data, defs);
    expect('features' in data).toBe(false);
    expect(data.customFields).toEqual({
      features: [{ itemId: 'f1' }],
      sourceDocument: 'doc.md',
    });
  });

  it('lets an explicitly-written top-level relationship replace the nested value', () => {
    const data: Record<string, unknown> = {
      title: 'M',
      features: [{ itemId: 'f2' }],
      customFields: { features: [{ itemId: 'f1' }], sourceDocument: 'doc.md' },
    };
    nestRelationshipFieldsIntoCustomFields(data, defs, { writtenFields: ['features'] });
    expect('features' in data).toBe(false);
    expect(data.customFields).toEqual({
      features: [{ itemId: 'f2' }],
      sourceDocument: 'doc.md',
    });
  });
});

describe('flattenDataForRead', () => {
  it('lifts nested customFields to the top level', () => {
    const data = { title: 'M', customFields: { features: [{ itemId: 'f1' }], sourceDocument: 'doc.md' } };
    const flat = flattenDataForRead(data);
    expect(flat.features).toEqual([{ itemId: 'f1' }]);
    expect(flat.sourceDocument).toBe('doc.md');
    expect('customFields' in flat).toBe(false);
    // original is not mutated
    expect((data as any).features).toBeUndefined();
  });

  it('returns a copy when there is no nested bag', () => {
    const data = { title: 'M', features: [{ itemId: 'f1' }] };
    expect(flattenDataForRead(data)).toEqual({ title: 'M', features: [{ itemId: 'f1' }] });
  });
});
