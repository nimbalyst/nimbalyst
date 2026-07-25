import { describe, expect, it, vi } from 'vitest';
import { runTerminalPromptTransition } from '../MessageStreamingHandler';

describe.each(['normal completion', 'error completion'])('MessageStreamingHandler %s terminal transition', (kind) => {
  it('fences queue dispatch and endSession while a structured prompt is pending', async () => {
    const tryDispatch = vi.fn(async () => false);
    const endSession = vi.fn(async () => undefined);
    const sync = vi.fn();
    await expect(runTerminalPromptTransition({ metadata: { hasPendingPrompt: true }, hasActiveLease: false, tryDispatch, endSession, sync })).resolves.toEqual({ deferred: true, hasPendingPrompt: true });
    expect(tryDispatch).not.toHaveBeenCalled();
    expect(endSession).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledWith(true);
  });

  it('dispatches and ends only when no prompt is pending', async () => {
    const tryDispatch = vi.fn(async () => false);
    const endSession = vi.fn(async () => undefined);
    const sync = vi.fn();
    await expect(runTerminalPromptTransition({ metadata: { hasPendingPrompt: false }, hasActiveLease: false, tryDispatch, endSession, sync })).resolves.toEqual({ deferred: false, hasPendingPrompt: false });
    expect(tryDispatch).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(false);
  });
});
