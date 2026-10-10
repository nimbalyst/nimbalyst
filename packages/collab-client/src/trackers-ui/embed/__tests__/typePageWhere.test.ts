// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createItemWhereResolver } from '../typePageWhere';

const pages = [
  { folderId: 'arch', parentFolderId: null, name: 'Architecture' },
  { folderId: 'overview', parentFolderId: 'arch', name: 'Overview' },
  { folderId: 'loop-a', parentFolderId: 'loop-b', name: 'A' },
  { folderId: 'loop-b', parentFolderId: 'loop-a', name: 'B' },
];

describe('createItemWhereResolver', () => {
  const where = createItemWhereResolver({
    placements: [
      { itemId: 'sync', parentId: 'overview' },
      { itemId: 'top', parentId: null },
      { itemId: 'orphan', parentId: 'deleted-page' },
      { itemId: 'looped', parentId: 'loop-a' },
    ],
    pages,
    typeLabel: 'Modules',
    rootLabel: 'Team',
  });

  it('names the page a placed item lives under, root first', () => {
    expect(where('sync')).toBe('Architecture / Overview');
    expect(where('top')).toBe('Team');
  });

  it('names the type for an item with no placement, or one whose page is gone', () => {
    expect(where('tracker-engine')).toBe('Modules');
    expect(where('orphan')).toBe('Modules');
  });

  it('stops at a parent cycle', () => {
    expect(where('looped')).toBe('B / A');
  });

  it('walks up through typed pages, naming each by its title', () => {
    const nested = createItemWhereResolver({
      placements: [
        { itemId: 'child', parentId: 'sync', parentKind: 'item' },
        { itemId: 'sync', parentId: 'overview' },
        { itemId: 'under-unplaced', parentId: 'loose', parentKind: 'item' },
      ],
      pages: [...pages, { folderId: 'notes', parentFolderId: 'sync', parentKind: 'item', name: 'Notes' }],
      typeLabel: 'Modules',
      rootLabel: 'Team',
      itemTitle: (itemId) => ({ sync: 'Sync engine', loose: 'Loose' } as Record<string, string>)[itemId] ?? null,
    });
    expect(nested('child')).toBe('Architecture / Overview / Sync engine');
    expect(nested('under-unplaced')).toBe('Loose');
  });
});
