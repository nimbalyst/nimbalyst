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

function service(): AIService {
  const instance = Object.create(AIService.prototype) as any;
  instance.interactivePromptSettlements = new Map();
  return instance;
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
});
