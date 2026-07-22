import { createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activeSessionIdAtom,
  applySessionReparentedAtom,
  sessionChildrenAtom,
  sessionParentIdAtom,
  sessionParentIdDerivedAtom,
  sessionRegistryAtom,
  sessionListWorkspaceAtom,
  sessionStoreAtom,
} from '../atoms/sessions';
import { initWorkstreamState, workstreamStateAtom } from '../atoms/workstreamState';

function meta(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    provider: 'claude-code',
    sessionType: id.startsWith('workstream') ? 'workstream' : 'session',
    workspaceId: '/repo',
    worktreeId: null,
    parentSessionId: null,
    childCount: 0,
    uncommittedCount: 0,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 0,
    isArchived: false,
    isPinned: false,
    ...overrides,
  } as any;
}

describe('renderer session visibility convergence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    initWorkstreamState('/repo');
  });

  it('atomically moves a child across registries without stealing active selection', () => {
    const state = createStore();
    state.set(activeSessionIdAtom, 'other-session');
    state.set(sessionRegistryAtom, new Map([
      ['target', meta('target', { parentSessionId: 'workstream-a' })],
      ['workstream-a', meta('workstream-a', { childCount: 1 })],
      ['workstream-b', meta('workstream-b', { childCount: 0 })],
    ]));
    state.set(sessionParentIdAtom('target'), 'workstream-a');
    state.set(sessionStoreAtom('target'), meta('target', { parentSessionId: 'workstream-a' }));
    state.set(sessionChildrenAtom('workstream-a'), ['target']);
    state.set(sessionChildrenAtom('workstream-b'), []);
    state.set(workstreamStateAtom('workstream-a'), {
      type: 'workstream',
      childSessionIds: ['target'],
      activeChildId: 'target',
    });
    state.set(workstreamStateAtom('workstream-b'), {
      type: 'workstream',
      childSessionIds: [],
      activeChildId: null,
    });

    state.set(applySessionReparentedAtom, {
      sessionId: 'target',
      oldParentSessionId: 'workstream-a',
      newParentSessionId: 'workstream-b',
    });

    expect(state.get(sessionParentIdAtom('target'))).toBe('workstream-b');
    expect(state.get(sessionParentIdDerivedAtom('target'))).toBe('workstream-b');
    expect(state.get(sessionChildrenAtom('workstream-a'))).toEqual([]);
    expect(state.get(sessionChildrenAtom('workstream-b'))).toEqual(['target']);
    expect(state.get(workstreamStateAtom('workstream-a')).childSessionIds).toEqual([]);
    expect(state.get(workstreamStateAtom('workstream-b')).childSessionIds).toEqual(['target']);
    expect(state.get(sessionRegistryAtom).get('target')?.parentSessionId).toBe('workstream-b');
    expect(state.get(sessionRegistryAtom).get('workstream-a')?.childCount).toBe(0);
    expect(state.get(sessionRegistryAtom).get('workstream-b')?.childCount).toBe(1);
    expect(state.get(activeSessionIdAtom)).toBe('other-session');
    expect(state.get(workstreamStateAtom('workstream-a')).activeChildId).toBeNull();
  });

  it('deduplicates a replayed reparent event', () => {
    const state = createStore();
    state.set(sessionRegistryAtom, new Map([
      ['target', meta('target', { parentSessionId: 'workstream-b' })],
      ['workstream-b', meta('workstream-b', { childCount: 1 })],
    ]));
    state.set(sessionChildrenAtom('workstream-b'), ['target']);
    state.set(workstreamStateAtom('workstream-b'), {
      type: 'workstream',
      childSessionIds: ['target'],
    });

    state.set(applySessionReparentedAtom, {
      sessionId: 'target',
      oldParentSessionId: 'workstream-b',
      newParentSessionId: 'workstream-b',
    });

    expect(state.get(sessionChildrenAtom('workstream-b'))).toEqual(['target']);
    expect(state.get(workstreamStateAtom('workstream-b')).childSessionIds).toEqual(['target']);
    expect(state.get(sessionRegistryAtom).get('workstream-b')?.childCount).toBe(1);
  });

  it('acknowledges only after the matching workspace applied the authoritative event', async () => {
    const state = createStore();
    state.set(sessionListWorkspaceAtom, '/workspace-a');
    state.set(sessionRegistryAtom, new Map());
    const listeners = new Map<string, (...args: any[]) => void>();
    const invoke = vi.fn(async (_channel: string, payload: { auditId: string }) => {
      if (payload.auditId === 'audit-a') {
        expect(state.get(sessionRegistryAtom).get('target')?.isPinned).toBe(true);
      }
      if (payload.auditId === 'audit-workstream-replay') {
        expect(state.get(sessionParentIdAtom('target'))).toBe('workstream-p2');
        expect(state.get(sessionChildrenAtom('workstream-p1'))).not.toContain('target');
        expect(state.get(sessionChildrenAtom('workstream-p2'))).toEqual(['target']);
        expect(state.get(workstreamStateAtom('workstream-p1')).childSessionIds).not.toContain('target');
        expect(state.get(workstreamStateAtom('workstream-p2')).childSessionIds).toEqual(['target']);
      }
      return true;
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        on: vi.fn((channel: string, callback: (...args: any[]) => void) => {
          listeners.set(channel, callback);
          return () => listeners.delete(channel);
        }),
        invoke,
      },
    });
    vi.doMock('../index', () => ({ store: state }));
    const { initSessionListListeners } = await import('../listeners/sessionListListeners');
    const cleanup = initSessionListListeners();

    // Matching workspace alone is insufficient: the target is not loaded, so
    // the authoritative update is a no-op and its marker must not be ACKed.
    listeners.get('sessions:session-updated')?.('target', {
      workspacePath: '/workspace-a',
      isPinned: true,
      visibilityAuditId: 'audit-a',
    });
    listeners.get('sessions:visibility-delivery')?.({
      auditId: 'audit-a', workspaceId: 'workspace-hash-a', workspacePath: '/workspace-a',
      targetSessionId: 'target',
    });
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();

    // Once the target loads, replay applies the state and the marker can prove
    // this exact audit/target pair was consumed.
    state.set(sessionRegistryAtom, new Map([
      ['target', meta('target', { workspaceId: '/workspace-a', isPinned: false })],
    ]));
    listeners.get('sessions:session-updated')?.('target', {
      workspacePath: '/workspace-a',
      isPinned: true,
      visibilityAuditId: 'audit-a',
    });
    listeners.get('sessions:visibility-delivery')?.({
      auditId: 'audit-a', workspaceId: 'workspace-hash-a', workspacePath: '/workspace-a',
      targetSessionId: 'target',
    });
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('sessions:visibility-delivery-ack', {
      auditId: 'audit-a', workspacePath: '/workspace-a',
    });

    // A crash after renderer effect but before main's durable ack replays the
    // same event plus stable auditId. Re-applying is idempotent and ACKs again.
    listeners.get('sessions:session-updated')?.('target', {
      workspacePath: '/workspace-a',
      isPinned: true,
      visibilityAuditId: 'audit-a',
    });
    listeners.get('sessions:visibility-delivery')?.({
      auditId: 'audit-a', workspaceId: 'workspace-hash-a', workspacePath: '/workspace-a',
      targetSessionId: 'target',
    });
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(2);

    state.set(sessionListWorkspaceAtom, '/workspace-b');
    listeners.get('sessions:visibility-delivery')?.({
      auditId: 'audit-a', workspaceId: 'workspace-hash-a', workspacePath: '/workspace-a',
      targetSessionId: 'target',
    });
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(2);

    state.set(sessionListWorkspaceAtom, '/workspace-a');
    listeners.get('sessions:visibility-delivery')?.({
      auditId: 'audit-a', workspaceId: 'workspace-hash-a', workspacePath: '/workspace-a',
      targetSessionId: 'target',
    });
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(2);

    listeners.get('sessions:session-updated')?.('target', {
      workspacePath: '/workspace-a',
      isPinned: true,
      visibilityAuditId: 'audit-a',
    });
    listeners.get('sessions:visibility-delivery')?.({
      auditId: 'audit-a', workspaceId: 'workspace-hash-a', workspacePath: '/workspace-a',
      targetSessionId: 'target',
    });
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(3);

    // An old P0->P1 obligation can replay after storage has advanced to P2
    // while this renderer still observes P1. P1 has been evicted from the
    // registry, and its two hierarchy caches disagree. Reconciliation must
    // preserve the union of unrelated children while removing only target.
    state.set(sessionRegistryAtom, new Map([
      ['target', meta('target', { workspaceId: '/workspace-a', parentSessionId: 'workstream-p1' })],
      ['workstream-p0', meta('workstream-p0')],
      ['workstream-p1', meta('workstream-p1')],
      ['workstream-p2', meta('workstream-p2', { childCount: 0 })],
    ]));
    // Populate the retained-parent index through the real centralized child
    // listener, then evict P1 from the registry while its atom-family caches live.
    listeners.get('sessions:child-added')?.({
      workspacePath: '/workspace-a',
      parentSessionId: 'workstream-p1',
      childSessionId: 'registered-unrelated-child',
    });
    const registryWithoutP1 = new Map(state.get(sessionRegistryAtom));
    registryWithoutP1.delete('workstream-p1');
    state.set(sessionRegistryAtom, registryWithoutP1);
    state.set(sessionParentIdAtom('target'), 'workstream-p1');
    state.set(sessionStoreAtom('target'), meta('target', { parentSessionId: 'workstream-p1' }));
    state.set(sessionChildrenAtom('workstream-p0'), []);
    state.set(sessionChildrenAtom('workstream-p1'), [
      'target', 'registered-unrelated-child', 'atom-only-child',
    ]);
    state.set(sessionChildrenAtom('workstream-p2'), ['new-parent-atom-child']);
    state.set(workstreamStateAtom('workstream-p0'), { type: 'workstream', childSessionIds: [] });
    state.set(workstreamStateAtom('workstream-p1'), {
      type: 'workstream', childSessionIds: ['target', 'state-only-child'], activeChildId: 'target',
    });
    state.set(workstreamStateAtom('workstream-p2'), {
      type: 'workstream', childSessionIds: ['new-parent-state-child'],
    });

    // Switching away snapshots every indexed family cache and clears the live
    // namespace. Workspace B then reuses the same target/parent IDs with
    // unrelated hierarchy. Returning to A must restore A's evicted P1 cache,
    // not B's, so the old obligation can discover and repair it.
    state.set(sessionListWorkspaceAtom, '/workspace-b');
    state.set(sessionRegistryAtom, new Map([
      ['target', meta('target', { workspaceId: '/workspace-b', parentSessionId: 'workstream-p1' })],
      ['workstream-p1', meta('workstream-p1', { workspaceId: '/workspace-b' })],
    ]));
    listeners.get('sessions:child-added')?.({
      workspacePath: '/workspace-b',
      parentSessionId: 'workstream-p1',
      childSessionId: 'workspace-b-only-child',
    });
    expect(state.get(sessionChildrenAtom('workstream-p1')))
      .toEqual(['workspace-b-only-child']);

    state.set(sessionListWorkspaceAtom, '/workspace-a');
    state.set(sessionRegistryAtom, registryWithoutP1);
    state.set(sessionStoreAtom('target'), meta('target', { parentSessionId: 'workstream-p1' }));
    expect(state.get(sessionChildrenAtom('workstream-p1')))
      .toEqual(['target', 'registered-unrelated-child', 'atom-only-child']);
    expect(state.get(sessionChildrenAtom('workstream-p1')))
      .not.toContain('workspace-b-only-child');

    listeners.get('sessions:session-reparented')?.({
      workspacePath: '/workspace-a',
      sessionId: 'target',
      oldParentSessionId: 'workstream-p0',
      newParentSessionId: 'workstream-p2',
    });
    listeners.get('sessions:session-updated')?.('target', {
      workspacePath: '/workspace-a',
      parentSessionId: 'workstream-p2',
      visibilityAuditId: 'audit-workstream-replay',
    });
    listeners.get('sessions:visibility-delivery')?.({
      auditId: 'audit-workstream-replay',
      workspaceId: 'workspace-hash-a',
      workspacePath: '/workspace-a',
      targetSessionId: 'target',
    });
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(state.get(sessionChildrenAtom('workstream-p1')))
      .toEqual(['registered-unrelated-child', 'atom-only-child', 'state-only-child']);
    expect(state.get(workstreamStateAtom('workstream-p1')).childSessionIds)
      .toEqual(['registered-unrelated-child', 'atom-only-child', 'state-only-child']);
    expect(state.get(sessionChildrenAtom('workstream-p2')))
      .toEqual(['new-parent-atom-child', 'new-parent-state-child', 'target']);
    expect(state.get(workstreamStateAtom('workstream-p2')).childSessionIds)
      .toEqual(['new-parent-atom-child', 'new-parent-state-child', 'target']);
    cleanup();
  });
});
