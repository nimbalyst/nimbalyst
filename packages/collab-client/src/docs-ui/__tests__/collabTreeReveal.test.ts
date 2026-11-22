// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CollabTreeNode } from '@nimbalyst/collab-client/docs';
import { itemRowIdForDocument, revealKeysFor } from '../collabTreeReveal';

const doc = (documentId: string, path: string, children?: CollabTreeNode[]): CollabTreeNode => ({
  id: `document:${documentId}`,
  type: 'document',
  path,
  name: path.split('/').pop()!,
  document: { documentId } as never,
  ...(children ? { children } : {}),
});

// Home page > Initiatives type > an initiative item > a page parented to that item.
const tree: CollabTreeNode[] = [
  doc('home', 'Initiatives', [
    {
      id: 'type:initiative',
      type: 'type',
      typeId: 'initiative',
      path: 'Initiatives/Initiatives',
      name: 'Initiatives',
      children: [
        {
          id: 'item:init-1',
          type: 'item',
          itemId: 'init-1',
          path: 'Initiatives/Initiatives/Pages',
          name: 'Pages',
          children: [doc('child-page', 'Initiatives/Initiatives/Pages/Child page')],
        },
      ],
    } as never,
  ]),
];

describe('revealKeysFor', () => {
  it('opens the item and type rows above a page parented to a typed item', () => {
    expect(revealKeysFor(tree, { itemId: null, typeId: null, documentId: 'child-page' })).toEqual([
      'Initiatives',
      'type:initiative',
      'item:init-1',
    ]);
  });

  it('returns null for a document that is not in the tree', () => {
    expect(revealKeysFor(tree, { itemId: null, typeId: null, documentId: 'missing' })).toBeNull();
  });
});

describe('itemRowIdForDocument', () => {
  // A local wiki typed page opens as a file tab but is drawn as the item row
  // its tracker record makes, whose itemId is the page id.
  it('finds the item row drawn for a typed page', () => {
    expect(itemRowIdForDocument(tree, 'init-1')).toBe('init-1');
  });

  it('is null for a page drawn as a page row, or no page', () => {
    expect(itemRowIdForDocument(tree, 'child-page')).toBeNull();
    expect(itemRowIdForDocument(tree, null)).toBeNull();
  });
});
