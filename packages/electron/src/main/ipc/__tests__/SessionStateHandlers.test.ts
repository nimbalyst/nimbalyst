import { describe, it, expect, vi } from 'vitest';
import { pushExecutionStateToMobile } from '../SessionStateHandlers';
import type { SessionStateEvent } from '@nimbalyst/runtime/ai/server/types/SessionState';

function makeEvent(type: SessionStateEvent['type'], sessionId = 's1'): SessionStateEvent {
  return { type, sessionId, workspacePath: '/ws' } as SessionStateEvent;
}

function makeProvider() {
  return { pushChange: vi.fn() };
}

describe('pushExecutionStateToMobile', () => {
  it('pushes isExecuting=true on session:started', () => {
    const provider = makeProvider();
    pushExecutionStateToMobile(makeEvent('session:started'), provider as any);
    expect(provider.pushChange).toHaveBeenCalledTimes(1);
    const [sessionId, change] = provider.pushChange.mock.calls[0];
    expect(sessionId).toBe('s1');
    expect(change.type).toBe('metadata_updated');
    expect(change.metadata.isExecuting).toBe(true);
  });

  it('pushes isExecuting=false on session:completed', () => {
    const provider = makeProvider();
    pushExecutionStateToMobile(makeEvent('session:completed'), provider as any);
    expect(provider.pushChange).toHaveBeenCalledTimes(1);
    expect(provider.pushChange.mock.calls[0][1].metadata.isExecuting).toBe(false);
  });

  it('pushes isExecuting=false on session:interrupted', () => {
    const provider = makeProvider();
    pushExecutionStateToMobile(makeEvent('session:interrupted'), provider as any);
    expect(provider.pushChange.mock.calls[0][1].metadata.isExecuting).toBe(false);
  });

  it('ignores non-lifecycle events', () => {
    const provider = makeProvider();
    pushExecutionStateToMobile(makeEvent('session:activity' as SessionStateEvent['type']), provider as any);
    expect(provider.pushChange).not.toHaveBeenCalled();
  });

  it('does not throw and does not push when the provider is null', () => {
    expect(() => pushExecutionStateToMobile(makeEvent('session:completed'), null)).not.toThrow();
  });

  // Regression for NIM-945: provider is resolved per-event, not captured once.
  // If sync is not ready when the first event fires, a later event (once the
  // provider exists) must still push. This is the core of the stuck-spinner bug.
  it('pushes on a later event once the provider becomes available', () => {
    const provider = makeProvider();
    // First event arrives before sync is ready -> no push, no throw.
    pushExecutionStateToMobile(makeEvent('session:started'), null);
    expect(provider.pushChange).not.toHaveBeenCalled();
    // Provider now available -> completion must reach mobile.
    pushExecutionStateToMobile(makeEvent('session:completed'), provider as any);
    expect(provider.pushChange).toHaveBeenCalledTimes(1);
    expect(provider.pushChange.mock.calls[0][1].metadata.isExecuting).toBe(false);
  });
});
