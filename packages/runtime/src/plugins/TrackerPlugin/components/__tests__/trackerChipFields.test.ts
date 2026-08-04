// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { globalRegistry } from '../../models';
import type { TrackerDataModel } from '../../models/TrackerDataModel';
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
  sync: { mode: 'local', scope: 'workspace' },
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
