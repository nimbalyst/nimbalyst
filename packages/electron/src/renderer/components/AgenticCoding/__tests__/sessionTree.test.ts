// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildSessionTree,
  mergedTreeHeader,
  sessionMoveError,
  sessionTreeRootId,
  treeIndent,
  visibleSessionTreeIds,
  type TreeSession,
} from '../sessionTreeModel';
const row = (
  id: string,
  parentSessionId: string | null = null,
  extra: Partial<TreeSession> = {}
): TreeSession => ({ id, parentSessionId, createdAt: 1, ...extra });
describe('session tree projection', () => {
  it('sorts siblings by pins then subtree activity and includes the root in file rollups', () => {
    const [root] = buildSessionTree([
      row('root', null, { uncommittedCount: 2 }),
      row('idle', 'root'),
      row('active', 'idle', { updatedAt: 20, uncommittedCount: 3 }),
      row('recent', 'root', { updatedAt: 10 }),
      row('pin', 'root', { isPinned: true }),
    ]);
    expect(root.children.map((n) => n.session.id)).toEqual(['pin', 'idle', 'recent']);
    expect(root.activity).toBe(20);
    expect(root.uncommittedCount).toBe(5);
    expect(root.ids).toHaveLength(5);
  });
  it('merges only single-child wrappers and safely retains orphans and cyclic rows', () => {
    const [wrapper] = buildSessionTree([
      row('wrapper', null, { sessionType: 'workstream' }),
      row('child', 'wrapper'),
    ]);
    expect(mergedTreeHeader(wrapper).session.id).toBe('child');
    const [ordinary] = buildSessionTree([row('root'), row('child', 'root')]);
    expect(mergedTreeHeader(ordinary)).toBe(ordinary);
    const roots = buildSessionTree([
      row('a', 'b'),
      row('b', 'a'),
      row('orphan', 'missing'),
      row('foreign', 'a', { worktreeId: 'other' }),
    ]);
    expect(roots.flatMap((n) => n.ids).sort()).toEqual(['a', 'b', 'foreign', 'orphan']);
    expect(treeIndent(8)).toEqual({ level: 3, rail: true });
  });
  it('range selection follows rendered sibling order and excludes collapsed descendants and merged wrappers', () => {
    const rows = [
      row('wrapper', null, { sessionType: 'workstream' }),
      row('root', 'wrapper'),
      row('older', 'root'),
      row('newer', 'root', { updatedAt: 3 }),
      row('hidden', 'older'),
    ];
    expect(visibleSessionTreeIds(rows, (node) => node.session.id === 'root')).toEqual([
      'root',
      'newer',
      'older',
    ]);
  });
  it('resolves deep tab roots and rejects cycles, containers, cross-worktree and subtree depth overflow', () => {
    const rows = new Map(
      Array.from({ length: 9 }, (_, i) => row(String(i), i ? String(i - 1) : null)).map((r) => [r.id, r])
    );
    rows.set('branch', row('branch'));
    rows.set('leaf', row('leaf', 'branch'));
    expect(sessionTreeRootId('8', rows)).toBe('0');
    expect(sessionMoveError(rows, '0', '8')).toMatch(/descendant/);
    expect(sessionMoveError(rows, 'branch', '7')).toMatch(/8 levels/);
    expect(sessionMoveError(rows, 'branch', '6')).toBeNull();
    rows.set('foreign', row('foreign', null, { worktreeId: 'other' }));
    expect(sessionMoveError(rows, 'branch', 'foreign')).toMatch(/same worktree/);
    expect(sessionMoveError(rows, '8', null)).toBeNull();
  });
});
