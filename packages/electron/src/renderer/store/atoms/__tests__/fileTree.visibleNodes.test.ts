import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from 'jotai';
import {
  fileTreeItemsAtom,
  expandedDirsAtom,
  selectedFolderPathAtom,
  selectedPathsAtom,
  dragStateAtom,
  visibleNodesAtom,
  type RendererFileTreeItem,
} from '../fileTree';

/**
 * Unit tests for the visibleNodesAtom derivation.
 *
 * These tests verify the core flattening logic that converts a hierarchical
 * file tree + expanded state into a flat array of visible nodes for
 * the virtualized renderer.
 *
 * We use a standalone Jotai store (not the app store) so tests don't
 * depend on the runtime/store module which requires Electron APIs.
 */

function makeStore() {
  return createStore();
}

function makeTree(items: RendererFileTreeItem[]): RendererFileTreeItem[] {
  return items;
}

describe('visibleNodesAtom', () => {
  let jotaiStore: ReturnType<typeof createStore>;

  beforeEach(() => {
    jotaiStore = makeStore();
  });

  it('should return empty array for empty tree', () => {
    jotaiStore.set(fileTreeItemsAtom, []);
    const nodes = jotaiStore.get(visibleNodesAtom);
    expect(nodes).toEqual([]);
  });

  it('should flatten a flat list of files', () => {
    jotaiStore.set(fileTreeItemsAtom, makeTree([
      { name: 'a.md', path: '/ws/a.md', type: 'file' },
      { name: 'b.md', path: '/ws/b.md', type: 'file' },
    ]));

    const nodes = jotaiStore.get(visibleNodesAtom);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].name).toBe('a.md');
    expect(nodes[0].depth).toBe(0);
    expect(nodes[0].index).toBe(0);
    expect(nodes[0].parentPath).toBeNull();
    expect(nodes[0].type).toBe('file');
    expect(nodes[1].name).toBe('b.md');
    expect(nodes[1].index).toBe(1);
  });

  it('should show directory but skip its children when collapsed', () => {
    jotaiStore.set(fileTreeItemsAtom, makeTree([
      {
        name: 'src', path: '/ws/src', type: 'directory',
        children: [
          { name: 'main.ts', path: '/ws/src/main.ts', type: 'file' },
        ],
      },
      { name: 'readme.md', path: '/ws/readme.md', type: 'file' },
    ]));
    // expandedDirs is empty by default (collapsed)

    const nodes = jotaiStore.get(visibleNodesAtom);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].name).toBe('src');
    expect(nodes[0].type).toBe('directory');
    expect(nodes[0].isExpanded).toBe(false);
    expect(nodes[0].hasChildren).toBe(true);
    expect(nodes[1].name).toBe('readme.md');
  });

  it('should show children when directory is expanded', () => {
    jotaiStore.set(fileTreeItemsAtom, makeTree([
      {
        name: 'src', path: '/ws/src', type: 'directory',
        children: [
          { name: 'main.ts', path: '/ws/src/main.ts', type: 'file' },
          { name: 'utils.ts', path: '/ws/src/utils.ts', type: 'file' },
        ],
      },
    ]));
    jotaiStore.set(expandedDirsAtom, new Set(['/ws/src']));

    const nodes = jotaiStore.get(visibleNodesAtom);
    expect(nodes).toHaveLength(3);
    expect(nodes[0].name).toBe('src');
    expect(nodes[0].isExpanded).toBe(true);
    expect(nodes[0].depth).toBe(0);
    expect(nodes[1].name).toBe('main.ts');
    expect(nodes[1].depth).toBe(1);
    expect(nodes[1].parentPath).toBe('/ws/src');
    expect(nodes[2].name).toBe('utils.ts');
    expect(nodes[2].depth).toBe(1);
  });

  it('should set correct depth for deeply nested items', () => {
    jotaiStore.set(fileTreeItemsAtom, makeTree([
      {
        name: 'a', path: '/ws/a', type: 'directory',
        children: [{
          name: 'b', path: '/ws/a/b', type: 'directory',
          children: [{
            name: 'c', path: '/ws/a/b/c', type: 'directory',
            children: [
              { name: 'deep.ts', path: '/ws/a/b/c/deep.ts', type: 'file' },
            ],
          }],
        }],
      },
    ]));
    jotaiStore.set(expandedDirsAtom, new Set(['/ws/a', '/ws/a/b', '/ws/a/b/c']));

    const nodes = jotaiStore.get(visibleNodesAtom);
    expect(nodes).toHaveLength(4);
    expect(nodes[0].depth).toBe(0); // a
    expect(nodes[1].depth).toBe(1); // b
    expect(nodes[2].depth).toBe(2); // c
    expect(nodes[3].depth).toBe(3); // deep.ts
    expect(nodes[3].parentPath).toBe('/ws/a/b/c');
  });

  it('should only show children of expanded directories, not collapsed ones', () => {
    jotaiStore.set(fileTreeItemsAtom, makeTree([
      {
        name: 'a', path: '/ws/a', type: 'directory',
        children: [{
          name: 'b', path: '/ws/a/b', type: 'directory',
          children: [
            { name: 'inner.ts', path: '/ws/a/b/inner.ts', type: 'file' },
          ],
        }],
      },
    ]));
    // Only expand 'a', not 'b'
    jotaiStore.set(expandedDirsAtom, new Set(['/ws/a']));

    const nodes = jotaiStore.get(visibleNodesAtom);
    expect(nodes).toHaveLength(2); // a, b (b's children hidden)
    expect(nodes[0].name).toBe('a');
    expect(nodes[1].name).toBe('b');
    expect(nodes[1].isExpanded).toBe(false);
    expect(nodes[1].hasChildren).toBe(true);
  });

  it('should mark drag-over target correctly', () => {
    jotaiStore.set(fileTreeItemsAtom, makeTree([
      { name: 'src', path: '/ws/src', type: 'directory', children: [] },
      { name: 'a.md', path: '/ws/a.md', type: 'file' },
    ]));
    jotaiStore.set(dragStateAtom, {
      sourcePaths: ['/ws/a.md'],
      dropTargetPath: '/ws/src',
      isCopy: false,
    });

    const nodes = jotaiStore.get(visibleNodesAtom);
    expect(nodes[0].isDragOver).toBe(true);
    expect(nodes[1].isDragOver).toBe(false);
  });

  it('should mark multi-selected paths correctly', () => {
    jotaiStore.set(fileTreeItemsAtom, makeTree([
      { name: 'a.md', path: '/ws/a.md', type: 'file' },
      { name: 'b.md', path: '/ws/b.md', type: 'file' },
      { name: 'c.md', path: '/ws/c.md', type: 'file' },
    ]));
    jotaiStore.set(selectedPathsAtom, new Set(['/ws/a.md', '/ws/c.md']));

    const nodes = jotaiStore.get(visibleNodesAtom);
    expect(nodes[0].isMultiSelected).toBe(true);
    expect(nodes[1].isMultiSelected).toBe(false);
    expect(nodes[2].isMultiSelected).toBe(true);
  });

  it('should mark selected folder correctly', () => {
    jotaiStore.set(fileTreeItemsAtom, makeTree([
      { name: 'src', path: '/ws/src', type: 'directory', children: [] },
      { name: 'docs', path: '/ws/docs', type: 'directory', children: [] },
    ]));
    jotaiStore.set(selectedFolderPathAtom, '/ws/docs');

    const nodes = jotaiStore.get(visibleNodesAtom);
    expect(nodes[0].isSelected).toBe(false);
    expect(nodes[1].isSelected).toBe(true);
  });

  it('should mark special directories', () => {
    jotaiStore.set(fileTreeItemsAtom, makeTree([
      { name: 'nimbalyst-local', path: '/ws/nimbalyst-local', type: 'directory', children: [] },
      { name: 'src', path: '/ws/src', type: 'directory', children: [] },
    ]));

    const nodes = jotaiStore.get(visibleNodesAtom);
    expect(nodes[0].isSpecialDirectory).toBe(true);
    expect(nodes[1].isSpecialDirectory).toBe(false);
  });

  it('should handle directory with empty children array', () => {
    jotaiStore.set(fileTreeItemsAtom, makeTree([
      { name: 'empty', path: '/ws/empty', type: 'directory', children: [] },
    ]));
    jotaiStore.set(expandedDirsAtom, new Set(['/ws/empty']));

    const nodes = jotaiStore.get(visibleNodesAtom);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].isExpanded).toBe(true);
    expect(nodes[0].hasChildren).toBe(false);
  });

  it('should update when expandedDirs changes', () => {
    jotaiStore.set(fileTreeItemsAtom, makeTree([
      {
        name: 'src', path: '/ws/src', type: 'directory',
        children: [
          { name: 'main.ts', path: '/ws/src/main.ts', type: 'file' },
        ],
      },
    ]));

    // Initially collapsed
    let nodes = jotaiStore.get(visibleNodesAtom);
    expect(nodes).toHaveLength(1);

    // Expand
    jotaiStore.set(expandedDirsAtom, new Set(['/ws/src']));
    nodes = jotaiStore.get(visibleNodesAtom);
    expect(nodes).toHaveLength(2);

    // Collapse again
    jotaiStore.set(expandedDirsAtom, new Set<string>());
    nodes = jotaiStore.get(visibleNodesAtom);
    expect(nodes).toHaveLength(1);
  });

  it('should assign sequential indices', () => {
    jotaiStore.set(fileTreeItemsAtom, makeTree([
      {
        name: 'src', path: '/ws/src', type: 'directory',
        children: [
          { name: 'a.ts', path: '/ws/src/a.ts', type: 'file' },
          { name: 'b.ts', path: '/ws/src/b.ts', type: 'file' },
        ],
      },
      { name: 'readme.md', path: '/ws/readme.md', type: 'file' },
    ]));
    jotaiStore.set(expandedDirsAtom, new Set(['/ws/src']));

    const nodes = jotaiStore.get(visibleNodesAtom);
    expect(nodes.map(n => n.index)).toEqual([0, 1, 2, 3]);
  });
});
