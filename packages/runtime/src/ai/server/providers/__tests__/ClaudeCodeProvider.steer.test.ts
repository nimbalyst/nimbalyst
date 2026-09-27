// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => ({
  app: { ...(await import('../../../../../../electron/test-stubs/privateUserData')).testApp, isPackaged: false },
}));

vi.mock('../claudeCode/cliPathResolver', () => ({
  resolveClaudeAgentCliPath: async () => '/fake/claude',
}));

vi.mock('../../../../electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: () => ({}),
  resolveNativeBinaryPath: () => undefined,
}));

import { ClaudeCodeProvider } from '../ClaudeCodeProvider';

type ProviderInternals = {
  leadQuery: unknown;
  promptController: { end: () => void; isEnded: () => boolean; push: (text: string) => boolean } | null;
  promptEndTimer: unknown;
  wasInterrupted: boolean;
  logAgentMessage: (...args: unknown[]) => Promise<void>;
};

function runningTurn() {
  const provider = new ClaudeCodeProvider();
  const state = provider as unknown as ProviderInternals;
  const push = vi.fn(() => true);
  state.leadQuery = { interrupt: vi.fn() };
  state.promptController = { end: vi.fn(), isEnded: () => false, push };
  const log = vi.spyOn(state, 'logAgentMessage').mockResolvedValue(undefined);
  return { provider, state, push, log };
}

describe('ClaudeCodeProvider.steerCurrentTurn', () => {
  it('pushes the message onto the open prompt stream and logs it as user input', async () => {
    const { provider, push, log } = runningTurn();

    await expect(provider.steerCurrentTurn('s1', ' use the v2 API ')).resolves.toEqual({ delivered: true });
    expect(push).toHaveBeenCalledWith('use the v2 API');
    expect(log).toHaveBeenCalledWith('s1', 'claude-code', 'input', JSON.stringify({ prompt: 'use the v2 API' }),
      { deliveredMidTurn: true }, false, undefined, true);
  });

  // Past these points the loop stops reading before the agent could reply.
  it.each([
    ['after an interrupt', (s: ProviderInternals) => { s.wasInterrupted = true; }],
    ['once a result armed the prompt-end timer', (s: ProviderInternals) => { s.promptEndTimer = 1; }],
    ['with no running query', (s: ProviderInternals) => { s.leadQuery = null; }],
  ])('sends nothing %s', async (_label, windDown) => {
    const { provider, state, push, log } = runningTurn();
    windDown(state);

    await expect(provider.steerCurrentTurn('s1', 'late')).resolves.toEqual({ delivered: false });
    expect(push).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('reports not delivered when the prompt stream already ended', async () => {
    const { provider, push, log } = runningTurn();
    push.mockReturnValue(false);

    await expect(provider.steerCurrentTurn('s1', 'late')).resolves.toEqual({ delivered: false });
    expect(log).not.toHaveBeenCalled();
  });
});
