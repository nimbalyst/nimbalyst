import { describe, it, expect } from 'vitest';
import type { FieldDefinition } from '../../models/TrackerDataModel';
import {
  resolveCellEditor,
  coerceCellValue,
  formatCellForEditor,
  isFieldEditableInGrid,
} from '../trackerCellEditors';

const field = (partial: Partial<FieldDefinition> & Pick<FieldDefinition, 'name' | 'type'>): FieldDefinition =>
  partial as FieldDefinition;

describe('resolveCellEditor', () => {
  it('maps each schema field type to its grid editor', () => {
    expect(resolveCellEditor(field({ name: 'title', type: 'string' })).kind).toBe('text');
    expect(resolveCellEditor(field({ name: 'notes', type: 'text' })).kind).toBe('multiline');
    expect(resolveCellEditor(field({ name: 'points', type: 'number' })).kind).toBe('number');
    expect(resolveCellEditor(field({ name: 'status', type: 'select' })).kind).toBe('select');
    expect(resolveCellEditor(field({ name: 'labels', type: 'multiselect' })).kind).toBe('multiselect');
    expect(resolveCellEditor(field({ name: 'due', type: 'date' })).kind).toBe('date');
    expect(resolveCellEditor(field({ name: 'at', type: 'datetime' })).kind).toBe('datetime');
    expect(resolveCellEditor(field({ name: 'done', type: 'boolean' })).kind).toBe('boolean');
    expect(resolveCellEditor(field({ name: 'owner', type: 'user' })).kind).toBe('user');
    expect(resolveCellEditor(field({ name: 'link', type: 'url' })).kind).toBe('url');
    expect(resolveCellEditor(field({ name: 'blocks', type: 'relationship' })).kind).toBe('relationship');
  });

  it('treats readOnly fields, objects, and missing fields as non-editable', () => {
    expect(resolveCellEditor(undefined).kind).toBe('readonly');
    expect(resolveCellEditor(field({ name: 'meta', type: 'object' })).kind).toBe('readonly');
    expect(resolveCellEditor(field({ name: 'computed', type: 'string', readOnly: true })).kind).toBe('readonly');
  });

  it('carries select options and relationship cardinality onto the descriptor', () => {
    const select = resolveCellEditor(
      field({ name: 'status', type: 'select', options: [{ value: 'open', label: 'Open' }] }),
    );
    expect(select.options).toEqual([{ value: 'open', label: 'Open' }]);

    const rel = resolveCellEditor(
      field({ name: 'blocks', type: 'relationship', multiValue: true, relationshipTypeKey: 'blocks' }),
    );
    expect(rel.multiValue).toBe(true);
    expect(rel.relationshipTypeKey).toBe('blocks');
  });
});

describe('isFieldEditableInGrid', () => {
  it('never allows editing structural columns', () => {
    expect(isFieldEditableInGrid('key', field({ name: 'key', type: 'string' }))).toBe(false);
    expect(isFieldEditableInGrid('updated', field({ name: 'updated', type: 'date' }))).toBe(false);
    expect(isFieldEditableInGrid('shared', field({ name: 'shared', type: 'string' }))).toBe(false);
  });

  it('allows editing schema-backed columns', () => {
    expect(isFieldEditableInGrid('title', field({ name: 'title', type: 'string' }))).toBe(true);
  });
});

describe('coerceCellValue', () => {
  it('parses numbers and discards non-numeric entries', () => {
    const f = field({ name: 'points', type: 'number' });
    expect(coerceCellValue(f, '42')).toBe(42);
    expect(coerceCellValue(f, 7)).toBe(7);
    expect(coerceCellValue(f, 'abc')).toBeUndefined();
    expect(coerceCellValue(f, '')).toBeUndefined();
  });

  it('normalizes booleans from checkbox and text input', () => {
    const f = field({ name: 'done', type: 'boolean' });
    expect(coerceCellValue(f, true)).toBe(true);
    expect(coerceCellValue(f, 'true')).toBe(true);
    expect(coerceCellValue(f, 'yes')).toBe(true);
    expect(coerceCellValue(f, 'no')).toBe(false);
    expect(coerceCellValue(f, '')).toBe(false);
  });

  it('splits pasted comma text into a multiselect array and clears when empty', () => {
    const f = field({ name: 'labels', type: 'multiselect' });
    expect(coerceCellValue(f, 'ui, sync ,  ')).toEqual(['ui', 'sync']);
    expect(coerceCellValue(f, ['a', 'b'])).toEqual(['a', 'b']);
    expect(coerceCellValue(f, '')).toBeUndefined();
  });

  it('keeps a calendar date verbatim so no timezone shift occurs', () => {
    const f = field({ name: 'due', type: 'date' });
    expect(coerceCellValue(f, '2026-07-23')).toBe('2026-07-23');
    expect(coerceCellValue(f, '')).toBeUndefined();
    expect(coerceCellValue(f, 'not a date')).toBeUndefined();
  });

  it('stores url fields in their object shape', () => {
    const f = field({ name: 'link', type: 'url' });
    expect(coerceCellValue(f, 'https://example.com')).toEqual({ url: 'https://example.com' });
    expect(coerceCellValue(f, { url: 'https://x.dev', label: 'X' })).toEqual({ url: 'https://x.dev', label: 'X' });
    expect(coerceCellValue(f, '')).toBeUndefined();
  });

  it('normalizes relationship values and respects single-value cardinality', () => {
    const single = field({ name: 'parent', type: 'relationship' });
    expect(coerceCellValue(single, ['a', 'b'])).toEqual([{ itemId: 'a' }]);

    const multi = field({ name: 'blocks', type: 'relationship', multiValue: true });
    expect(coerceCellValue(multi, ['a', 'b'])).toEqual([{ itemId: 'a' }, { itemId: 'b' }]);
    expect(coerceCellValue(multi, '')).toEqual([]);
  });

  it('returns undefined for a blanked text cell so the field is cleared', () => {
    const f = field({ name: 'title', type: 'string' });
    expect(coerceCellValue(f, 'Fix the thing')).toBe('Fix the thing');
    expect(coerceCellValue(f, '   ')).toBeUndefined();
  });
});

describe('formatCellForEditor', () => {
  it('renders stored values as editable text', () => {
    expect(formatCellForEditor(field({ name: 'labels', type: 'multiselect' }), ['ui', 'sync'])).toBe('ui, sync');
    expect(formatCellForEditor(field({ name: 'link', type: 'url' }), { url: 'https://x.dev' })).toBe('https://x.dev');
    expect(formatCellForEditor(field({ name: 'title', type: 'string' }), undefined)).toBe('');
  });
});
