import { describe, it, expect } from 'vitest';
import {
  TrackerDataModelRegistry,
  ensureTagsSupport,
  type TrackerDataModel,
} from '../TrackerDataModel';

function makeMinimalModel(overrides: Partial<TrackerDataModel> = {}): TrackerDataModel {
  return {
    type: 'widget',
    displayName: 'Widget',
    displayNamePlural: 'Widgets',
    icon: 'widgets',
    color: '#000',
    modes: { inline: true, fullDocument: false },
    idPrefix: 'wid',
    idFormat: 'ulid',
    fields: [
      { name: 'title', type: 'string', required: true },
    ],
    roles: { title: 'title' },
    ...overrides,
  };
}

describe('ensureTagsSupport', () => {
  it('injects a tags field and role when neither is declared', () => {
    const model = makeMinimalModel();
    const normalized = ensureTagsSupport(model);

    expect(normalized.fields.some(f => f.name === 'tags')).toBe(true);
    const tagsField = normalized.fields.find(f => f.name === 'tags')!;
    expect(tagsField.type).toBe('array');
    expect(tagsField.itemType).toBe('string');
    expect(normalized.roles?.tags).toBe('tags');
  });

  it('returns the model unchanged when tags field and role already declared', () => {
    const model = makeMinimalModel({
      fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'tags', type: 'array', itemType: 'string' },
      ],
      roles: { title: 'title', tags: 'tags' },
    });

    const normalized = ensureTagsSupport(model);
    expect(normalized).toBe(model);
  });

  it('preserves an existing tags field but adds the missing role', () => {
    const model = makeMinimalModel({
      fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'tags', type: 'array', itemType: 'string' },
      ],
      roles: { title: 'title' },
    });

    const normalized = ensureTagsSupport(model);
    expect(normalized.fields.filter(f => f.name === 'tags')).toHaveLength(1);
    expect(normalized.roles?.tags).toBe('tags');
  });

  it('respects a custom tags role target and does not overwrite it', () => {
    const model = makeMinimalModel({
      fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'labels', type: 'array', itemType: 'string' },
      ],
      roles: { title: 'title', tags: 'labels' },
    });

    const normalized = ensureTagsSupport(model);
    expect(normalized.roles?.tags).toBe('labels');
    expect(normalized.fields.some(f => f.name === 'tags')).toBe(false);
  });

  it('opts out when supportsTags is false', () => {
    const model = makeMinimalModel({ supportsTags: false });
    const normalized = ensureTagsSupport(model);

    expect(normalized).toBe(model);
    expect(normalized.fields.some(f => f.name === 'tags')).toBe(false);
    expect(normalized.roles?.tags).toBeUndefined();
  });
});

describe('TrackerDataModelRegistry tag auto-default', () => {
  it('auto-injects tags support on register', () => {
    const registry = new TrackerDataModelRegistry();
    registry.register(makeMinimalModel());

    const stored = registry.get('widget')!;
    expect(stored.fields.some(f => f.name === 'tags')).toBe(true);
    expect(stored.roles?.tags).toBe('tags');
  });

  it('skips auto-injection when supportsTags is false', () => {
    const registry = new TrackerDataModelRegistry();
    registry.register(makeMinimalModel({ supportsTags: false }));

    const stored = registry.get('widget')!;
    expect(stored.fields.some(f => f.name === 'tags')).toBe(false);
    expect(stored.roles?.tags).toBeUndefined();
  });
});
