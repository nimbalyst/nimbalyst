import { describe, expect, it, vi } from 'vitest';
import { createVoiceSessionHandoff } from '../voiceSessionHandoff';

describe('createVoiceSessionHandoff', () => {
  it('creates once across repeated handoff calls and targets the created session for the follow-up prompt', async () => {
    let resolveCreation: ((value: { success: true; sessionId: string; title: string }) => void) | undefined;
    const createSession = vi.fn(() => new Promise<{ success: true; sessionId: string; title: string }>((resolve) => {
      resolveCreation = resolve;
    }));
    const handoff = createVoiceSessionHandoff();

    const firstCreation = handoff.createSessionOnce(createSession);
    const repeatedCreation = handoff.createSessionOnce(createSession);

    expect(createSession).toHaveBeenCalledTimes(1);
    resolveCreation?.({ success: true, sessionId: 'created-session', title: 'Fresh session' });
    await expect(firstCreation).resolves.toEqual({
      success: true,
      sessionId: 'created-session',
      title: 'Fresh session',
    });
    await expect(repeatedCreation).resolves.toEqual({
      success: true,
      sessionId: 'created-session',
      title: 'Fresh session',
    });

    await expect(handoff.createSessionOnce(createSession)).resolves.toMatchObject({
      sessionId: 'created-session',
    });
    expect(createSession).toHaveBeenCalledTimes(1);

    expect(handoff.takePromptTarget('different-active-session')).toBe('created-session');
    expect(handoff.takePromptTarget('different-active-session')).toBe('different-active-session');
  });

  it('allows session creation to be retried after a failed attempt', async () => {
    const createSession = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'database unavailable' })
      .mockResolvedValueOnce({ success: true, sessionId: 'retry-session', title: 'Retry' });
    const handoff = createVoiceSessionHandoff();

    await expect(handoff.createSessionOnce(createSession)).resolves.toEqual({
      success: false,
      error: 'database unavailable',
    });
    await expect(handoff.createSessionOnce(createSession)).resolves.toMatchObject({
      success: true,
      sessionId: 'retry-session',
    });
    expect(createSession).toHaveBeenCalledTimes(2);
  });
});
