import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import type { SessionMeta } from '@nimbalyst/runtime';
import {
  loadSessionChildrenAtom,
  reparentSessionAtom,
  sessionChildrenAtom,
  sessionRegistryAtom,
  workstreamSessionsAtom,
} from '../sessions';
import {
  initWorkstreamState,
  setWorkstreamActiveChildAtom,
  workstreamStateAtom,
} from '../workstreamState';

function session(overrides: Partial<SessionMeta> & Pick<SessionMeta, 'id'>): SessionMeta {
  const { id, ...rest } = overrides;
  return {
    id,
    title: id,
    provider: 'test',
    sessionType: 'session',
    workspaceId: '/workspace',
    worktreeId: null,
    parentSessionId: null,
    childCount: 0,
    uncommittedCount: 0,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    isArchived: false,
    isPinned: false,
    ...rest,
  };
}

describe('workstream active-child identity', () => {
  const workspacePath = '/workspace';
  const parentId = 'workstream';
  let jotaiStore: ReturnType<typeof createStore>;
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    jotaiStore = createStore();
    initWorkstreamState(workspacePath);
    invoke = vi.fn(async (channel: string) => {
      if (channel === 'sessions:set-parent') return { success: true };
      throw new Error(`Unexpected IPC channel: ${channel}`);
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { invoke },
    });
  });

  it('keeps a non-removed active child selected', async () => {
    jotaiStore.set(sessionChildrenAtom(parentId), ['active', 'removed']);
    jotaiStore.set(workstreamStateAtom(parentId), {
      type: 'workstream',
      childSessionIds: ['active', 'removed'],
      activeChildId: 'active',
    });

    await jotaiStore.set(reparentSessionAtom, {
      sessionId: 'removed',
      oldParentId: parentId,
      newParentId: null,
      workspacePath,
    });

    expect(jotaiStore.get(workstreamStateAtom(parentId)).activeChildId).toBe('active');
  });

  it('selects the first remaining child when the active child is removed', async () => {
    jotaiStore.set(sessionChildrenAtom(parentId), ['removed', 'remaining']);
    jotaiStore.set(workstreamStateAtom(parentId), {
      type: 'workstream',
      childSessionIds: ['removed', 'remaining'],
      activeChildId: 'removed',
    });

    await jotaiStore.set(reparentSessionAtom, {
      sessionId: 'removed',
      oldParentId: parentId,
      newParentId: null,
      workspacePath,
    });

    expect(jotaiStore.get(workstreamStateAtom(parentId)).activeChildId).toBe('remaining');
  });

  it('reconciles idempotently as both children leave a typed workstream', async () => {
    jotaiStore.set(sessionChildrenAtom(parentId), ['first', 'last']);
    jotaiStore.set(workstreamStateAtom(parentId), {
      type: 'workstream',
      childSessionIds: ['first', 'last'],
      activeChildId: 'first',
    });

    await jotaiStore.set(reparentSessionAtom, {
      sessionId: 'first',
      oldParentId: parentId,
      newParentId: null,
      workspacePath,
    });

    expect(jotaiStore.get(workstreamStateAtom(parentId)).activeChildId).toBe('last');

    await jotaiStore.set(reparentSessionAtom, {
      sessionId: 'last',
      oldParentId: parentId,
      newParentId: null,
      workspacePath,
    });

    const state = jotaiStore.get(workstreamStateAtom(parentId));
    expect(state.activeChildId).toBeNull();
    expect(state.type).toBe('workstream');
  });

  it('loads an empty typed workstream without routing to the container itself', async () => {
    jotaiStore.set(
      sessionRegistryAtom,
      new Map([[parentId, session({ id: parentId, sessionType: 'workstream' })]]),
    );
    invoke.mockResolvedValueOnce({ success: true, children: [] });

    await jotaiStore.set(loadSessionChildrenAtom, { parentSessionId: parentId, workspacePath });

    const state = jotaiStore.get(workstreamStateAtom(parentId));
    expect(state.childSessionIds).toEqual([]);
    expect(state.activeChildId).toBeNull();
    expect(state.type).toBe('workstream');
    expect(jotaiStore.get(workstreamSessionsAtom(parentId))).toEqual([]);
  });

  it('allows an explicit null active child for an empty container', () => {
    jotaiStore.set(workstreamStateAtom(parentId), {
      type: 'workstream',
      activeChildId: 'stale',
    });

    jotaiStore.set(setWorkstreamActiveChildAtom, {
      workstreamId: parentId,
      childId: null,
    });

    expect(jotaiStore.get(workstreamStateAtom(parentId)).activeChildId).toBeNull();
  });
});
