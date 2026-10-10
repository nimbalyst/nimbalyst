// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { globalRegistry } from '../../models';
import type { TrackerDataModel } from '@nimbalyst/tracker-schema';
import {
  getTrackerChipFieldSections,
  getTrackerTagsField,
  isChipRenderableField,
} from '../trackerChipFields';

const model: TrackerDataModel = {
  type: 'chipFieldSpec',
  displayName: 'Spec',
  displayNamePlural: 'Specs',
  icon: 'assignment',
  color: 'var(--nim-primary)',
  modes: { inline: true, fullDocument: true },
  idPrefix: 'CFS',
  idFormat: 'ulid',
  sharing: 'personal',
  draftByDefault: false,
  fields: [
    { name: 'title', type: 'string', required: true },
    { name: 'description', type: 'text' },
    { name: 'state', type: 'select', options: [{ value: 'open', label: 'Open' }] },
    { name: 'progress', type: 'number', min: 0, max: 100 },
    { name: 'stakeholders', type: 'array', itemType: 'string' },
    { name: 'agentSessions', type: 'array', itemType: 'object' },
    { name: 'payload', type: 'object' },
    { name: 'updated', type: 'datetime', readOnly: true },
    { name: 'externalId', type: 'string', readOnly: true },
  ],
  roles: { title: 'title', workflowStatus: 'state', progress: 'progress' },
};

describe('getTrackerChipFieldSections', () => {
  it('chips the layout fields and overflows the ones no chip can carry', () => {
    globalRegistry.register(model);

    const { chipFields, overflowFields } = getTrackerChipFieldSections(model.type);

    // `tags` is contributed by the registry and lands in role order.
    expect(chipFields.map((field) => field.name))
      .toEqual(['state', 'tags', 'progress', 'stakeholders']);
    // An array of objects has no one-line form; the opaque object and the
    // read-only value the layout drops still have to go somewhere.
    expect(overflowFields.map((field) => field.name))
      .toEqual(['agentSessions', 'payload', 'externalId']);
  });

  it('keeps lists by default (StatusBar, classic detail) and drops them only for a page header', () => {
    globalRegistry.register({
      ...model,
      type: 'chipFieldPageSpec',
      fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'number', type: 'number' },
        { name: 'areas', type: 'multiselect', options: [{ value: 'a', label: 'A' }] },
        { name: 'buyer', type: 'relationship', targetTrackerTypes: ['persona'] },
        { name: 'labels', type: 'label-ref' },
        { name: 'competitors', type: 'relationship', multiValue: true, targetTrackerTypes: '*' },
        { name: 'supports', type: 'relationship', predicate: 'supports' },
        { name: 'evidence', type: 'citation' },
        { name: 'mvp', type: 'select', options: [{ value: 'in', label: 'In' }] },
        { name: 'state', type: 'select', options: [{ value: 'draft', label: 'Draft' }] },
      ],
      roles: { title: 'title', workflowStatus: 'state' },
    });

    // Label properties are filtered by the same rule as the type's own fields.
    const labelFields = [
      { name: 'segment', type: 'string' as const },
      { name: 'segments', type: 'array' as const, itemType: 'string' as const },
    ];
    // Off by default: tags, label refs and multi-valued links stay chips. (A
    // multiselect never was one; the base layout has no compact form for it.)
    expect(getTrackerChipFieldSections('chipFieldPageSpec', [], labelFields).chipFields.map((field) => field.name))
      .toEqual(['state', 'tags', 'number', 'buyer', 'labels', 'competitors', 'supports', 'evidence', 'mvp', 'segment', 'segments']);
    const page = getTrackerChipFieldSections('chipFieldPageSpec', [], labelFields, { singleValuedOnly: true });
    expect(page.chipFields.map((field) => field.name)).toEqual(['state', 'number', 'buyer', 'mvp', 'segment']);
    expect(page.overflowFields.map((field) => field.name))
      .toEqual(expect.arrayContaining(['tags', 'areas', 'labels', 'competitors', 'supports', 'evidence', 'segments']));
  });

  it('keeps an excluded field out of both sections for a surface that renders it', () => {
    globalRegistry.register(model);

    const { chipFields, overflowFields } = getTrackerChipFieldSections(model.type, ['tags']);

    expect(chipFields.map((field) => field.name)).toEqual(['state', 'progress', 'stakeholders']);
    expect(overflowFields.map((field) => field.name)).not.toContain('tags');
  });

  it('returns empty sections for an unregistered tracker type', () => {
    expect(getTrackerChipFieldSections('not-a-registered-type'))
      .toEqual({ chipFields: [], overflowFields: [] });
  });
});

describe('isChipRenderableField', () => {
  it('rejects only arrays of objects', () => {
    expect(isChipRenderableField({ name: 'a', type: 'array', itemType: 'object' })).toBe(false);
    expect(isChipRenderableField({ name: 'a', type: 'array', itemType: 'string' })).toBe(true);
    expect(isChipRenderableField({ name: 'a', type: 'select' })).toBe(true);
  });
});

describe('getTrackerTagsField', () => {
  it('resolves the tags field through the schema role', () => {
    globalRegistry.register({
      ...model,
      type: 'chipFieldRoleSpec',
      fields: [...model.fields, { name: 'labels', type: 'array', itemType: 'string' }],
      roles: { ...model.roles, tags: 'labels' },
    });

    expect(getTrackerTagsField('chipFieldRoleSpec')?.name).toBe('labels');
  });

  it('falls back to the conventional name, and is null for an unknown type', () => {
    globalRegistry.register(model);
    expect(getTrackerTagsField(model.type)?.name).toBe('tags');
    expect(getTrackerTagsField('not-a-registered-type')).toBeNull();
  });
});
