// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { clearStuckRunningState, type StuckRunningStateDeps } from '../clearStuckRunningState';

function createDeps(liveState: { status: string; isStreaming: boolean } | null) {
  const interruptSession = vi.fn(async () => {});
  const deps: StuckRunningStateDeps = {
    getSessionState: () => liveState as never,
    interruptSession,
    logWarn: vi.fn(),
  };
  return { deps, interruptSession };
}

describe('clearStuckRunningState', () => {
  it('forces a zombie running session idle when the provider had no turn to interrupt', async () => {
    const { deps, interruptSession } = createDeps({ status: 'running', isStreaming: false });

    await expect(clearStuckRunningState(deps, { sessionId: 's1', hadActiveTurn: false })).resolves.toBe(true);
    expect(interruptSession).toHaveBeenCalledWith('s1');
  });

  it('treats a lingering isStreaming flag as stuck too', async () => {
    const { deps, interruptSession } = createDeps({ status: 'idle', isStreaming: true });

    await expect(clearStuckRunningState(deps, { sessionId: 's1', hadActiveTurn: false })).resolves.toBe(true);
    expect(interruptSession).toHaveBeenCalledWith('s1');
  });

  // The load-bearing case: a real turn winding down must keep its running state
  // until it emits its own terminal transition. Forcing idle here would let the
  // queue drive dispatch the next prompt into a still-live turn.
  it('leaves a gracefully interrupted turn alone', async () => {
    const { deps, interruptSession } = createDeps({ status: 'running', isStreaming: true });

    await expect(
      clearStuckRunningState(deps, { sessionId: 's1', hadActiveTurn: true, method: 'interrupt' }),
    ).resolves.toBe(false);
    expect(interruptSession).not.toHaveBeenCalled();
  });

  // The hard-abort fallback destroys the turn outright, so no terminal event
  // will ever follow it. Without forcing idle here, send-now on a Codex session
  // strands its own queued prompt behind `session-busy` forever.
  it('forces idle after the hard-abort fallback even when a turn was live', async () => {
    const { deps, interruptSession } = createDeps({ status: 'running', isStreaming: true });

    await expect(
      clearStuckRunningState(deps, { sessionId: 's1', hadActiveTurn: undefined, method: 'abort' }),
    ).resolves.toBe(true);
    expect(interruptSession).toHaveBeenCalledWith('s1');
  });

  it('does nothing when the provider cannot report whether a turn was active', async () => {
    const { deps, interruptSession } = createDeps({ status: 'running', isStreaming: false });

    await expect(clearStuckRunningState(deps, { sessionId: 's1', hadActiveTurn: undefined })).resolves.toBe(false);
    expect(interruptSession).not.toHaveBeenCalled();
  });

  it('does nothing when the session is not tracked as busy', async () => {
    const { deps, interruptSession } = createDeps(null);

    await expect(clearStuckRunningState(deps, { sessionId: 's1', hadActiveTurn: false })).resolves.toBe(false);
    expect(interruptSession).not.toHaveBeenCalled();
  });
});
