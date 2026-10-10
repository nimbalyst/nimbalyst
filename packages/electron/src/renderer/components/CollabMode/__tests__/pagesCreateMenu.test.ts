// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { CollabSidebarCreateMenu } from '@nimbalyst/collab-client/docs-ui';
import { composePagesCreateMenu } from '../pagesCreateMenu';

const menu = (pageTree: boolean): CollabSidebarCreateMenu => ({
  items: [],
  destination: null,
  onPrimary: vi.fn(),
  onNewFolder: vi.fn(),
  pageTree,
});

describe('composePagesCreateMenu', () => {
  it('offers folders only for a tree that still has them', () => {
    const ids = (team: boolean, personal: boolean) =>
      composePagesCreateMenu(menu(team), menu(personal))?.items.map((item) => item.id);
    expect(ids(false, false)).toEqual(['folder', 'personal-page', 'personal-folder']);
    // A page tree has no folders: a folder is a page with an empty body.
    expect(ids(true, true)).toEqual(['personal-page']);
    expect(composePagesCreateMenu(null, menu(true))?.items).toEqual([]);
  });

  it('adds Add from Files last, opening on Team when there is one and on Personal otherwise', () => {
    const add = vi.fn();
    const items = (team: CollabSidebarCreateMenu | null) => composePagesCreateMenu(team, menu(true), add)!.items;
    items(menu(true)).at(-1)!.onSelect();
    items(null).at(-1)!.onSelect();
    expect(add.mock.calls).toEqual([['team'], ['personal']]);
  });
});
