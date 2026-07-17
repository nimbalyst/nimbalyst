import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const provider = {
    resolveAskUserQuestion: vi.fn(() => true),
    rejectAskUserQuestion: vi.fn(),
    resolveExitPlanModeConfirmation: vi.fn(),
    resolveToolPermission: vi.fn(),
  };

  return {
    provider,
    getProvider: vi.fn(),
    getSession: vi.fn(),
    createMessage: vi.fn(),
    ipcListenerCount: vi.fn((_channel: string) => 0),
    ipcEmit: vi.fn(),
    onPromptResolved: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    listenerCount: mocks.ipcListenerCount,
    emit: mocks.ipcEmit,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ProviderFactory: {
    getProvider: mocks.getProvider,
  },
  isAskUserQuestionProvider: (candidate: unknown) =>
    !!candidate &&
    typeof (candidate as { resolveAskUserQuestion?: unknown }).resolveAskUserQuestion === 'function',
  isExitPlanModeProvider: (candidate: unknown) =>
    !!candidate &&
    typeof (candidate as { resolveExitPlanModeConfirmation?: unknown }).resolveExitPlanModeConfirmation === 'function',
  isToolPermissionProvider: (candidate: unknown) =>
    !!candidate &&
    typeof (candidate as { resolveToolPermission?: unknown }).resolveToolPermission === 'function',
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    get: mocks.getSession,
  },
  AgentMessagesRepository: {
    create: mocks.createMessage,
  },
}));

vi.mock('../../../utils/logger', () => ({
  logger: {
    ai: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('../../../tray/TrayManager', () => ({
  TrayManager: {
    getInstance: () => ({
      onPromptResolved: mocks.onPromptResolved,
    }),
  },
}));

vi.mock('../../../mcp/tools/interactiveToolHandlers', () => ({
  getRequestUserInputResponseChannel: (sessionId: string, promptId: string) =>
    `request-user-input-response:${sessionId || 'unknown'}:${promptId}`,
  getRequestUserInputFallbackResponseChannel: (sessionId: string) =>
    `request-user-input-response:${sessionId || 'unknown'}:__fallback__`,
  getToolPermissionResponseChannel: (sessionId: string, requestId: string) =>
    `tool-permission-response:${sessionId || 'unknown'}:${requestId}`,
}));

vi.mock('../../gitEnv', () => ({
  getGitSubprocessEnv: vi.fn(() => ({})),
}));

vi.mock('../../../window/WindowManager', () => ({
  findWindowByWorkspace: vi.fn(),
}));

import { resolveVoicePromptResponse } from '../MobileSessionControlHandler';

describe('MobileSessionControlHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.provider.resolveAskUserQuestion.mockReturnValue(true);
    mocks.ipcListenerCount.mockReturnValue(0);
    mocks.getSession.mockResolvedValue({ provider: 'openai-codex' });
    mocks.createMessage.mockResolvedValue(undefined);
    mocks.getProvider.mockImplementation((providerType: string, sessionId: string) =>
      providerType === 'openai-codex' && sessionId === 'session-1' ? mocks.provider : null,
    );
  });

  it('uses the session provider and always persists the mobile response', async () => {
    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_question_123',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    });

    expect(mocks.getProvider).toHaveBeenCalledWith('openai-codex', 'session-1');
    expect(mocks.provider.resolveAskUserQuestion).toHaveBeenCalledWith(
      'call_question_123',
      { Scope: 'Everything' },
      'session-1',
      'mobile',
    );
    expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      source: 'openai-codex',
      direction: 'output',
      content: expect.any(String),
    }));
    expect(JSON.parse(mocks.createMessage.mock.calls[0][0].content)).toMatchObject({
      type: 'ask_user_question_response',
      questionId: 'call_question_123',
      answers: { Scope: 'Everything' },
      cancelled: false,
      respondedBy: 'mobile',
    });
    expect(mocks.onPromptResolved).toHaveBeenCalledWith('session-1');
  });

  it('wakes the MCP waiter even when the provider consumes the response', async () => {
    mocks.ipcListenerCount.mockImplementation((channel: string) =>
      channel === 'ask-user-question-response:session-1:call_question_123' ? 1 : 0,
    );

    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_question_123',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.ipcEmit).toHaveBeenCalledWith(
        'ask-user-question-response:session-1:call_question_123',
        {},
        expect.objectContaining({
          answers: { Scope: 'Everything' },
          respondedBy: 'mobile',
          sessionId: 'session-1',
        }),
      );
    });
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
  });

  it('persists the response when no in-process provider is available', async () => {
    mocks.getProvider.mockReturnValue(null);

    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_question_123',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    });

    expect(mocks.provider.resolveAskUserQuestion).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.createMessage.mock.calls[0][0].content)).toMatchObject({
      questionId: 'call_question_123',
      answers: { Scope: 'Everything' },
      respondedBy: 'mobile',
    });
  });

  it('routes exit_plan_mode through the real provider capability', async () => {
    // ClaudeCodeProvider is currently the only production provider that
    // advertises ExitPlanMode confirmation support.
    mocks.getSession.mockResolvedValue({ provider: 'claude-code' });
    mocks.getProvider.mockImplementation((providerType: string, sessionId: string) =>
      providerType === 'claude-code' && sessionId === 'session-1' ? mocks.provider : null,
    );
    resolveVoicePromptResponse('session-1', {
      promptType: 'exit_plan_mode',
      promptId: 'call_plan_123',
      response: {
        approved: true,
        feedback: 'lgtm',
        startNewSession: true,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.provider.resolveExitPlanModeConfirmation).toHaveBeenCalledTimes(1);
    });

    expect(mocks.getProvider).toHaveBeenCalledWith('claude-code', 'session-1');
    expect(mocks.provider.resolveExitPlanModeConfirmation).toHaveBeenCalledWith(
      'call_plan_123',
      { approved: true, clearContext: true, feedback: 'lgtm' },
      'session-1',
      'mobile',
    );
    expect(mocks.onPromptResolved).toHaveBeenCalledWith('session-1');
  });

  it('persists before waking provider and IPC consumers', async () => {
    mocks.ipcListenerCount.mockImplementation((channel: string) =>
      channel === 'ask-user-question-response:session-1:call_ordered' ? 1 : 0,
    );

    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_ordered',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.ipcEmit).toHaveBeenCalledTimes(1);
    });

    expect(mocks.createMessage.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.provider.resolveAskUserQuestion.mock.invocationCallOrder[0]);
    expect(mocks.createMessage.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.ipcEmit.mock.invocationCallOrder[0]);
  });

  it('continues notification cleanup when an IPC listener throws', async () => {
    mocks.ipcListenerCount.mockReturnValue(1);
    mocks.ipcEmit.mockImplementationOnce(() => {
      throw new Error('stale listener');
    });

    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_throwing_listener',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.onPromptResolved).toHaveBeenCalledWith('session-1');
    });
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    expect(mocks.provider.resolveAskUserQuestion).toHaveBeenCalledTimes(1);
  });

  it('resolves tool_permission against the session provider (not hardcoded claude-code)', async () => {
    resolveVoicePromptResponse('session-1', {
      promptType: 'tool_permission',
      promptId: 'call_perm_123',
      response: {
        decision: 'allow',
        scope: 'once',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.provider.resolveToolPermission).toHaveBeenCalledTimes(1);
    });

    expect(mocks.getProvider).toHaveBeenCalledWith('openai-codex', 'session-1');
    expect(mocks.getProvider).not.toHaveBeenCalledWith('claude-code', 'session-1');
    expect(mocks.provider.resolveToolPermission).toHaveBeenCalledWith(
      'call_perm_123',
      { decision: 'allow', scope: 'once' },
      'session-1',
      'mobile',
    );
    expect(mocks.onPromptResolved).toHaveBeenCalledWith('session-1');
  });

  it('resolves tool_permission against an opencode provider (provider-agnostic guard)', async () => {
    mocks.getSession.mockResolvedValue({ provider: 'opencode' });
    mocks.getProvider.mockImplementation((providerType: string, sessionId: string) =>
      providerType === 'opencode' && sessionId === 'session-1' ? mocks.provider : null,
    );

    resolveVoicePromptResponse('session-1', {
      promptType: 'tool_permission',
      promptId: 'call_perm_oc',
      response: {
        decision: 'allow',
        scope: 'session',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.provider.resolveToolPermission).toHaveBeenCalledTimes(1);
    });

    expect(mocks.getProvider).toHaveBeenCalledWith('opencode', 'session-1');
    expect(mocks.getProvider).not.toHaveBeenCalledWith('claude-code', 'session-1');
    expect(mocks.provider.resolveToolPermission).toHaveBeenCalledWith(
      'call_perm_oc',
      { decision: 'allow', scope: 'session' },
      'session-1',
      'mobile',
    );
  });

  it('recovers ask_user_question on an opencode session via MCP + DB fallback (no in-process resolver)', async () => {
    // OpenCodeProvider extends BaseAgentProvider but does NOT implement
    // resolveAskUserQuestion — so this prompt must still be delivered by the
    // provider-agnostic MCP waiter + durable DB row, keyed to the real provider.
    const opencodeProvider = { resolveToolPermission: vi.fn() };
    mocks.getSession.mockResolvedValue({ provider: 'opencode' });
    mocks.getProvider.mockImplementation((providerType: string, sessionId: string) =>
      providerType === 'opencode' && sessionId === 'session-1' ? opencodeProvider : null,
    );
    mocks.ipcListenerCount.mockImplementation((channel: string) =>
      channel === 'ask-user-question-response:session-1:call_question_oc' ? 1 : 0,
    );

    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_question_oc',
      response: {
        answers: { Scope: 'Everything' },
        cancelled: false,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    });

    // No in-process AskUserQuestion resolver on opencode, so the shared mock's
    // resolver is never touched.
    expect(mocks.provider.resolveAskUserQuestion).not.toHaveBeenCalled();
    // MCP waiter woken independently...
    expect(mocks.ipcEmit).toHaveBeenCalledWith(
      'ask-user-question-response:session-1:call_question_oc',
      {},
      expect.objectContaining({ answers: { Scope: 'Everything' }, respondedBy: 'mobile' }),
    );
    // ...and the durable row is persisted under the real provider.
    expect(mocks.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      source: 'opencode',
    }));
  });

  it('preserves mobile attribution when cancelling a provider question', async () => {
    resolveVoicePromptResponse('session-1', {
      promptType: 'ask_user_question',
      promptId: 'call_question_123',
      response: {
        answers: { ignored: 'value' },
        cancelled: true,
      },
    });

    await vi.waitFor(() => {
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    });

    expect(mocks.provider.rejectAskUserQuestion).toHaveBeenCalledWith(
      'call_question_123',
      expect.any(Error),
      'mobile',
    );
    expect(JSON.parse(mocks.createMessage.mock.calls[0][0].content)).toMatchObject({
      type: 'ask_user_question_response',
      answers: {},
      cancelled: true,
      respondedBy: 'mobile',
    });
  });
});
