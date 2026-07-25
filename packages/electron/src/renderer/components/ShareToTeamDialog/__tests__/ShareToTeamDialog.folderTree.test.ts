import { describe, expect, it } from 'vitest';
import type { SharedFolder } from '../../../store/atoms/collabDocuments';
import { buildShareFolderTree } from '../ShareToTeamDialog';

function folder(
  folderId: string,
  name: string,
  parentFolderId: string | null = null,
): SharedFolder {
  return {
    folderId,
    parentFolderId,
    name,
    sortOrder: 0,
    createdBy: 'user-1',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('Share-to-Team first-class folder tree', () => {
  it('derives current paths from stable folder ids after rename and move changes', () => {
    const initial = buildShareFolderTree([
      folder('engineering', 'Engineering'),
      folder('specs', 'Specs', 'engineering'),
    ]);
    expect(initial[0]).toMatchObject({
      folderId: 'engineering',
      path: 'Engineering',
      children: [expect.objectContaining({ folderId: 'specs', path: 'Engineering/Specs' })],
    });

    const renamed = buildShareFolderTree([
      folder('engineering', 'Product'),
      folder('specs', 'Specs', 'engineering'),
    ]);
    expect(renamed[0].children[0].path).toBe('Product/Specs');

    const moved = buildShareFolderTree([
      folder('engineering', 'Product'),
      folder('specs', 'Specs'),
    ]);
    expect(moved.map(node => ({ folderId: node.folderId, path: node.path }))).toEqual([
      { folderId: 'engineering', path: 'Product' },
      { folderId: 'specs', path: 'Specs' },
    ]);
  });
});
