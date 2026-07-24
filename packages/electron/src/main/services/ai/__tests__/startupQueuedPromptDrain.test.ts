import { describe, expect, it, vi } from 'vitest';
import { drainPendingOrdinaryPromptsOnStartup } from '../startupQueuedPromptDrain';

describe('startupQueuedPromptDrain', () => {
  it('discovers durable ordinary rows and triggers each session once without UI input', async () => {
    const listPendingOrdinarySessionIds = vi.fn(async () => ['session-a', 'session-b']);
    const resolveWorkspacePath = vi.fn(async (sessionId: string) =>
      sessionId === 'session-a' ? 'D:\\repo-a' : 'D:\\repo-b'
    );
    const triggerProcessing = vi.fn(async () => true);

    await expect(drainPendingOrdinaryPromptsOnStartup({
      listPendingOrdinarySessionIds,
      resolveWorkspacePath,
      triggerProcessing,
      logError: vi.fn(),
    })).resolves.toEqual({ discovered: 2, triggered: 2, skipped: 0 });

    expect(listPendingOrdinarySessionIds).toHaveBeenCalledTimes(1);
    expect(triggerProcessing).toHaveBeenCalledTimes(2);
    expect(triggerProcessing).toHaveBeenNthCalledWith(1, 'session-a', 'D:\\repo-a');
    expect(triggerProcessing).toHaveBeenNthCalledWith(2, 'session-b', 'D:\\repo-b');
  });

  it('keeps missing-window or failed triggers pending for a later retry', async () => {
    const error = new Error('window unavailable');
    const logError = vi.fn();
    const triggerProcessing = vi.fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(error);

    await expect(drainPendingOrdinaryPromptsOnStartup({
      listPendingOrdinarySessionIds: async () => ['session-a', 'session-b', 'session-c'],
      resolveWorkspacePath: async (sessionId) =>
        sessionId === 'session-c' ? null : `D:\\${sessionId}`,
      triggerProcessing,
      logError,
    })).resolves.toEqual({ discovered: 3, triggered: 0, skipped: 3 });

    expect(logError).toHaveBeenCalledWith('session-b', error);
  });
});
