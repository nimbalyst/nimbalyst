// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildSessionTree,
  MAX_TREE_DEPTH,
  mergedTreeHeader,
  rendersAsSessionTree,
  sessionMoveError,
  sessionTreeRootId,
  titleSearchReveal,
  titleSearchMatcher,
  searchExpandKey,
  searchExpandEntries,
  bulkTreeExpand,
  treeIndent,
  treeParentIds,
  visibleSessionTreeIds,
  type TreeSession,
} from '../sessionTreeModel';
const row = (
  id: string,
  parentSessionId: string | null = null,
  extra: Partial<TreeSession> = {}
): TreeSession => ({ id, parentSessionId, createdAt: 1, ...extra });
describe('session tree projection', () => {
  const reveal = (rows: TreeSession[], match: (s: TreeSession) => boolean) => {
    const { rootIds, expandIds } = titleSearchReveal(new Map(rows.map(r => [r.id, r])), match);
    return { rootIds: [...rootIds].sort(), expandIds: [...expandIds].sort() };
  };
  it('keeps the root of a nested title match and opens only its ancestors', () => {
    const rows = [row('root'), row('parent', 'root'), row('Пост-запуск', 'parent'), row('other', 'parent')];
    expect(reveal(rows, s => s.id.toLowerCase().includes('пост'))).toEqual({ rootIds: ['root'], expandIds: ['parent', 'root'] });
    expect(reveal(rows, () => false)).toEqual({ rootIds: [], expandIds: [] });
  });
  it('does not add an unrelated root across a worktree boundary', () => {
    const rows = [row('root'), row('match', 'root', { worktreeId: 'other' })];
    expect(reveal(rows, s => s.id === 'match')).toEqual({ rootIds: ['match'], expandIds: [] });
  });
  it('leaves a matching parent on its own expansion so its children stay behind its chevron', () => {
    const rows = [row('Launch'), row('draft', 'Launch'), row('notes', 'Launch')];
    expect(reveal(rows, s => s.id === 'Launch')).toEqual({ rootIds: ['Launch'], expandIds: [] });
  });
  it('stops at a blitz parent the way the sidebar root lookup does', () => {
    const rows = [row('blitz', null, { sessionType: 'blitz' }), row('match', 'blitz')];
    expect(reveal(rows, s => s.id === 'match')).toEqual({ rootIds: ['match'], expandIds: [] });
    expect(sessionTreeRootId('match', new Map(rows.map(r => [r.id, r])))).toBe('match');
  });
  it('does not let a hidden archived child admit its root, but walks archived ancestors', () => {
    const rows = [row('root', null, { title: 'Launch' } as any), row('old', 'root', { title: 'Beta notes', isArchived: true } as any)];
    expect(reveal(rows, titleSearchMatcher('beta', false) as any)).toEqual({ rootIds: [], expandIds: [] });
    expect(reveal(rows, titleSearchMatcher('beta', true) as any)).toEqual({ rootIds: ['root'], expandIds: ['root'] });
    const archivedParent = [row('p', null, { title: 'x', isArchived: true } as any), row('c', 'p', { title: 'Beta' } as any)];
    expect(reveal(archivedParent, titleSearchMatcher('beta', false) as any).rootIds).toEqual(['p']);
  });
  it('re-opens collapsed search ancestors when the query changes even if the ancestors do not', () => {
    expect(searchExpandKey('alpha', ['root'])).not.toBe(searchExpandKey('beta', ['root']));
    expect([...searchExpandEntries(searchExpandKey('Beta ', ['b', 'a']))]).toEqual([['a', true], ['b', true]]);
    expect(searchExpandEntries(searchExpandKey('beta', null)).size).toBe(0);
  });
  it('keeps Expand all during search from saving the expansion of ancestors search opened', () => {
    const { persistIds, overrides } = bulkTreeExpand(['root', 'other'], new Map([['root', false]]), true);
    expect(persistIds).toEqual(['other']);
    expect([...overrides]).toEqual([['root', true]]);
    expect(bulkTreeExpand(['root'], new Map(), false).persistIds).toEqual(['root']);
  });
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

describe('treeParentIds', () => {
  it('lists every node that has children, at any depth, and skips leaves', () => {
    const rows = [row('root'), row('middle', 'root'), row('leaf', 'middle'), row('sibling', 'root'), row('solo')];
    expect(treeParentIds(rows).sort()).toEqual(['middle', 'root']);
  });

  it('does not depend on what is expanded', () => {
    expect(treeParentIds([row('a'), row('b', 'a')])).toEqual(['a']);
    expect(treeParentIds([row('a')])).toEqual([]);
  });
});
