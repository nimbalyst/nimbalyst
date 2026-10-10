// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isSingleValuedField } from '../singleValuedField';
import type { FieldDefinition } from '../TrackerDataModel';

describe('isSingleValuedField', () => {
  it('admits scalar fields and single links, never lists or statements', () => {
    const fields: FieldDefinition[] = [
      { name: 'title', type: 'string' },
      { name: 'notes', type: 'text' },
      { name: 'number', type: 'number' },
      { name: 'status', type: 'select', options: [] },
      { name: 'due', type: 'date' },
      { name: 'at', type: 'datetime' },
      { name: 'done', type: 'boolean' },
      { name: 'owner', type: 'user' },
      { name: 'site', type: 'url' },
      { name: 'buyer', type: 'relationship', multiValue: false },
      { name: 'legacyParent', type: 'reference' },
      { name: 'areas', type: 'multiselect', options: [] },
      { name: 'tags', type: 'array', itemType: 'string' },
      { name: 'labels', type: 'label-ref' },
      { name: 'locator', type: 'object' },
      { name: 'facts', type: 'array', itemType: 'object', objectShape: 'fact' },
      { name: 'evidence', type: 'citation' },
      { name: 'verb', type: 'predicate-ref' },
      { name: 'dependsOn', type: 'relationship', multiValue: true },
      { name: 'legacyLinks', type: 'reference', multiValue: true },
      { name: 'supports', type: 'relationship', predicate: 'supports' },
    ];
    expect(fields.filter(isSingleValuedField).map((field) => field.name)).toEqual([
      'title', 'notes', 'number', 'status', 'due', 'at', 'done', 'owner', 'site', 'buyer', 'legacyParent',
    ]);
  });
});
