import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@nimbalyst/runtime';
import {
  groupIndicatorStateAtom,
  sessionChildrenAtom,
  sessionHasPendingInteractivePromptAtom,
  sessionIndicatorStateAtom,
  sessionProcessingAtom,
  sessionRegistryAtom,
  sessionRunningChildCountAtom,
  sessionStoreAtom,
  sessionWakeupAtom,
} from '../sessions';
import { childRunStatesAtom } from '../sessionKanban';

function meta(id: string, parentSessionId: string | null = null): SessionMeta {
  return {
    id,
    title: id,
    provider: 'claude-code',
    sessionType: 'session',
    workspaceId: '/workspace',
    worktreeId: null,
    parentSessionId,
    childCount: 0,
    uncommittedCount: 0,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    isArchived: false,
    isPinned: false,
  };
}

describe('session indicator atoms', () => {
  it('deduplicates child sources and counts only running teammate/task entries', () => {
    const store = createStore();
    const parentId = 'parent';
    const childId = 'child';
    store.set(sessionRegistryAtom, new Map([
      [parentId, meta(parentId)],
      [childId, meta(childId, parentId)],
    ]));
    store.set(sessionChildrenAtom(parentId), [childId]);
    store.set(sessionProcessingAtom(childId), true);
    store.set(sessionStoreAtom(parentId), {
      metadata: {
        currentTeammates: [{ status: 'running' }, { status: 'idle' }],
        currentTasks: [{ status: 'running' }, { status: 'completed' }],
      },
    } as any);

    expect(store.get(sessionRunningChildCountAtom(parentId))).toBe(3);
    expect(store.get(sessionIndicatorStateAtom(parentId))).toEqual({
      kind: 'working-child',
      childCount: 3,
    });
  });

  it('gives parent lead work precedence over combined background work', () => {
    const store = createStore();
    const parentId = 'parent-lead';
    store.set(sessionProcessingAtom(parentId), true);
    store.set(sessionStoreAtom(parentId), {
      metadata: { currentTasks: [{ status: 'running' }] },
    } as any);

    expect(store.get(sessionIndicatorStateAtom(parentId))).toEqual({
      kind: 'working-self',
      hasBackground: true,
      backgroundCount: 1,
    });
  });

  it('treats a collection child lead as steady group background', () => {
    const store = createStore();
    const childId = 'collection-child';
    store.set(sessionProcessingAtom(childId), true);
    const key = JSON.stringify({ parentId: null, childIds: [childId] });
    expect(store.get(groupIndicatorStateAtom(key))).toEqual({
      kind: 'working-child',
      childCount: 1,
    });
  });

  it('deduplicates repeated group child IDs', () => {
    const store = createStore();
    const childId = 'duplicate-collection-child';
    store.set(sessionProcessingAtom(childId), true);
    const key = JSON.stringify({ parentId: null, childIds: [childId, childId] });
    expect(store.get(groupIndicatorStateAtom(key))).toEqual({
      kind: 'working-child',
      childCount: 1,
    });
  });

  it('uses canonical precedence for the Kanban child summary', () => {
    const store = createStore();
    const parentId = 'kanban-parent';
    const childId = 'kanban-child';
    store.set(sessionRegistryAtom, new Map([
      [parentId, meta(parentId)],
      [childId, meta(childId, parentId)],
    ]));
    store.set(sessionProcessingAtom(childId), true);
    store.set(sessionHasPendingInteractivePromptAtom(childId), true);

    expect(store.get(childRunStatesAtom(parentId))).toMatchObject({
      running: 0,
      waiting: 1,
      total: 1,
    });
  });

  it.each(['overdue', 'waiting_for_workspace'] as const)(
    'maps %s wakeups to actionable attention',
    (status) => {
      const store = createStore();
      const sessionId = `wakeup-${status}`;
      store.set(sessionWakeupAtom(sessionId), {
        id: status,
        sessionId,
        workspaceId: '/workspace',
        prompt: 'resume',
        reason: 'Continue work',
        fireAt: 1234,
        status,
        createdAt: 1,
        firedAt: null,
        error: null,
      });
      expect(store.get(sessionIndicatorStateAtom(sessionId))).toEqual({
        kind: 'wakeup-attention',
        reason: 'Continue work',
        fireAt: 1234,
        status,
      });
    },
  );

  it('maps a firing wakeup to active lead work during provider handoff', () => {
    const store = createStore();
    const sessionId = 'wakeup-firing';
    store.set(sessionWakeupAtom(sessionId), {
      id: 'firing', sessionId, workspaceId: '/workspace', prompt: 'resume',
      reason: 'Continue work', fireAt: 1234, status: 'firing', createdAt: 1,
      firedAt: null, error: null,
    });
    expect(store.get(sessionIndicatorStateAtom(sessionId))).toEqual({
      kind: 'working-self',
      hasBackground: false,
      backgroundCount: 0,
    });
  });

  it('maps a failed wakeup to a safe error category', () => {
    const store = createStore();
    const sessionId = 'wakeup-failed';
    store.set(sessionWakeupAtom(sessionId), {
      id: 'failed', sessionId, workspaceId: '/workspace', prompt: 'resume',
      reason: 'Continue work', fireAt: 1234, status: 'failed', createdAt: 1,
      firedAt: null, error: 'private failure detail',
    });
    expect(store.get(sessionIndicatorStateAtom(sessionId))).toEqual({
      kind: 'error',
      message: 'Wakeup failed',
    });
  });

  it('maps a pending wakeup to a passive scheduled state', () => {
    const store = createStore();
    const sessionId = 'wakeup-pending';
    store.set(sessionWakeupAtom(sessionId), {
      id: 'pending', sessionId, workspaceId: '/workspace', prompt: 'resume',
      reason: 'Continue work', fireAt: 1234, status: 'pending', createdAt: 1,
      firedAt: null, error: null,
    });
    expect(store.get(sessionIndicatorStateAtom(sessionId))).toEqual({
      kind: 'scheduled',
      reason: 'Continue work',
      fireAt: 1234,
    });
  });
});
