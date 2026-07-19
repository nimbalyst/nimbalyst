import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: any[]) => Promise<any>;

const harness = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  cancelInteractivePrompt: vi.fn(async () => 1),
  notify: vi.fn(async () => ({ configured: true, sent: true })),
  settleConfigured: vi.fn(),
  getSession: vi.fn(async () => ({ provider: 'claude-code', workspacePath: '/workspace' })),
  createMessage: vi.fn(async () => undefined),
  getProvider: vi.fn(() => null),
  trayResolved: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    whenReady: vi.fn(async () => undefined),
    quit: vi.fn(),
    isReady: vi.fn(() => true),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  ipcMain: {
    emit: vi.fn(),
    handle: vi.fn(),
    listenerCount: vi.fn(() => 0),
    on: vi.fn(),
  },
  ipcRenderer: { send: vi.fn(), on: vi.fn(), invoke: vi.fn() },
}));

vi.mock('electron-store', () => ({
  default: class MockStore {
    get(_key: string, fallback?: unknown) { return fallback; }
    set() {}
  },
}));

vi.mock('electron-log', () => {
  const channel = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { default: { ...channel, scope: vi.fn(() => channel) } };
});
vi.mock('electron-log/main', () => {
  const channel = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { default: { ...channel, scope: vi.fn(() => channel) } };
});

vi.mock('../../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, handler: Handler) => harness.handlers.set(channel, handler),
  safeOn: vi.fn(),
  safeOnce: vi.fn(),
  removeHandler: vi.fn(),
  removeAllListeners: vi.fn(),
}));

vi.mock('../pendingPromptPersistence', () => ({
  runClaimedPendingPromptAction: async (
    _sessionId: string,
    _promptId: string,
    action: (input: {
      ownership: { sessionId: string; promptIdentity: string; attentionGeneration: string };
      promptClear: { updated: boolean; pendingPromptId?: string };
    }) => Promise<any>,
  ) => {
    const promptClear = { updated: true };
    const value = await action({
      ownership: {
        sessionId: 'session-real-path',
        promptIdentity: 'prompt-real-path',
        attentionGeneration: 'generation-real-path',
      },
      promptClear,
    });
    return { claimed: true, value, promptClear };
  },
  setSessionPendingPrompt: vi.fn(),
}));

vi.mock('../../AttentionEventService', () => ({
  attentionEventService: {
    cancelInteractivePrompt: harness.cancelInteractivePrompt,
    cancelAllForSession: vi.fn(),
  },
}));

vi.mock('../../NativeWinnerNotificationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../NativeWinnerNotificationService')>();
  return {
    ...actual,
    settleConfiguredInteractiveAttentionAfterResponse: (
      ...args: Parameters<typeof actual.settleConfiguredInteractiveAttentionAfterResponse>
    ) => harness.settleConfigured(...args),
  };
});

vi.mock('../../../tray/TrayManager', () => ({
  TrayManager: {
    getInstance: () => ({ onPromptResolved: harness.trayResolved }),
  },
}));

vi.mock('../../../utils/logger', () => {
  const channel = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: { main: channel, ai: channel } };
});

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: {
    get: harness.getSession,
    updateMetadata: vi.fn(async () => undefined),
  },
}));

vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { create: harness.createMessage },
}));

vi.mock('@nimbalyst/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nimbalyst/runtime')>();
  return {
    ...actual,
    AISessionsRepository: { get: harness.getSession },
    AgentMessagesRepository: { create: harness.createMessage },
  };
});

vi.mock('@nimbalyst/runtime/ai/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nimbalyst/runtime/ai/server')>();
  return {
    ...actual,
    ProviderFactory: { ...actual.ProviderFactory, getProvider: harness.getProvider },
  };
});

import { AIService } from '../AIService';
import { deliverMobilePromptResponse } from '../MobilePromptDelivery';
import { settleInteractiveAttentionAfterResponse } from '../../NativeWinnerNotificationService';

function registerRealAIServiceHandlers(): void {
  (AIService.prototype as any).setupIpcHandlers.call({
    sendMessageHandler: null,
    streamingHandler: { handle: vi.fn() },
  });
}

function handler(channel: string): Handler {
  const registered = harness.handlers.get(channel);
  if (!registered) throw new Error(`Missing production handler: ${channel}`);
  return registered;
}

describe('native-winner wiring coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.handlers.clear();
    harness.cancelInteractivePrompt.mockResolvedValue(1);
    harness.getProvider.mockReturnValue(null);
    harness.settleConfigured.mockImplementation((cancel, input, onNotificationError) =>
      settleInteractiveAttentionAfterResponse({
        cancelInteractivePrompt: cancel,
        notificationService: { notify: harness.notify },
        onNotificationError,
      }, input),
    );
  });

  it('notifies after the real desktop ExitPlanMode answer settles attention once', async () => {
    registerRealAIServiceHandlers();

    await handler('ai:exitPlanModeConfirmResponse')(
      {},
      'exit-plan-request',
      'desktop-session',
      { approved: false },
    );

    expect(harness.settleConfigured).toHaveBeenCalledWith(
      expect.any(Function),
      {
        sessionId: 'desktop-session',
        eventIdentity: 'exit-plan-request',
        attentionGeneration: 'generation-real-path',
        respondedBy: 'desktop',
        cancelReason: 'answered',
      },
      expect.any(Function),
    );
    expect(harness.notify).toHaveBeenCalledOnce();
  });

  it('runs the real desktop question-cancel settlement but skips notification', async () => {
    registerRealAIServiceHandlers();

    await handler('claude-code:cancel-question')({}, {
      questionId: 'question-request',
      sessionId: 'desktop-session',
    });

    expect(harness.settleConfigured).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        respondedBy: 'desktop',
        cancelReason: 'cancelled',
      }),
      expect.any(Function),
    );
    expect(harness.cancelInteractivePrompt).toHaveBeenCalledOnce();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it('notifies after the real mobile delivery path settles an answered prompt once', async () => {
    await deliverMobilePromptResponse({
      promptType: 'ask_user_question',
      sessionId: 'mobile-session',
      promptId: 'mobile-prompt',
      ipcPayload: { cancelled: false },
      notify: vi.fn(),
    });

    expect(harness.settleConfigured).toHaveBeenCalledWith(
      expect.any(Function),
      {
        sessionId: 'mobile-session',
        eventIdentity: 'mobile-prompt',
        attentionGeneration: 'generation-real-path',
        respondedBy: 'mobile',
        cancelReason: 'answered',
      },
      expect.any(Function),
    );
    expect(harness.notify).toHaveBeenCalledOnce();
  });

  it('skips notification when a real mobile settlement cancels zero attention rows', async () => {
    harness.cancelInteractivePrompt.mockResolvedValue(0);

    await deliverMobilePromptResponse({
      promptType: 'request_user_input',
      sessionId: 'mobile-session',
      promptId: 'mobile-prompt',
      ipcPayload: { cancelled: false },
      notify: vi.fn(),
    });

    expect(harness.settleConfigured).toHaveBeenCalledOnce();
    expect(harness.notify).not.toHaveBeenCalled();
  });
});
