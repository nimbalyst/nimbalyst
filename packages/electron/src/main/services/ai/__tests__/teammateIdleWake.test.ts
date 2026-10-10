// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createTeammateIdleWakeListener, type TeammateIdleWakeDeps } from '../teammateIdleWake';

const OWNER = '/repo';
const ADOPTED_WORKTREE = '/repo_worktrees/landing-pr';

function setup(overrides: Partial<TeammateIdleWakeDeps> = {}) {
  const window = { isDestroyed: () => false };
  const deps: TeammateIdleWakeDeps = {
    isSessionActive: () => true,
    startSession: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
    // The turn cd'd into a worktree Nimbalyst did not create, so its path was
    // adopted in memory only; the session row still belongs to OWNER.
    turnWorkspacePath: () => ADOPTED_WORKTREE,
    resolveOwnerWorkspacePath: async () => OWNER,
    findWindow: () => window,
    sendMessage: vi.fn(async () => {}),
    defer: (fn) => fn(),
    logInfo: () => {},
    logWarn: () => {},
    logError: () => {},
    ...overrides,
  };
  return { deps, wake: createTeammateIdleWakeListener(deps) };
}

describe('teammate idle wake', () => {
  it('wakes with the workspace that owns the session, not a worktree adopted mid-turn', async () => {
    const { deps, wake } = setup();
    await wake({ sessionId: 's1', message: 'background task finished' });
    await vi.waitFor(() => expect(deps.sendMessage).toHaveBeenCalled());

    expect(deps.sendMessage).toHaveBeenCalledWith(expect.anything(), 'background task finished', 's1', OWNER);
    expect(deps.startSession).toHaveBeenCalledWith({ sessionId: 's1', workspacePath: OWNER });
  });

  it('does not leave the session marked running when the wake cannot be delivered', async () => {
    const failed = setup({ sendMessage: vi.fn(async () => { throw new Error('Session s1 not found'); }) });
    await failed.wake({ sessionId: 's1', message: 'x' });
    await vi.waitFor(() => expect(failed.deps.endSession).toHaveBeenCalledWith('s1'));

    const noWindow = setup({ findWindow: () => null });
    await noWindow.wake({ sessionId: 's1', message: 'x' });
    expect(noWindow.deps.endSession).toHaveBeenCalledWith('s1');
    expect(noWindow.deps.sendMessage).not.toHaveBeenCalled();
  });
});
