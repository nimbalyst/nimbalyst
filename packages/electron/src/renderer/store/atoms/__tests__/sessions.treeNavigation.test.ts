// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../openProjects';
import {
  createChildSessionAtom,
  reparentSessionAtom,
  activeSessionIdAtom,
  sessionRegistryAtom,
  sessionChildrenAtom,
  sessionListRootAtom,
  sessionListWorkspaceAtom,
  sessionOrChildProcessingAtom,
  sessionProcessingAtom,
  workstreamSessionsAtom,
  selectedWorkstreamAtom,
  type SessionMeta,
} from '../sessions';
import { initWorkstreamState, workstreamStateAtom } from '../workstreamState';
import { selectSessionActionAtom } from '../../actions/sessionHistoryActions';
const row = (
  id: string,
  parentSessionId: string | null = null,
  extra: Partial<SessionMeta> = {}
): SessionMeta => ({
  id,
  title: id,
  provider: 'claude-code',
  worktreeId: null,
  uncommittedCount: 0,
  createdAt: 1,
  updatedAt: 1,
  workspaceId: '/project',
  sessionType: 'session',
  messageCount: 0,
  childCount: 0,
  isArchived: false,
  isPinned: false,
  parentSessionId,
  ...extra,
});
let rows: SessionMeta[];
beforeEach(() => {
  initWorkstreamState('/project');
  rows = [
    row('root', null, { childCount: 1, worktreeId: 'tree' }),
    row('middle', 'root', { childCount: 1, worktreeId: 'tree' }),
    row('leaf', 'middle', { worktreeId: 'tree', agentRole: 'meta-agent' }),
    row('blitz', null, { sessionType: 'blitz' }),
    row('blitz-child', 'blitz', { worktreeId: 'blitz-tree' }),
  ];
  store.set(sessionRegistryAtom, new Map(rows.map((r) => [r.id, r])));
  store.set(activeWorkspacePathAtom, '/project');
  store.set(sessionListWorkspaceAtom, '/project');
  window.electronAPI = {
    invoke: vi.fn(async (channel: string) =>
      channel === 'sessions:list-children' ? { success: true, children: rows.slice(1, 3) } : { success: true }
    ),
    aiUpdateSessionMetadata: vi.fn().mockResolvedValue({ success: true }),
  } as any;
});
describe('tree navigation atoms', () => {
  it.each(['target', null])('keeps an active grandchild selected at its new tree root after moving its parent to %s', async (newParentId) => {
    rows.push(row('target', null, {worktreeId: 'tree'}));
    store.set(sessionRegistryAtom, new Map(rows.map(r => [r.id, r])));
    await store.set(selectSessionActionAtom, 'leaf');
    store.set(workstreamStateAtom('target'), {activeChildId: 'target'});
    window.electronAPI.invoke = vi.fn(async (channel, payload) => {
      if (channel === 'sessions:set-parent') {
        rows = rows.map(r => r.id === payload.sessionId ? {...r, parentSessionId: payload.newParentId} : r);
        return {success: true, previousParentId: 'root'};
      }
      if (channel === 'sessions:list') return {success: true, sessions: rows};
      return {success: true};
    });
    expect(await store.set(reparentSessionAtom, {
      sessionId: 'middle', oldParentId: 'root', newParentId, workspacePath: '/project',
    })).toBe(true);
    const rootId = newParentId ?? 'middle';
    expect(store.get(selectedWorkstreamAtom('/project'))).toEqual({type: 'workstream', id: rootId});
    expect(store.get(activeSessionIdAtom)).toBe('leaf');
    expect(store.get(workstreamStateAtom(rootId)).activeChildId).toBe('leaf');
    expect(store.get(workstreamStateAtom('root')).activeChildId).toBe('root');
    expect(store.get(workstreamSessionsAtom('root'))).toEqual(['root']);
    expect(store.get(workstreamSessionsAtom(rootId))).toContain('leaf');
  });
  it('repairs an inactive old root without changing the current transcript or the destination remembered tab', async () => {
    rows.push(row('target', null, {worktreeId: 'tree'}), row('unrelated'));
    store.set(sessionRegistryAtom, new Map(rows.map(r => [r.id, r])));
    store.set(workstreamStateAtom('root'), {activeChildId: 'leaf'});
    store.set(workstreamStateAtom('target'), {activeChildId: 'target'});
    await store.set(selectSessionActionAtom, 'unrelated');
    window.electronAPI.invoke = vi.fn(async (channel, payload) => {
      if (channel === 'sessions:set-parent') {
        rows = rows.map(r => r.id === payload.sessionId ? {...r, parentSessionId: payload.newParentId} : r);
      }
      return channel === 'sessions:list' ? {success: true, sessions: rows} : {success: true};
    });
    await store.set(reparentSessionAtom, {sessionId: 'middle', oldParentId: 'root', newParentId: 'target', workspacePath: '/project'});
    expect(store.get(selectedWorkstreamAtom('/project'))).toEqual({type: 'session', id: 'unrelated'});
    expect(store.get(activeSessionIdAtom)).toBe('unrelated');
    expect(store.get(workstreamStateAtom('root')).activeChildId).toBe('root');
    expect(store.get(workstreamStateAtom('target')).activeChildId).toBe('target');
  });

  it('preserves navigation made while the move request is pending and leaves selection unchanged on rejection', async () => {
    rows.push(row('target', null, {worktreeId: 'tree'}), row('unrelated'));
    store.set(sessionRegistryAtom, new Map(rows.map(r => [r.id, r])));
    await store.set(selectSessionActionAtom, 'leaf');
    let acknowledge!: (result: {success: boolean; error?: string}) => void;
    window.electronAPI.invoke = vi.fn(async (channel, payload) => {
      if (channel === 'sessions:set-parent') {
        const result = await new Promise<{success: boolean; error?: string}>(resolve => { acknowledge = resolve; });
        if (result.success) rows = rows.map(r => r.id === payload.sessionId ? {...r, parentSessionId: payload.newParentId} : r);
        return result;
      }
      return channel === 'sessions:list' ? {success: true, sessions: rows} : {success: true};
    });
    const payload = {sessionId: 'middle', oldParentId: 'root', newParentId: 'target', workspacePath: '/project'};
    const rejected = store.set(reparentSessionAtom, payload);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    acknowledge({success: false, error: 'Move rejected'});
    expect(await rejected).toBe(false);
    log.mockRestore();
    expect(store.get(selectedWorkstreamAtom('/project'))?.id).toBe('root');
    expect(store.get(workstreamStateAtom('root')).activeChildId).toBe('leaf');
    expect(store.get(sessionRegistryAtom).get('middle')?.parentSessionId).toBe('root');

    const pending = store.set(reparentSessionAtom, payload);
    await store.set(selectSessionActionAtom, 'unrelated');
    acknowledge({success: true});
    expect(await pending).toBe(true);
    expect(store.get(selectedWorkstreamAtom('/project'))).toEqual({type: 'session', id: 'unrelated'});
    expect(store.get(activeSessionIdAtom)).toBe('unrelated');
    expect(store.get(workstreamStateAtom('root')).activeChildId).toBe('root');
  });
  it('opens a grandchild under its actual root with the root transcript included, keeping direct parent edges', async () => {
    await store.set(selectSessionActionAtom, 'leaf');
    expect(store.get(selectedWorkstreamAtom('/project'))).toEqual({ type: 'workstream', id: 'root' });
    expect(store.get(workstreamStateAtom('root')).activeChildId).toBe('leaf');
    expect(store.get(sessionRegistryAtom).get('leaf')?.parentSessionId).toBe('middle');
    expect(store.get(workstreamSessionsAtom('root'))).toEqual(['root', 'middle', 'leaf']);
    expect(store.get(sessionListRootAtom).map((r) => r.id)).toEqual(['root', 'blitz', 'blitz-child']);
  });
  it('aggregates deep processing and omits only wrapper transcripts from tree tabs', () => {
    store.set(sessionProcessingAtom('leaf'), true);
    expect(store.get(sessionOrChildProcessingAtom('root'))).toBe(true);
    store.set(sessionProcessingAtom('leaf'), false);
    expect(store.get(sessionOrChildProcessingAtom('root'))).toBe(false);
    store.set(
      sessionRegistryAtom,
      new Map(rows.map((r) => [r.id, r.id === 'root' ? { ...r, sessionType: 'workstream' as const } : r]))
    );
    store.set(sessionChildrenAtom('root'), []);
    expect(store.get(workstreamSessionsAtom('root'))).toEqual(['middle', 'leaf']);
  });
  it('creates a child under the requested nested session and opens it at the tree root', async () => {
    const invoke = vi.fn(async (channel: string, payload: any) => {
      if (channel === 'sessions:create-child') {
        rows.push(row('new-child', payload.parentSessionId, { worktreeId: 'tree' }));
        return { success: true, sessionId: 'new-child' };
      }
      if (channel === 'sessions:list') return { success: true, sessions: rows };
      if (channel === 'sessions:list-children')
        return {
          success: true,
          children: rows.filter((r) => ['middle', 'leaf', 'new-child'].includes(r.id)),
        };
      return { success: true };
    });
    window.electronAPI.invoke = invoke;
    expect(
      await store.set(createChildSessionAtom, {
        parentSessionId: 'middle',
        workspacePath: '/project',
        model: 'claude-code:sonnet',
      })
    ).toBe('new-child');
    expect(invoke).toHaveBeenCalledWith(
      'sessions:create-child',
      expect.objectContaining({ parentSessionId: 'middle', worktreeId: 'tree' })
    );
    expect(store.get(selectedWorkstreamAtom('/project'))).toEqual({ type: 'workstream', id: 'root' });
    expect(store.get(workstreamStateAtom('root')).activeChildId).toBe('new-child');
    expect(store.get(sessionRegistryAtom).get('middle')?.sessionType).toBe('session');
  });
  it('keeps Blitz worktree children as independently selected worktree sessions', async () => {
    await store.set(selectSessionActionAtom, 'blitz-child');
    expect(store.get(selectedWorkstreamAtom('/project'))).toEqual({type: 'worktree', id: 'blitz-child'});
    expect(store.get(workstreamStateAtom('blitz-child')).worktreeId).toBe('blitz-tree');
  });

});
