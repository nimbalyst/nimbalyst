// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createAskUserQuestionListeners } from '../askUserQuestionListeners';

function makeDeps() {
  const deps = {
    sendToRenderer: vi.fn(),
    openPrompt: vi.fn(),
    resolvePrompt: vi.fn(),
    hasOpenPrompts: vi.fn(() => false),
    updateSessionActivity: vi.fn(async () => {}),
    getSessionTitle: vi.fn(async () => 'Session title'),
    showBlockedNotification: vi.fn(),
    workspacePath: '/work',
    logError: vi.fn(),
  };
  return { deps, listeners: createAskUserQuestionListeners(deps) };
}

const PENDING = { questionId: 'q1', sessionId: 's1', questions: [{ id: 'a' }], timestamp: 1 };

describe('askUserQuestion host listeners', () => {
  it('advertises the pending prompt and blocks the session on pending', async () => {
    const { deps, listeners } = makeDeps();
    await listeners.onPending(PENDING);

    expect(deps.sendToRenderer).toHaveBeenCalledWith('ai:askUserQuestion', {
      ...PENDING,
      workspacePath: '/work',
    });
    expect(deps.openPrompt).toHaveBeenCalledWith('s1', 'q1', 'decision');
    expect(deps.updateSessionActivity).toHaveBeenCalledWith({
      sessionId: 's1',
      status: 'waiting_for_input',
    });
    expect(deps.showBlockedNotification).toHaveBeenCalledWith('s1', 'Session title');
  });

  it('clears the prompt and resumes streaming on a real answer', () => {
    const { deps, listeners } = makeDeps();
    listeners.onAnswered({ ...PENDING, answers: { a: 'yes' } });

    expect(deps.resolvePrompt).toHaveBeenCalledWith('s1', 'q1');
    expect(deps.updateSessionActivity).toHaveBeenCalledWith({
      sessionId: 's1',
      status: 'running',
      isStreaming: true,
    });
  });

  // Regression: GitHub #1549. Cancellation had no host listener at all, so the
  // pending-prompt advertisement outlived the question and the session kept
  // claiming to be waiting for input.
  it('clears the prompt on cancellation', () => {
    const { deps, listeners } = makeDeps();
    listeners.onCancelled(PENDING);

    expect(deps.sendToRenderer).toHaveBeenCalledWith('ai:askUserQuestionCancelled', {
      ...PENDING,
      workspacePath: '/work',
    });
    expect(deps.resolvePrompt).toHaveBeenCalledWith('s1', 'q1');
  });

  // Cancellation fires on abort, which means the turn is ending -- often
  // because the user stopped it. Mirroring the answered path's
  // `status: 'running', isStreaming: true` there would resurrect a session the
  // user just stopped, or one that already completed. The turn's own terminal
  // path owns the final status.
  it('does not touch session activity on cancellation', () => {
    const { deps, listeners } = makeDeps();
    listeners.onCancelled(PENDING);

    expect(deps.updateSessionActivity).not.toHaveBeenCalled();
  });

  // Regression: cancelling Q1 while Q2 is still open used to persist
  // hasPendingPrompt=false for the whole session, so the sidebar and menu bar
  // stopped advertising a question the user still had to answer. The bit is
  // per-session, so it has to be recomputed from what is still open rather
  // than hard-cleared by whichever prompt happened to settle first.
  it('keeps the session blocked when another question is still open', () => {
    const { deps, listeners } = makeDeps();
    deps.hasOpenPrompts.mockReturnValue(true);

    listeners.onCancelled(PENDING);

    expect(deps.resolvePrompt).toHaveBeenCalledWith('s1', 'q1');
    expect(deps.updateSessionActivity).not.toHaveBeenCalled();
  });

  it('keeps the session blocked when a tool permission is still open', () => {
    const { deps, listeners } = makeDeps();
    // The registry spans every interactive prompt kind, not just questions.
    deps.hasOpenPrompts.mockReturnValue(true);

    listeners.onAnswered({ ...PENDING, answers: { a: 'yes' } });

    expect(deps.resolvePrompt).toHaveBeenCalledWith('s1', 'q1');
    // Still waiting on the permission, so the turn is not streaming again.
    expect(deps.updateSessionActivity).not.toHaveBeenCalled();
  });

  it('resumes streaming on an answer only once nothing else is open', () => {
    const { deps, listeners } = makeDeps();
    deps.hasOpenPrompts.mockReturnValue(false);

    listeners.onAnswered({ ...PENDING, answers: { a: 'yes' } });

    expect(deps.updateSessionActivity).toHaveBeenCalledWith({
      sessionId: 's1',
      status: 'running',
      isStreaming: true,
    });
  });

  it('reports a failed status write on pending without throwing', async () => {
    const { deps, listeners } = makeDeps();
    deps.updateSessionActivity.mockRejectedValueOnce(new Error('db down'));

    await listeners.onPending(PENDING);

    await vi.waitFor(() => {
      expect(deps.logError).toHaveBeenCalled();
    });
  });
});
