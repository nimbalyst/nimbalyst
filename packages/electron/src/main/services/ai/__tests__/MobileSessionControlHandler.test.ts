import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const provider = {
    resolveAskUserQuestion: vi.fn(() => true),
    rejectAskUserQuestion: vi.fn(),
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
