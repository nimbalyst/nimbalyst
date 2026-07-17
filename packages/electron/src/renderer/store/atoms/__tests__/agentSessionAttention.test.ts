import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@nimbalyst/runtime';
import {
  agentBubbleStateAtom,
  agentSessionAttentionAtom,
  sessionHasPendingInteractivePromptAtom,
  sessionListWorkspaceAtom,
  sessionProcessingAtom,
  sessionRegistryAtom,
  sessionUnreadAtom,
} from '../sessions';

const WORKSPACE = '/workspace/current';

function session(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: `Session ${id}`,
    provider: 'claude-code',
    model: 'claude-code:sonnet',
    sessionType: 'session',
    workspaceId: WORKSPACE,
    worktreeId: null,
    parentSessionId: null,
    childCount: 0,
    uncommittedCount: 0,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    isArchived: false,
    isPinned: false,
    ...overrides,
  };
}

function setup(...sessions: SessionMeta[]) {
  const store = createStore();
  store.set(sessionListWorkspaceAtom, WORKSPACE);
  store.set(sessionRegistryAtom, new Map(sessions.map((item) => [item.id, item])));
  return store;
}

describe('agentBubbleStateAtom', () => {
  it('is hidden when no session needs attention', () => {
    const store = setup(session('idle'));
    expect(store.get(agentBubbleStateAtom)).toEqual({ color: null, count: 0 });
  });

  it('uses awaiting-input priority and counts only awaiting sessions', () => {
    const store = setup(session('awaiting-1'), session('awaiting-2'), session('running'), session('unread'));
    store.set(sessionHasPendingInteractivePromptAtom('awaiting-1'), true);
    store.set(sessionHasPendingInteractivePromptAtom('awaiting-2'), true);
    store.set(sessionProcessingAtom('running'), true);
    store.set(sessionUnreadAtom('unread'), true);

    expect(store.get(agentBubbleStateAtom)).toEqual({ color: 'orange', count: 2 });
  });

  it('uses running priority when no session awaits input', () => {
    const store = setup(session('running-1'), session('running-2'), session('unread'));
    store.set(sessionProcessingAtom('running-1'), true);
    store.set(sessionProcessingAtom('running-2'), true);
    store.set(sessionUnreadAtom('unread'), true);

    expect(store.get(agentBubbleStateAtom)).toEqual({ color: 'green', count: 2 });
  });

  it('shows the unread count when no higher-priority state exists', () => {
    const store = setup(session('unread-1'), session('unread-2'));
    store.set(sessionUnreadAtom('unread-1'), true);
    store.set(sessionUnreadAtom('unread-2'), true);

    expect(store.get(agentBubbleStateAtom)).toEqual({ color: 'blue', count: 2 });
  });
});

describe('agentSessionAttentionAtom', () => {
  it('classifies each session once at its highest-priority state', () => {
    const store = setup(session('overlap'));
    store.set(sessionHasPendingInteractivePromptAtom('overlap'), true);
    store.set(sessionProcessingAtom('overlap'), true);
    store.set(sessionUnreadAtom('overlap'), true);

    const groups = store.get(agentSessionAttentionAtom);
    expect(groups.awaitingInput.map((item) => item.id)).toEqual(['overlap']);
    expect(groups.running).toEqual([]);
    expect(groups.unread).toEqual([]);
  });

  it('ignores completed, archived, and other-workspace sessions', () => {
    const store = setup(
      session('current'),
      session('completed', { phase: 'complete' }),
      session('archived', { isArchived: true }),
      session('other-workspace', { workspaceId: '/workspace/other' }),
    );
    store.set(sessionUnreadAtom('current'), true);
    store.set(sessionHasPendingInteractivePromptAtom('completed'), true);
    store.set(sessionUnreadAtom('archived'), true);
    store.set(sessionUnreadAtom('other-workspace'), true);

    expect(store.get(agentSessionAttentionAtom).unread.map((item) => item.id)).toEqual(['current']);
    expect(store.get(agentSessionAttentionAtom).awaitingInput).toEqual([]);
  });
});
