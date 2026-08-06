// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { globalRegistry } from '../../models';
import type { TrackerDataModel } from '../../models/TrackerDataModel';
import {
  getTrackerFieldLayout,
  isTrackerFieldEmpty,
  isTrackerRecordEditable,
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
  sync: { mode: 'local', scope: 'workspace' },
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
