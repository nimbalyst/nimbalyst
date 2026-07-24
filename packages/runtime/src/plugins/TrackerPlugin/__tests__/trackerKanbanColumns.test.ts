import { describe, it, expect, afterEach } from 'vitest';
import type { TrackerRecord } from '../../../core/TrackerRecord';
import { globalRegistry, type TrackerDataModel } from '../models/TrackerDataModel';
import { orderKanbanColumns, buildKanbanStatusColumns } from '../trackerRecordAccessors';

function makeRecord(primaryType: string, status: string): TrackerRecord {
  return {
    id: `${primaryType}-${status}-${Math.random().toString(36).slice(2)}`,
    primaryType,
    typeTags: [primaryType],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: { workspace: '/ws', createdAt: '', updatedAt: '' },
    fields: { status },
  };
}

describe('orderKanbanColumns (pure ordering helper)', () => {
  it('uses the schema option order as authoritative', () => {
    const options = [
      { value: 'backlog', label: 'Backlog' },
      { value: 'active', label: 'Active' },
      { value: 'shipped', label: 'Shipped' },
    ];
    const cols = orderKanbanColumns(options, ['active', 'backlog', 'shipped']);
    expect(cols.map(c => c.value)).toEqual(['backlog', 'active', 'shipped']);
    expect(cols.map(c => c.label)).toEqual(['Backlog', 'Active', 'Shipped']);
  });

  it('does not reorder columns based on item status frequency', () => {
    const options = [
      { value: 'one', label: 'One' },
      { value: 'two', label: 'Two' },
    ];
    // Many items in "two" must not push it ahead of "one".
    const cols = orderKanbanColumns(options, ['two', 'two', 'two', 'one']);
    expect(cols.map(c => c.value)).toEqual(['one', 'two']);
  });

  it('appends statuses found in items but missing from the schema, in first-seen order', () => {
    const options = [{ value: 'open', label: 'Open' }];
    const cols = orderKanbanColumns(options, ['open', 'mystery', 'another-one', 'mystery']);
    expect(cols.map(c => c.value)).toEqual(['open', 'mystery', 'another-one']);
    // Derived labels are title-cased from the kebab status.
    expect(cols.find(c => c.value === 'another-one')?.label).toBe('Another One');
  });

  it('falls back to default columns when there are no schema options', () => {
    const cols = orderKanbanColumns([], []);
    expect(cols.map(c => c.value)).toEqual(['to-do', 'in-progress', 'in-review', 'done']);
  });

  it('dedupes duplicate schema option values', () => {
    const options = [
      { value: 'a', label: 'A' },
      { value: 'a', label: 'A dup' },
      { value: 'b', label: 'B' },
    ];
    const cols = orderKanbanColumns(options, []);
    expect(cols.map(c => c.value)).toEqual(['a', 'b']);
  });
});

describe('buildKanbanStatusColumns (schema-driven, via registry)', () => {
  const customType = 'kanbanOrderSpec';

  afterEach(() => {
    globalRegistry.unregister(customType);
  });

  function registerCustom(): void {
    const model: TrackerDataModel = {
      type: customType,
      displayName: 'Spec',
      displayNamePlural: 'Specs',
      icon: 'spec',
      color: '#000',
      modes: { inline: true, fullDocument: false },
      idPrefix: 'spc',
      idFormat: 'ulid',
      fields: [
        { name: 'title', type: 'string', required: true },
        {
          name: 'phase',
          type: 'select',
          options: [
            { value: 'triage', label: 'Triage' },
            { value: 'building', label: 'Building' },
            { value: 'verifying', label: 'Verifying' },
            { value: 'shipped', label: 'Shipped' },
          ],
        },
      ],
      roles: { title: 'title', workflowStatus: 'phase' },
    };
    globalRegistry.register(model);
  }

  it('derives column order from the workflowStatus field options of a custom type', () => {
    registerCustom();
    const items = [
      makeRecordWithField(customType, 'phase', 'shipped'),
      makeRecordWithField(customType, 'phase', 'triage'),
    ];
    const cols = buildKanbanStatusColumns(customType, items);
    expect(cols.map(c => c.value)).toEqual(['triage', 'building', 'verifying', 'shipped']);
  });

  it('falls back to defaults for the "all" pseudo-type', () => {
    const cols = buildKanbanStatusColumns('all', []);
    expect(cols.map(c => c.value)).toEqual(['to-do', 'in-progress', 'in-review', 'done']);
  });
});

function makeRecordWithField(primaryType: string, field: string, value: string): TrackerRecord {
  const r = makeRecord(primaryType, '');
  r.fields = { [field]: value };
  return r;
}
