// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveSessionArchiveSelection, sessionArchiveSubtreeIds } from '../sessionArchiveSelection';
import type { TreeSession } from '../sessionTreeModel';
const rows: TreeSession[] = [
  {id: 'root', createdAt: 1},
  {id: 'child', parentSessionId: 'root', createdAt: 1},
  {id: 'grandchild', parentSessionId: 'child', createdAt: 1},
  {id: 'sibling', parentSessionId: 'root', createdAt: 1},
  {id: 'worktree-root', worktreeId: 'tree', createdAt: 1},
  {id: 'worktree-child', parentSessionId: 'worktree-root', worktreeId: 'tree', createdAt: 1},
  {id: 'worktree-leaf', parentSessionId: 'worktree-child', worktreeId: 'tree', createdAt: 1},
  {id: 'worktree-sibling', parentSessionId: 'worktree-root', worktreeId: 'tree', createdAt: 1},
];
const registry = new Map(rows.map(row => [row.id, row]));
describe('bulk archive selection', () => {
  it('resolves nested row IDs from the registry and archives selected subtrees once', () => {
    const result = resolveSessionArchiveSelection(registry, new Set(['child', 'grandchild', 'sibling', 'missing']), new Set());
    expect(result.regularSessionIds).toEqual(['child', 'sibling']);
    expect(sessionArchiveSubtreeIds(registry, result.regularSessionIds)).toEqual(['child', 'grandchild', 'sibling']);
    expect(result.worktreeIds).toEqual([]);
  });
  it('archives a nested worktree row without archiving its containing worktree or siblings', () => {
    const result = resolveSessionArchiveSelection(registry, new Set(['worktree-child']), new Set());
    expect(result.regularSessionIds).toEqual(['worktree-child']);
    expect(result.worktreeIds).toEqual([]);
    expect(sessionArchiveSubtreeIds(registry, result.regularSessionIds)).toEqual(['worktree-child', 'worktree-leaf']);
  });
  it('uses worktree cleanup only for an explicitly selected worktree group', () => {
    const result = resolveSessionArchiveSelection(registry, new Set(['worktree-child', 'child']), new Set(['worktree:tree']));
    expect(result.worktreeIds).toEqual(['tree']);
    expect(result.regularSessionIds).toEqual(['child']);
  });
  it('deduplicates a selected workstream and its descendants while retaining other group actions', () => {
    const result = resolveSessionArchiveSelection(registry, new Set(['root', 'child']), new Set(['workstream:root', 'blitz:blitz-id', 'superloop:loop-id']));
    expect(result.workstreamIds).toEqual(['root']);
    expect(result.regularSessionIds).toEqual([]);
    expect(result.blitzIds).toEqual(['blitz-id']);
    expect(result.superLoopIds).toEqual(['loop-id']);
  });
});
