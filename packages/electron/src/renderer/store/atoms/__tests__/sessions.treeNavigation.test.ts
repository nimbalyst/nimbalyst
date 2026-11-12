// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../openProjects';
import {
  createChildSessionAtom,
  loadSessionChildrenAtom,
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
import { createNewSessionActionAtom, selectChildSessionActionAtom, selectSessionActionAtom } from '../../actions/sessionHistoryActions';
import { createWorkstreamAtom, selectedActiveSessionIdAtom, setActiveSessionInWorkstreamAtom } from '../sessions';
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
  it('lists only sessions of the current workspace, the same rule the send path enforces (GitHub #1887)', async () => {
    store.set(sessionRegistryAtom, new Map([...store.get(sessionRegistryAtom), ['foreign', row('foreign', null, { workspaceId: '/other' })]]));
    expect(store.get(sessionListRootAtom).map((r) => r.id)).not.toContain('foreign');
    // A child fetch for a project the window has since left must not land in this list.
    window.electronAPI.invoke = vi.fn(async () => ({ success: true, children: [row('late-child', 'other-root', { workspaceId: '/other' })] }));
    await store.set(loadSessionChildrenAtom, { parentSessionId: 'other-root', workspacePath: '/other' });
    expect(store.get(sessionRegistryAtom).has('late-child')).toBe(false);
  });
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
  it('opens a nested meta agent child under the nearest meta agent without recursing (#1906)', async () => {
    rows.push(
      row('meta-a', null, { childCount: 1, agentRole: 'meta-agent' }),
      row('meta-b', 'meta-a', { childCount: 1, agentRole: 'meta-agent' }),
      row('worker-c', 'meta-b', { childCount: 1 }),
      row('helper-d', 'worker-c'),
    );
    store.set(sessionRegistryAtom, new Map(rows.map((r) => [r.id, r])));
    await store.set(selectSessionActionAtom, 'worker-c');
    expect(store.get(selectedWorkstreamAtom('/project'))?.id).toBe('worker-c');
    expect(store.get(activeSessionIdAtom)).toBe('worker-c');
    await store.set(selectSessionActionAtom, 'helper-d');
    expect(store.get(selectedWorkstreamAtom('/project'))).toEqual({ type: 'workstream', id: 'worker-c' });
    expect(store.get(activeSessionIdAtom)).toBe('helper-d');
    await store.set(selectSessionActionAtom, 'meta-b');
    expect(store.get(selectedWorkstreamAtom('/project'))?.id).toBe('meta-b');
    await store.set(selectChildSessionActionAtom, { childSessionId: 'helper-d', parentId: 'meta-a', parentType: 'workstream' });
    expect(store.get(selectedWorkstreamAtom('/project'))).toEqual({ type: 'workstream', id: 'worker-c' });
    expect(store.get(activeSessionIdAtom)).toBe('helper-d');
  });
  it('opens a meta agent child as its own session instead of the meta agent view (#1906)', async () => {
    rows.push(
      row('meta', null, { childCount: 1, agentRole: 'meta-agent' }),
      row('worker', 'meta', { childCount: 1 }),
      row('helper', 'worker'),
    );
    store.set(sessionRegistryAtom, new Map(rows.map((r) => [r.id, r])));
    await store.set(selectSessionActionAtom, 'worker');
    expect(store.get(selectedWorkstreamAtom('/project'))?.id).toBe('worker');
    expect(store.get(activeSessionIdAtom)).toBe('worker');
    await store.set(selectSessionActionAtom, 'helper');
    expect(store.get(selectedWorkstreamAtom('/project'))).toEqual({ type: 'workstream', id: 'worker' });
    expect(store.get(activeSessionIdAtom)).toBe('helper');
    await store.set(selectSessionActionAtom, 'meta');
    expect(store.get(selectedWorkstreamAtom('/project'))?.id).toBe('meta');
    // Sidebar child rows pass the meta agent as the parent.
    await store.set(selectChildSessionActionAtom, { childSessionId: 'helper', parentId: 'meta', parentType: 'workstream' });
    expect(store.get(selectedWorkstreamAtom('/project'))).toEqual({ type: 'workstream', id: 'worker' });
    expect(store.get(activeSessionIdAtom)).toBe('helper');
  });

  it('selects an empty workstream as a container and puts new sessions inside it as peers', async () => {
    const made = row('made', null, { sessionType: 'workstream', userWorkstream: true });
    const legacy = row('legacy', null, { sessionType: 'workstream' });
    const only = row('only', 'legacy');
    store.set(sessionRegistryAtom, new Map([made, legacy, only].map((r) => [r.id, r])));
    const invoke = vi.mocked(window.electronAPI.invoke);
    invoke.mockImplementation(async (channel: string, payload?: any) =>
      channel === 'sessions:create' ? { success: true, id: payload.session.id }
        : channel === 'sessions:list-children' ? { success: true, children: [] } : { success: true });

    await store.set(selectSessionActionAtom, 'made');
    expect(store.get(selectedWorkstreamAtom('/project'))).toEqual({ type: 'workstream', id: 'made' });

    const created = await store.set(createNewSessionActionAtom, { intoSelectedWorkstream: true });
    const session = invoke.mock.calls.find(([channel]) => channel === 'sessions:create')![1].session;
    expect(session).toMatchObject({ id: created, parentSessionId: 'made' });
    expect(session.createdBySessionId).toBeUndefined();
    expect(store.get(sessionRegistryAtom).get(created!)?.parentSessionId).toBe('made');
    expect(store.get(selectedWorkstreamAtom('/project'))).toEqual({ type: 'workstream', id: 'made' });

    // A legacy wrapper merged into its only session is invisible; it must not swallow new sessions.
    invoke.mockClear();
    await store.set(selectSessionActionAtom, 'only');
    await store.set(createNewSessionActionAtom, { intoSelectedWorkstream: true });
    expect(invoke.mock.calls.find(([channel]) => channel === 'sessions:create')![1].session.parentSessionId).toBeUndefined();
    // Launches that do not opt in (trackers, PRs, canvases) stay at top level.
    invoke.mockClear();
    await store.set(selectSessionActionAtom, 'made');
    await store.set(createNewSessionActionAtom, { launchSource: 'tray' });
    expect(invoke.mock.calls.find(([channel]) => channel === 'sessions:create')![1].session.parentSessionId).toBeUndefined();
  });

  it('creates a marked workstream row and moves the given sessions into it without a manager', async () => {
    const a = row('a', null, { createdBySessionId: null });
    store.set(sessionRegistryAtom, new Map([[a.id, a]]));
    const invoke = vi.mocked(window.electronAPI.invoke);
    invoke.mockImplementation(async (channel: string, payload?: any) =>
      channel === 'sessions:create' ? { success: true, id: payload.session.id }
        : channel === 'sessions:set-parent' ? { success: true, previousParentId: null, previousManagerId: null }
        : { success: true });
    const result = await store.set(createWorkstreamAtom, { workspacePath: '/project', title: 'Release', sessionIds: ['a'] });
    expect(result).toMatchObject({ failed: 0 });
    expect(invoke).toHaveBeenCalledWith('sessions:create', expect.objectContaining({
      session: expect.objectContaining({ id: result!.id, title: 'Release', sessionType: 'workstream', metadata: expect.objectContaining({ userWorkstream: true }) }),
      workspaceId: '/project',
    }));
    const move = invoke.mock.calls.find(([channel]) => channel === 'sessions:set-parent')![1];
    expect(move).toEqual({ sessionId: 'a', newParentId: result!.id, workspacePath: '/project' });
  });

  it('never makes a workstream container the active transcript, even when its sessions are archived', async () => {
    const ws = row('ws', null, { sessionType: 'workstream', userWorkstream: true });
    const archived = row('gone', 'ws', { isArchived: true });
    const plain = row('plain');
    store.set(sessionRegistryAtom, new Map([ws, archived, plain].map((r) => [r.id, r])));
    store.set(activeSessionIdAtom, 'plain');
    vi.mocked(window.electronAPI.invoke).mockImplementation(async (channel: string) =>
      channel === 'sessions:list-children' ? { success: true, children: [] } : { success: true });
    await store.set(loadSessionChildrenAtom, { parentSessionId: 'ws', workspacePath: '/project' });
    expect(store.get(workstreamStateAtom('ws')).activeChildId).toBeNull();
    expect(store.get(workstreamSessionsAtom('ws'))).toEqual([]);
    store.set(setActiveSessionInWorkstreamAtom, { workstreamId: 'ws', sessionId: 'ws' });
    expect(store.get(activeSessionIdAtom)).toBe('plain');
    // What Agent mode publishes as the active session for a selection.
    expect(store.get(selectedActiveSessionIdAtom('ws'))).toBeNull();
    expect(store.get(selectedActiveSessionIdAtom('plain'))).toBe('plain');
  });
});
