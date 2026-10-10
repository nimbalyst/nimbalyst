// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { CollabTypeRegistry } from '../../docs/collabTypeResolver';
import { browserTypeResolver } from '../browserTypeResolver';

const model = (type: string, sharing: 'team' | 'personal') => ({ type, displayName: type, displayNamePlural: `${type}s`, sharing, fields: [] });
const registry = {
  get: (type: string) => ({ module: model('module', 'team'), note: model('note', 'personal') } as Record<string, unknown>)[type],
  getListed: () => [model('module', 'team'), model('note', 'personal')],
} as unknown as CollabTypeRegistry;

const record = (id: string, primaryType: string, title: string, extra: Partial<TrackerRecord> = {}) => ({
  id, primaryType, typeTags: [primaryType], fields: { title }, system: {}, ...extra,
}) as unknown as TrackerRecord;

describe('browserTypeResolver', () => {
  it('lists the room records under their team type, by issue number, without archived ones', () => {
    const resolver = browserTypeResolver([
      record('b', 'module', ' Sync engine ', { issueNumber: 2 }),
      record('a', 'module', 'Editor', { issueNumber: 1 }),
      record('gone', 'module', 'Old', { archived: true }),
      record('n', 'note', 'Private'),
    ], registry, 'team');
    expect(resolver.itemsOfType?.('module').map((item) => [item.itemId, item.title])).toEqual([['a', 'Editor'], ['b', 'Sync engine']]);
    expect(resolver.item?.('b')).toMatchObject({ title: 'Sync engine', typeId: 'module' });
    // A personal type is not the team section's.
    expect(resolver.item?.('n')).toBeNull();
    expect(resolver.listedTypes?.().map((type) => type.typeId)).toEqual(['module']);
  });
});
