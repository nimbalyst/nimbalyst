import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('../../FeatureUsageService.ts', () => ({
  FEATURES: { AI_PROMPT_SUBMITTED: 'ai_prompt_submitted' },
  FeatureUsageService: {
    getInstance: () => ({ recordUsage: vi.fn() }),
  },
}));

vi.mock('../../SoundNotificationService', () => ({
  SoundNotificationService: {
    getInstance: () => ({ playCompletionSound: vi.fn() }),
  },
}));

vi.mock('../../NotificationService', () => ({
  notificationService: { showNotification: vi.fn() },
}));

vi.mock('../../../tray/TrayManager', () => ({
  TrayManager: {
    getInstance: () => ({ onSessionUnread: vi.fn() }),
  },
}));

vi.mock('../../../window/WindowManager', () => ({
  windowStates: new Map(),
  findWindowByWorkspace: vi.fn(() => null),
}));

vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  getDefaultEffortLevel: () => 'high',
}));

import {
  OpenAICodexProvider,
  ProviderFactory,
} from '@nimbalyst/runtime/ai/server';
import { MessageStreamingHandler } from '../MessageStreamingHandler';

describe('MessageStreamingHandler Codex effort production handoff (#899)', () => {
  afterEach(() => {
    ProviderFactory.destroyAll();
    vi.restoreAllMocks();
  });

  it('passes persisted session effort to the actual OpenAICodexProvider initialization', async () => {
    const sessionId = 'persisted-codex-effort-session';
    const workspacePath = '/workspace/path';
    const persistedSession = {
      id: sessionId,
      provider: 'openai-codex',
      model: 'openai-codex:gpt-5.6-sol',
      title: 'Persisted Codex child',
      sessionType: 'session',
      mode: 'agent',
      workspacePath,
      providerConfig: {},
      providerSessionId: undefined,
      metadata: { effortLevel: 'xhigh' },
      messages: [
        { type: 'assistant_message', role: 'assistant', content: 'existing', timestamp: 1 },
        { type: 'user_message', role: 'user', content: 'existing', timestamp: 2 },
      ],
    };
    const sessionManager = {
      loadSession: vi.fn().mockResolvedValue(persistedSession),
      addMessage: vi.fn().mockResolvedValue(undefined),
      updateSessionTitle: vi.fn().mockResolvedValue(undefined),
    };
    const service = {
      sessionManager,
      analytics: { sendEvent: vi.fn() },
      sendMessageHandler: null,
      processingQueuedPromptIds: new Set<string>(),
      matchDebounceTimers: new Map(),
      sessionsProcessingQueue: new Set<string>(),
      hooklessWatcher: {
        ensureForSession: vi.fn().mockResolvedValue(undefined),
        stopForSession: vi.fn().mockResolvedValue(undefined),
      },
      getApiKeyForProvider: vi.fn(() => undefined),
      createToolHandler: vi.fn(() => vi.fn()),
    };
    const stopAfterHandoff = new Error('stop after provider initialization handoff');
    const initialize = vi
      .spyOn(OpenAICodexProvider.prototype, 'initialize')
      .mockRejectedValue(stopAfterHandoff);
    const handler = new MessageStreamingHandler(service as never);

    const result = await handler.handle(
      { sender: { id: 1, send: vi.fn() } } as never,
      'Run the persisted child',
      undefined,
      sessionId,
      workspacePath,
    );

    expect(sessionManager.loadSession).toHaveBeenCalledWith(sessionId, workspacePath);
    expect(ProviderFactory.getProvider('openai-codex', sessionId)).toBeInstanceOf(OpenAICodexProvider);
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
      effortLevel: 'xhigh',
      model: 'gpt-5.6-sol',
    }));
    expect(result).toEqual({ content: '' });

    handler.destroy();
  });
});
