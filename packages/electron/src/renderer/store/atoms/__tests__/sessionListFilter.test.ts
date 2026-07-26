import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@nimbalyst/runtime';
import {
  isWorkstreamParentSession,
  matchesSessionListTag,
  VIRTUAL_TAG_WORKSTREAMS,
  VIRTUAL_TAG_WORKTREE,
} from '../sessionListFilter';

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

describe('session list virtual tags', () => {
  const workstream = session({
    id: 'workstream',
    sessionType: 'workstream',
    childCount: 1,
  });
  const child = session({ id: 'child', parentSessionId: workstream.id });
  const standalone = session({ id: 'standalone', tags: ['feature'] });
  const worktreeSession = session({ id: 'worktree-session', worktreeId: 'wt-1' });
  const registry = new Map([workstream, child, standalone, worktreeSession].map(s => [s.id, s]));

  it('matches #workstreams for a workstream parent and its children only', () => {
    expect(matchesSessionListTag(workstream, VIRTUAL_TAG_WORKSTREAMS, registry)).toBe(true);
    expect(matchesSessionListTag(child, VIRTUAL_TAG_WORKSTREAMS, registry)).toBe(true);
    expect(matchesSessionListTag(standalone, VIRTUAL_TAG_WORKSTREAMS, registry)).toBe(false);
    expect(matchesSessionListTag(worktreeSession, VIRTUAL_TAG_WORKSTREAMS, registry)).toBe(false);
  });

  it('recognizes legacy child-bearing roots as workstreams without including blitzes', () => {
    expect(isWorkstreamParentSession(session({ id: 'legacy', childCount: 2 }))).toBe(true);
    expect(isWorkstreamParentSession(session({
      id: 'empty-typed',
      sessionType: 'workstream',
      childCount: 0,
    }))).toBe(true);
    expect(isWorkstreamParentSession(session({
      id: 'blitz',
      sessionType: 'blitz',
      childCount: 2,
    }))).toBe(false);
  });

  it('preserves the existing #worktree and persisted-tag predicates', () => {
    expect(matchesSessionListTag(worktreeSession, VIRTUAL_TAG_WORKTREE, registry)).toBe(true);
    expect(matchesSessionListTag(standalone, 'feature', registry)).toBe(true);
    expect(matchesSessionListTag(standalone, 'missing', registry)).toBe(false);
  });
});
