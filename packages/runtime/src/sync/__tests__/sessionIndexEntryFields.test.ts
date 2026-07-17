// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildSyncedSessionIndexFields } from '../sessionIndexEntryFields';
import type { SessionIndexData } from '../types';

/**
 * Regression lock for the desktop -> mobile session-index emission path.
 *
 * `buildSyncedSessionIndexFields` is the single source of truth for the
 * plaintext relationship/flag fields copied onto the wire `SessionIndexEntry`
 * inside `CollabV3Sync.doSyncSessionsToIndex` (the SyncManager bulk-sync path).
 * These assertions guarantee `agentRole` + `createdBySessionId` keep flowing so
 * the iOS app can group a desktop meta agent with its spawned children.
 */
function makeSession(overrides: Partial<SessionIndexData> = {}): SessionIndexData {
  return {
    id: 'session-1',
    title: 'Test session',
    provider: 'claude-code',
    messageCount: 0,
    updatedAt: 1000,
    createdAt: 1000,
    ...overrides,
  };
}

describe('buildSyncedSessionIndexFields', () => {
  it('carries agentRole for a meta-agent session', () => {
    const fields = buildSyncedSessionIndexFields(makeSession({ agentRole: 'meta-agent' }));
    expect(fields.agentRole).toBe('meta-agent');
  });

  it('carries createdBySessionId for a spawned child session', () => {
    const fields = buildSyncedSessionIndexFields(
      makeSession({ agentRole: 'standard', createdBySessionId: 'meta-session-123' }),
    );
    expect(fields.createdBySessionId).toBe('meta-session-123');
    expect(fields.agentRole).toBe('standard');
  });

  it('normalizes a null createdBySessionId (PGLite) to undefined (wire)', () => {
    const fields = buildSyncedSessionIndexFields(makeSession({ createdBySessionId: null }));
    expect(fields.createdBySessionId).toBeUndefined();
  });

  it('does not fabricate meta-agent fields for a plain session', () => {
    const fields = buildSyncedSessionIndexFields(makeSession());
    expect(fields.agentRole).toBeUndefined();
    expect(fields.createdBySessionId).toBeUndefined();
  });

  it('preserves the existing relationship/flag fields (no regression)', () => {
    const fields = buildSyncedSessionIndexFields(
      makeSession({
        sessionType: 'session',
        parentSessionId: 'parent-1',
        worktreeId: 'worktree-1',
        isArchived: true,
        isPinned: true,
        branchedFromSessionId: 'branch-src-1',
        branchPointMessageId: 7,
        branchedAt: 1234,
        agentRole: 'meta-agent',
        createdBySessionId: 'meta-session-123',
      }),
    );
    expect(fields).toEqual({
      sessionType: 'session',
      parentSessionId: 'parent-1',
      worktreeId: 'worktree-1',
      isArchived: true,
      isPinned: true,
      branchedFromSessionId: 'branch-src-1',
      branchPointMessageId: 7,
      branchedAt: 1234,
      agentRole: 'meta-agent',
      createdBySessionId: 'meta-session-123',
    });
  });
});
