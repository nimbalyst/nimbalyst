import { describe, expect, it } from 'vitest';
import {
  isStructuralWorkstreamContainer,
  reconcileActiveSessionId,
} from '../sessionHierarchy';

describe('session hierarchy identity', () => {
  it('recognizes typed, metadata-backed, and child-bearing containers', () => {
    expect(isStructuralWorkstreamContainer({ id: 'typed', sessionType: 'workstream' })).toBe(true);
    expect(isStructuralWorkstreamContainer({
      id: 'metadata',
      metadata: { isWorkstreamRoot: true },
    })).toBe(true);
    expect(isStructuralWorkstreamContainer({ id: 'legacy', childCount: 1 })).toBe(true);
    expect(isStructuralWorkstreamContainer({ id: 'session', sessionType: 'session' })).toBe(false);
  });

  it('never routes a stale active ID outside current membership', () => {
    expect(reconcileActiveSessionId({
      containerId: 'workstream',
      childSessionIds: ['member'],
      activeSessionId: 'stale',
      isStructuralContainer: true,
    })).toBe('member');
  });

  it('keeps empty containers unrouted while singleton sessions route to self', () => {
    expect(reconcileActiveSessionId({
      containerId: 'workstream',
      childSessionIds: [],
      activeSessionId: 'stale',
      isStructuralContainer: true,
    })).toBeNull();
    expect(reconcileActiveSessionId({
      containerId: 'session',
      childSessionIds: [],
      activeSessionId: null,
      isStructuralContainer: false,
    })).toBe('session');
  });
});
