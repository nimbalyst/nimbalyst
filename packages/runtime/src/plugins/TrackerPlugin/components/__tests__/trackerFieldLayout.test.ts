// @vitest-environment node
import { afterEach, describe, it, expect } from 'vitest';
import { globalRegistry } from '../../models';
import { emptyLabelRegistry, type TrackerDataModel } from '@nimbalyst/tracker-schema';
import {
  resolveTrackerLabelFields,
  unwrapLabelFieldValues,
  wrapLabelFieldValue,
} from '../trackerLabelFields';
import {
  getTrackerFieldLayout,
  isTrackerFieldEmpty,
  isTrackerRecordEditable,
  shouldLabelTrackerField,
} from '../trackerFieldLayout';
import type { TrackerRecord } from '../../../../core/TrackerRecord';

const model: TrackerDataModel = {
  type: 'fieldLayoutSpec',
  displayName: 'Spec',
  displayNamePlural: 'Specs',
  icon: 'assignment',
  color: 'var(--nim-primary)',
  modes: { inline: true, fullDocument: true },
  idPrefix: 'FLS',
  idFormat: 'ulid',
  sharing: 'personal',
  draftByDefault: false,
  fields: [
    { name: 'title', type: 'string', required: true },
    { name: 'estimate', type: 'number' },
    { name: 'description', type: 'text' },
    { name: 'payload', type: 'object' },
    { name: 'updated', type: 'datetime', readOnly: true },
    { name: 'state', type: 'select', options: [{ value: 'open', label: 'Open' }] },
    { name: 'owner', type: 'user' },
  ],
  roles: { title: 'title', workflowStatus: 'state', assignee: 'owner' },
};

describe('shouldLabelTrackerField', () => {
  it('opts anonymous values into labels while preserving compact headers and option icons', () => {
    const select = { name: 'priority', type: 'select' as const, options: [
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High', icon: 'priority_high' },
    ] };
    expect(shouldLabelTrackerField(select, 'medium')).toBe(false);
    expect(shouldLabelTrackerField(select, 'medium', true)).toBe(true);
    expect(shouldLabelTrackerField(select, 'high', true)).toBe(false);
    expect(shouldLabelTrackerField(select, 'unknown', true)).toBe(true);
    expect(shouldLabelTrackerField(select, '', true)).toBe(false);
    for (const type of ['text', 'number', 'boolean'] as const) {
      const field = { name: 'customValue', type };
      const value = type === 'text' ? 'Example' : type === 'number' ? 0 : false;
      expect(shouldLabelTrackerField(field, value)).toBe(false);
      expect(shouldLabelTrackerField(field, value, true)).toBe(true);
    }
    expect(shouldLabelTrackerField({ name: 'targetDate', type: 'date' }, '2026-09-23')).toBe(true);
    expect(shouldLabelTrackerField({ name: 'answerFormat', type: 'text' }, null, true)).toBe(false);
  });
});

describe('getTrackerFieldLayout', () => {
  it('orders semantic roles first and omits structural, opaque, and read-only fields', () => {
    globalRegistry.register(model);

    // `tags` is contributed by the registry's base fields and lands in role
    // order via the conventional-name fallback, ahead of the leftover schema
    // fields. title/description/updated (structural, read-only) and the opaque
    // object field stay out of the compact surface entirely.
    expect(getTrackerFieldLayout(model.type).map((field) => field.name))
      .toEqual(['state', 'owner', 'tags', 'estimate']);
  });

  it('leaves lists in the default layout and drops them from the header layout', () => {
    globalRegistry.register({
      ...model,
      type: 'fieldLayoutHeaderSpec',
      fields: [
        ...model.fields,
        { name: 'areas', type: 'multiselect', options: [] },
        { name: 'stakeholders', type: 'array', itemType: 'string' },
        { name: 'labels', type: 'label-ref' },
        { name: 'dependsOn', type: 'relationship', multiValue: true },
        { name: 'parent', type: 'relationship' },
      ],
    });

    // Quick create still edits tags and collections through the default layout.
    expect(getTrackerFieldLayout('fieldLayoutHeaderSpec').map((field) => field.name))
      .toEqual(['state', 'owner', 'tags', 'estimate', 'stakeholders', 'labels', 'dependsOn', 'parent']);
    expect(getTrackerFieldLayout('fieldLayoutHeaderSpec', [], { singleValuedOnly: true }).map((field) => field.name))
      .toEqual(['state', 'owner', 'estimate', 'parent']);
  });

  it('returns nothing for an unregistered tracker type', () => {
    expect(getTrackerFieldLayout('not-a-registered-type')).toEqual([]);
  });
});

describe('isTrackerFieldEmpty', () => {
  it('treats blanks, empty arrays, and empty url/relationship objects as unset', () => {
    expect(isTrackerFieldEmpty('')).toBe(true);
    expect(isTrackerFieldEmpty(null)).toBe(true);
    expect(isTrackerFieldEmpty([])).toBe(true);
    expect(isTrackerFieldEmpty({ url: '' })).toBe(true);
    expect(isTrackerFieldEmpty(0)).toBe(false);
    expect(isTrackerFieldEmpty(false)).toBe(false);
    expect(isTrackerFieldEmpty(['a'])).toBe(false);
    expect(isTrackerFieldEmpty({ itemId: 'x' })).toBe(false);
    expect(isTrackerFieldEmpty(new Date('2026-07-30T00:00:00.000Z'))).toBe(false);
    expect(isTrackerFieldEmpty({ custom: 'value' })).toBe(false);
    expect(isTrackerFieldEmpty({})).toBe(true);
  });
});

describe('isTrackerRecordEditable', () => {
  const record = (overrides: Partial<TrackerRecord>): TrackerRecord => ({
    id: 'r1',
    primaryType: model.type,
    typeTags: [model.type],
    issueKey: 'FLS-1',
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: { workspace: '/ws', createdAt: '', updatedAt: '' },
    fields: {},
    ...overrides,
  } as TrackerRecord);

  it('allows edits for native and known file-backed sources', () => {
    expect(isTrackerRecordEditable(record({}))).toBe(true);
    expect(isTrackerRecordEditable(record({
      source: 'frontmatter',
      system: { workspace: '/ws', createdAt: '', updatedAt: '', documentPath: '/ws/a.md' },
    }))).toBe(true);
  });

  it('blocks edits for an unknown file-backed source', () => {
    expect(isTrackerRecordEditable(record({
      source: 'external' as TrackerRecord['source'],
      system: { workspace: '/ws', createdAt: '', updatedAt: '', documentPath: '/ws/a.md' },
    }))).toBe(false);
  });
});

describe('fields that follow labels', () => {
  afterEach(() => {
    globalRegistry.setLabels(emptyLabelRegistry());
    globalRegistry.setPredicates([]);
  });

  function installVocabulary() {
    // Label fields need a type that carries labels.
    globalRegistry.register({ ...model, fields: [...model.fields, { name: 'labels', type: 'label-ref', multiValue: true }] });
    globalRegistry.setPredicates([
      { id: 'part-of-subsystem', label: 'Part of subsystem', subjectKinds: ['*'], valueShape: 'entity', direction: 'directed' },
    ]);
    globalRegistry.setLabels({
      labels: [
        { id: 'capability', label: 'Capability', properties: ['surface'] },
        { id: 'feature', label: 'Feature', broader: ['capability'], properties: ['flag', 'part-of-subsystem', 'estimate', 'mystery'] },
      ],
      properties: [
        { id: 'surface', label: 'Surface', type: 'select', options: ['desktop', 'web'] },
        {
          id: 'flag',
          label: 'Feature flag',
          type: 'string',
          qualifiers: { rollout: { type: 'number', label: 'Rollout %' } },
        },
      ],
      claimProperties: {},
    });
  }

  it('adds a label property the moment the label is applied, and drops it when the label is removed', () => {
    installVocabulary();
    const labeled = resolveTrackerLabelFields(model.type, { labels: ['feature'] });
    // Own label first, then the broader one; `estimate` is already a type field.
    expect(labeled.fields.map((field) => [field.name, field.displayLabel])).toEqual([
      ['flag', 'Feature flag'],
      ['surface', 'Surface'],
    ]);
    // A claim-stored property (earlier knowledge graph) is neither a field nor flagged as unknown.
    expect(labeled.unknown.map((property) => property.id)).toEqual(['mystery']);
    expect(getTrackerFieldLayout(model.type, labeled.fields).map((field) => field.name))
      .toEqual(['state', 'owner', 'tags', 'estimate', 'labels', 'flag', 'surface']);

    const unlabeled = resolveTrackerLabelFields(model.type, { labels: [] });
    expect(getTrackerFieldLayout(model.type, unlabeled.fields).map((field) => field.name))
      .toEqual(['state', 'owner', 'tags', 'estimate', 'labels']);
    // The legacy `kind` is an implicit label.
    expect(resolveTrackerLabelFields(model.type, { kind: 'capability' }).fields.map((field) => field.name))
      .toEqual(['surface']);
  });

  it('edits a legacy qualified value bare and keeps its qualifiers on save', () => {
    installVocabulary();
    const { fields } = resolveTrackerLabelFields(model.type, { labels: ['feature'] });
    const flag = fields.find((field) => field.name === 'flag')!;
    const stored = { flag: { value: 'new-editor', qualifiers: { rollout: 25 } }, surface: 'web' };

    expect(unwrapLabelFieldValues(fields, stored)).toEqual({ flag: 'new-editor', surface: 'web' });
    expect(wrapLabelFieldValue(flag, 'newer-editor', stored.flag))
      .toEqual({ value: 'newer-editor', qualifiers: { rollout: 25 } });
    expect(wrapLabelFieldValue(flag, '', stored.flag)).toBeNull();
    const surface = fields.find((field) => field.name === 'surface')!;
    expect(wrapLabelFieldValue(surface, 'desktop', 'web')).toBe('desktop');
  });

  it('brings no label fields to a type without a label-ref field, whatever its tags say', () => {
    installVocabulary();
    // A bug whose free-form tags live in a `labels` array, and which has a `kind`.
    const bugType: TrackerDataModel = {
      ...model,
      type: 'fieldLayoutBug',
      fields: [...model.fields, { name: 'labels', type: 'array', itemType: 'string' }, { name: 'kind', type: 'string' }],
      roles: { ...model.roles, tags: 'labels' },
    };
    globalRegistry.register(bugType);
    expect(resolveTrackerLabelFields(bugType.type, { labels: ['feature'], kind: 'capability' }))
      .toEqual({ fields: [], unknown: [] });
  });
});
