import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';

const { query, getSession, clearPending } = vi.hoisted(() => ({
  query: vi.fn(),
  getSession: vi.fn(),
  clearPending: vi.fn(),
}));

vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query } }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: getSession },
}));
vi.mock('../pendingPromptPersistence', () => ({ setSessionPendingPrompt: clearPending }));

import { ProviderFactory } from '@nimbalyst/runtime/ai/server';
import { AIService } from '../AIService';

const params = {
  sessionId: 'session-a',
  promptId: 'question-a',
  promptType: 'ask_user_question_request' as const,
  response: { answers: { answer: 'Continue' } },
};

function service(
  sendMessageHandler: ReturnType<typeof vi.fn> | null = null,
  usableContinuationEvent = true,
): AIService {
  const instance = Object.create(AIService.prototype) as any;
  instance.interactivePromptSettlements = new Map();
  instance.sendMessageHandler = sendMessageHandler;
  instance.getAskUserQuestionContinuationEvent = vi.fn(
    () => usableContinuationEvent ? { sender: {} } : null
  );
  return instance;
}

function canonicalRequest(questionId = params.promptId): string {
  return JSON.stringify({
    type: 'nimbalyst_tool_use',
    id: questionId,
    name: 'AskUserQuestion',
    input: {
      questions: [{
        header: 'Acceptance',
        question: 'Continue?',
        options: [{ label: 'Continue', description: 'Resume the session' }],
      }],
    },
  });
}

function completionMarker(questionId = params.promptId): string {
  return JSON.stringify({
    type: 'ask_user_question_continuation_completed',
    questionId,
  });
}

function contentType(content: unknown): string | undefined {
  if (typeof content !== 'string') return undefined;
  try {
    return JSON.parse(content).type;
  } catch {
    return undefined;
  }
}

beforeEach(() => {
  query.mockReset();
  getSession.mockReset().mockResolvedValue({ provider: 'claude-code' });
  clearPending.mockReset().mockResolvedValue(undefined);
  (ipcMain as any).listenerCount = vi.fn((channel: string) => channel.startsWith('ask-user-question-response:') ? 1 : 0);
  (ipcMain as any).emit = vi.fn();
  vi.spyOn(ProviderFactory, 'getProvider').mockReturnValue({
    resolveAskUserQuestion: vi.fn(() => false),
  } as any);
});

describe('AIService.respondToInteractivePrompt production settlement', () => {
  it('writes one durable answer and resumes one IPC waiter for concurrent duplicates', async () => {
    const inserted: unknown[] = [];
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('ask_user_question_response')) return { rows: [] };
      if (sql.includes('INSERT INTO ai_agent_messages')) { inserted.push(values?.[3]); return { rows: [] }; }
      return { rows: [{ id: 'request' }] };
    });

    const instance = service();
    await expect(Promise.all([instance.respondToInteractivePrompt(params), instance.respondToInteractivePrompt(params)])).resolves.toEqual([{ success: true }, { success: true }]);
    expect(inserted).toHaveLength(1);
    expect((ipcMain as any).emit).toHaveBeenCalledTimes(1);
    expect(clearPending).toHaveBeenCalledTimes(1);
  });

  it('replays a partial durable row through its waiter and clears pending state', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('ask_user_question_response')) {
        return { rows: [{ content: JSON.stringify({ type: 'ask_user_question_response', questionId: params.promptId, answers: { answer: 'Continue' } }) }] };
      }
      if (sql.includes('INSERT INTO ai_agent_messages')) throw new Error('must not insert a replay');
      return { rows: [{ id: 'request' }] };
    });

    await expect(service().respondToInteractivePrompt(params)).resolves.toEqual({ success: true });
    expect((ipcMain as any).emit).toHaveBeenCalledTimes(1);
    expect(clearPending).toHaveBeenCalledWith(params.sessionId, false);
  });

  it('persists and settles a cancelled answer once', async () => {
    query.mockImplementation(async (sql: string) => ({ rows: sql.includes('ask_user_question_response') ? [] : [{ id: 'request' }] }));

    await expect(service().respondToInteractivePrompt({ ...params, response: { cancelled: true } })).resolves.toEqual({ success: true });
    expect((ipcMain as any).emit.mock.calls[0]?.[2]).toMatchObject({ cancelled: true });
    expect(clearPending).toHaveBeenCalledWith(params.sessionId, false);
  });

  it('accepts a canonical durable AskUserQuestion request keyed by tool-use id', async () => {
    (ipcMain as any).listenerCount = vi.fn(() => 0);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('ask_user_question_response')) return { rows: [] };
      if (sql.includes('INSERT INTO ai_agent_messages')) return { rows: [] };
      return { rows: [{ id: 'request', content: canonicalRequest() }] };
    });
    const sendMessageHandler = vi.fn(async (..._args: unknown[]) => ({ content: 'resumed' }));

    await expect(service(sendMessageHandler).respondToInteractivePrompt(params)).resolves.toEqual({ success: true });

    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(sendMessageHandler.mock.calls[0]?.[1]).toContain('answer: Continue');
    expect(clearPending).toHaveBeenCalledWith(params.sessionId, false);
  });

  it('persists and resumes a concurrent canonical response at most once', async () => {
    (ipcMain as any).listenerCount = vi.fn(() => 0);
    const inserted: unknown[] = [];
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('ask_user_question_response')) return { rows: [] };
      if (sql.includes('INSERT INTO ai_agent_messages')) {
        inserted.push(values?.[3]);
        return { rows: [] };
      }
      return { rows: [{ id: 'request', content: canonicalRequest() }] };
    });
    const sendMessageHandler = vi.fn(async (..._args: unknown[]) => ({ content: 'resumed' }));
    const instance = service(sendMessageHandler);

    await expect(Promise.all([
      instance.respondToInteractivePrompt(params),
      instance.respondToInteractivePrompt(params),
    ])).resolves.toEqual([{ success: true }, { success: true }]);

    expect(inserted.filter((content) => contentType(content) === 'ask_user_question_response')).toHaveLength(1);
    expect(inserted.filter((content) => contentType(content) === 'ask_user_question_continuation_completed')).toHaveLength(1);
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(clearPending).toHaveBeenCalledTimes(1);
  });

  it('resumes a persisted canonical response exactly once when its completion marker is absent', async () => {
    (ipcMain as any).listenerCount = vi.fn(() => 0);
    const inserted: unknown[] = [];
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('ask_user_question_response')) {
        return {
          rows: [{
            content: JSON.stringify({
              type: 'ask_user_question_response',
              questionId: params.promptId,
              answers: { answer: 'Continue' },
            }),
          }],
        };
      }
      if (sql.includes('ask_user_question_continuation_completed')) return { rows: [] };
      if (sql.includes('INSERT INTO ai_agent_messages')) {
        inserted.push(values?.[3]);
        return { rows: [] };
      }
      return { rows: [{ id: 'request', content: canonicalRequest() }] };
    });
    const sendMessageHandler = vi.fn(async (..._args: unknown[]) => ({ content: 'resumed' }));

    await expect(service(sendMessageHandler).respondToInteractivePrompt(params)).resolves.toEqual({ success: true });

    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(inserted.filter((content) => contentType(content) === 'ask_user_question_response')).toHaveLength(0);
    expect(inserted.filter((content) => contentType(content) === 'ask_user_question_continuation_completed')).toHaveLength(1);
    expect(clearPending).toHaveBeenCalledWith(params.sessionId, false);
  });

  it('fails closed without a live handler or usable workspace window', async () => {
    (ipcMain as any).listenerCount = vi.fn(() => 0);
    vi.spyOn(ProviderFactory, 'getProvider').mockReturnValue(null);
    const inserted: unknown[] = [];
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('ask_user_question_response')) return { rows: [] };
      if (sql.includes('ask_user_question_continuation_completed')) return { rows: [] };
      if (sql.includes('INSERT INTO ai_agent_messages')) {
        inserted.push(values?.[3]);
        return { rows: [] };
      }
      return { rows: [{ id: 'request', content: canonicalRequest() }] };
    });

    await expect(service(null, false).respondToInteractivePrompt(params)).resolves.toEqual({
      success: false,
      error: 'No continuation route available',
    });

    expect(inserted).toHaveLength(0);
    expect(clearPending).not.toHaveBeenCalled();
  });

  it('shares an unresolved canonical continuation across a replay without false acceptance', async () => {
    (ipcMain as any).listenerCount = vi.fn(() => 0);
    vi.spyOn(ProviderFactory, 'getProvider').mockReturnValue(null);
    let resolveHandler!: (value: { content: string }) => void;
    const handlerPromise = new Promise<{ content: string }>((resolve) => {
      resolveHandler = resolve;
    });
    const sendMessageHandler = vi.fn(() => handlerPromise);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('ask_user_question_response')) return { rows: [] };
      if (sql.includes('ask_user_question_continuation_completed')) return { rows: [] };
      if (sql.includes('INSERT INTO ai_agent_messages')) return { rows: [] };
      return { rows: [{ id: 'request', content: canonicalRequest() }] };
    });
    const instance = service(sendMessageHandler);

    let firstSettled = false;
    let replaySettled = false;
    const first = instance.respondToInteractivePrompt(params).then((result) => {
      firstSettled = true;
      return result;
    });
    await vi.waitFor(() => expect(sendMessageHandler).toHaveBeenCalledTimes(1));
    const replay = instance.respondToInteractivePrompt(params).then((result) => {
      replaySettled = true;
      return result;
    });
    await Promise.resolve();

    expect(firstSettled).toBe(false);
    expect(replaySettled).toBe(false);
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(clearPending).not.toHaveBeenCalled();

    resolveHandler({ content: 'resumed' });
    await expect(Promise.all([first, replay])).resolves.toEqual([{ success: true }, { success: true }]);
    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(clearPending).toHaveBeenCalledTimes(1);
  });

  it('preserves pending state when the canonical continuation rejects', async () => {
    (ipcMain as any).listenerCount = vi.fn(() => 0);
    vi.spyOn(ProviderFactory, 'getProvider').mockReturnValue(null);
    const inserted: unknown[] = [];
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('ask_user_question_response')) return { rows: [] };
      if (sql.includes('ask_user_question_continuation_completed')) return { rows: [] };
      if (sql.includes('INSERT INTO ai_agent_messages')) {
        inserted.push(values?.[3]);
        return { rows: [] };
      }
      return { rows: [{ id: 'request', content: canonicalRequest() }] };
    });
    const sendMessageHandler = vi.fn(async () => {
      throw new Error('resume rejected');
    });

    await expect(service(sendMessageHandler).respondToInteractivePrompt(params)).resolves.toEqual({
      success: false,
      error: 'Continuation failed',
    });

    expect(inserted.filter((content) => contentType(content) === 'ask_user_question_response')).toHaveLength(1);
    expect(inserted.filter((content) => contentType(content) === 'ask_user_question_continuation_completed')).toHaveLength(0);
    expect(clearPending).not.toHaveBeenCalled();
  });

  it('does not rerun a completed canonical continuation on a later replay', async () => {
    (ipcMain as any).listenerCount = vi.fn(() => 0);
    vi.spyOn(ProviderFactory, 'getProvider').mockReturnValue(null);
    let responsePersisted = false;
    let completionPersisted = false;
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('ask_user_question_response')) {
        return {
          rows: responsePersisted
            ? [{ content: JSON.stringify({ type: 'ask_user_question_response', questionId: params.promptId, answers: { answer: 'Continue' } }) }]
            : [],
        };
      }
      if (sql.includes('ask_user_question_continuation_completed')) {
        return { rows: completionPersisted ? [{ content: completionMarker() }] : [] };
      }
      if (sql.includes('INSERT INTO ai_agent_messages')) {
        const type = contentType(values?.[3]);
        if (type === 'ask_user_question_response') responsePersisted = true;
        if (type === 'ask_user_question_continuation_completed') completionPersisted = true;
        return { rows: [] };
      }
      return { rows: [{ id: 'request', content: canonicalRequest() }] };
    });
    const sendMessageHandler = vi.fn(async () => ({ content: 'resumed' }));
    const instance = service(sendMessageHandler);

    await expect(instance.respondToInteractivePrompt(params)).resolves.toEqual({ success: true });
    await expect(instance.respondToInteractivePrompt(params)).resolves.toEqual({ success: true });

    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(completionPersisted).toBe(true);
    expect(clearPending).toHaveBeenCalledTimes(1);
  });

  it('does not fallback-resume a replay after a successful live canonical settlement', async () => {
    vi.spyOn(ProviderFactory, 'getProvider').mockReturnValue(null);
    let liveWaiterAvailable = true;
    (ipcMain as any).listenerCount = vi.fn(
      (channel: string) => liveWaiterAvailable && channel.startsWith('ask-user-question-response:') ? 1 : 0
    );
    let responsePersisted = false;
    let completionPersisted = false;
    const inserted: unknown[] = [];
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('ask_user_question_response')) {
        return {
          rows: responsePersisted
            ? [{ content: JSON.stringify({ type: 'ask_user_question_response', questionId: params.promptId, answers: { answer: 'Continue' } }) }]
            : [],
        };
      }
      if (sql.includes('ask_user_question_continuation_completed')) {
        return { rows: completionPersisted ? [{ content: completionMarker() }] : [] };
      }
      if (sql.includes('INSERT INTO ai_agent_messages')) {
        inserted.push(values?.[3]);
        const type = contentType(values?.[3]);
        if (type === 'ask_user_question_response') responsePersisted = true;
        if (type === 'ask_user_question_continuation_completed') completionPersisted = true;
        return { rows: [] };
      }
      return { rows: [{ id: 'request', content: canonicalRequest() }] };
    });
    const sendMessageHandler = vi.fn(async () => ({ content: 'must not resume' }));
    const instance = service(sendMessageHandler);

    await expect(instance.respondToInteractivePrompt(params)).resolves.toEqual({ success: true });
    liveWaiterAvailable = false;
    await expect(instance.respondToInteractivePrompt(params)).resolves.toEqual({ success: true });

    expect(inserted.filter((content) => contentType(content) === 'ask_user_question_response')).toHaveLength(1);
    expect(inserted.filter((content) => contentType(content) === 'ask_user_question_continuation_completed')).toHaveLength(1);
    expect((ipcMain as any).emit).toHaveBeenCalledTimes(1);
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(clearPending).toHaveBeenCalledTimes(1);
  });

  it('keeps accepting the legacy durable request encoding', async () => {
    (ipcMain as any).listenerCount = vi.fn(() => 0);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('ask_user_question_response')) return { rows: [] };
      if (sql.includes('INSERT INTO ai_agent_messages')) return { rows: [] };
      return {
        rows: [{
          id: 'request',
          content: JSON.stringify({
            type: 'ask_user_question_request',
            questionId: params.promptId,
          }),
        }],
      };
    });

    await expect(service().respondToInteractivePrompt(params)).resolves.toEqual({ success: true });
    expect(clearPending).toHaveBeenCalledWith(params.sessionId, false);
  });
});
