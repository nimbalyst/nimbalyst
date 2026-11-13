// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildSessionTree,
  MAX_TREE_DEPTH,
  mergedTreeHeader,
  rendersAsSessionTree,
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
    // A workstream the user made keeps its row with one session or none.
    for (const children of [[row('only', 'made')], []]) {
      const [made] = buildSessionTree([row('made', null, { sessionType: 'workstream', userWorkstream: true }), ...children]);
      expect(mergedTreeHeader(made)).toBe(made);
      expect(visibleSessionTreeIds([made.session, ...children], () => true)).toEqual(['made', ...children.map((c) => c.id)]);
    }
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
  it('renders an empty workstream container through the tree path, not as a plain session', () => {
    expect(rendersAsSessionTree({ sessionType: 'workstream', childCount: 0 })).toBe(true);
    expect(rendersAsSessionTree({ sessionType: 'session', childCount: 2 })).toBe(true);
    expect(rendersAsSessionTree({ sessionType: 'session', childCount: 0 })).toBe(false);
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
    const D = MAX_TREE_DEPTH;
    const rows = new Map(
      Array.from({ length: D + 1 }, (_, i) => row(String(i), i ? String(i - 1) : null)).map((r) => [r.id, r])
    );
    rows.set('branch', row('branch'));
    rows.set('leaf', row('leaf', 'branch'));
    expect(sessionTreeRootId(String(D), rows)).toBe('0');
    expect(sessionMoveError(rows, '0', String(D))).toMatch(/descendant/);
    expect(sessionMoveError(rows, 'branch', String(D - 1))).toMatch(new RegExp(`${D} levels`));
    expect(sessionMoveError(rows, 'branch', String(D - 2))).toBeNull();
    rows.set('foreign', row('foreign', null, { worktreeId: 'other' }));
    expect(sessionMoveError(rows, 'branch', 'foreign')).toMatch(/same worktree/);
    expect(sessionMoveError(rows, String(D), null)).toBeNull();
  });
});
