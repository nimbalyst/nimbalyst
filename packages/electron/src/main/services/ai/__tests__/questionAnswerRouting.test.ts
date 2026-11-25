// @vitest-environment node
/**
 * Session 723ddabd: the user answered an older, still-open Claude Code card
 * while a newer question was live. The answer had no waiter on its own channel,
 * so it went down the session fallback and settled the live question (a
 * different one); resubmitting then auto-resumed mid-turn and aborted it.
 * An answer belongs to its own card: with no live waiter for that card it
 * becomes the card's terminal result, and it never resumes over a live prompt.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  return {
    ipcMain: new EventEmitter(),
    rows: [] as Array<{ sessionId: string; toolUseId: string; result: any }>,
    reservations: new Map<string, unknown>(),
    handlers: new Map<string, (...args: any[]) => any>(),
    provider: 'claude-code',
    providerInstance: undefined as undefined | { rejectAskUserQuestion?: (...a: unknown[]) => void; abort?: () => void; isLeadBusy?: () => boolean },
    queued: new Map<string, { id: string; sessionId: string; prompt: string; documentContext?: unknown; status?: string }>(),
    /** Rows the turn-end dispatch claims between our list and our claim. */
    raced: new Set<string>(),
  };
});

vi.mock('electron', () => ({ ipcMain: h.ipcMain }));
vi.mock('../../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));
vi.mock('../../../mcp/tools/interactivePromptTranscript', () => ({
  persistInteractivePromptToolResult: vi.fn(async (a: { sessionId: string; toolUseId: string; result: any }) => { h.rows.push(a); }),
}));
vi.mock('../pendingPromptPersistence', () => ({ setSessionPendingPrompt: vi.fn(async () => {}) }));
vi.mock('../../../utils/privateSettingsStore', () => ({
  default: class {
    get(key: string) { return h.reservations.get(key); }
    set(key: string, value: unknown) { h.reservations.set(key, value); }
  },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { create: vi.fn(async () => undefined) },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: vi.fn(async () => ({ provider: h.provider, workspacePath: '/ws' })) },
}));
vi.mock('@nimbalyst/runtime/ai/server', () => ({ ProviderFactory: { getProvider: () => h.providerInstance }, isAskUserQuestionProvider: () => false }));
vi.mock('../../../utils/ipcRegistry', () => ({ safeHandle: (channel: string, fn: (...args: any[]) => any) => h.handlers.set(channel, fn) }));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('../CommitProposalExecution', () => ({ cancelCommitProposalOnce: vi.fn(), acceptsCommitProposalResponse: vi.fn() }));
vi.mock('../../SessionCommitService', () => ({ SessionCommitService: {} }));
vi.mock('@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository', () => ({ TranscriptMigrationRepository: { hasService: () => false } }));
vi.mock('../../../tray/TrayManager', () => ({ TrayManager: { getInstance: () => ({ onPromptResolved: vi.fn() }) } }));
vi.mock('../../../mcp/tools/codexToolCallResolver', () => ({
  resolveRequestUserInputPromptTargets: (id: string) => ({ promptId: id, waiterPromptIds: [id] }),
}));
vi.mock('../gitCommitProposalPromptUtils', () => ({ getGitCommitProposalResponseChannel: vi.fn(), resolveGitCommitProposalPromptId: vi.fn() }));
vi.mock('../codexQuestionDelivery', () => ({ deliverCodexQuestionAnswer: vi.fn(), configureCodexQuestionDelivery: vi.fn() }));
vi.mock('../../SyncManager', () => ({ getSyncProvider: () => null }));
vi.mock('../../RepositoryManager', () => ({
  getQueuedPromptsStore: () => ({
    get: async (id: string) => h.queued.get(id) ?? null,
    create: async (row: { id: string; sessionId: string; prompt: string }) => { h.queued.set(row.id, { ...row, status: 'pending' }); return row; },
    listPending: async (sessionId: string) => [...h.queued.values()].filter((row) => row.sessionId === sessionId && row.status === 'pending'),
    claim: async (id: string) => {
      const row = h.queued.get(id);
      if (row?.status !== 'pending') return null;
      row.status = 'executing';
      return h.raced.has(id) ? null : row;
    },
    complete: async (id: string) => { const row = h.queued.get(id); if (row) row.status = 'completed'; },
    delete: async (id: string) => { h.queued.delete(id); },
  }),
}));

import { registerSessionPromptResponseHandler } from '../../../ipc/sessionPromptResponseHandler';
import { registerAskUserQuestionAnswerHandler } from '../ipc/registerAskUserQuestionAnswerHandler';
import { configureRequestUserInputResume, LATE_ANSWER_PREAMBLE, takeLateAnswersForRunningTurn } from '../requestUserInputOrphanedAnswer';
import { registerInteractivePromptHandlers } from '../ipc/registerInteractivePromptHandlers';
import { clearLiveInteractivePrompt, noteLiveInteractivePrompt } from '../../../mcp/tools/interactivePromptLiveness';
import { openPrompt } from '../openPromptRegistry';
import { setSessionPendingPrompt } from '../pendingPromptPersistence';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';

let n = 0;
let sid = '';
const drive = vi.fn(async () => ({ kind: 'deferred', reason: 'session-busy' }));

beforeEach(() => {
  sid = `routing-${++n}`;
  h.rows.length = 0;
  h.queued.clear();
  h.raced.clear();
  h.provider = 'claude-code';
  h.providerInstance = undefined;
  h.ipcMain.removeAllListeners();
  vi.clearAllMocks();
});

const respondToForm = (promptId: string) => {
  registerSessionPromptResponseHandler();
  return h.handlers.get('messages:respond-to-prompt')!({ sender: { send: vi.fn() } }, {
    sessionId: sid,
    promptId,
    promptType: 'request_user_input_request',
    response: { answers: { ok: { type: 'confirm', value: true } } },
    respondedBy: 'desktop',
  });
};

const answerQuestion = (sendMessageHandler: () => unknown, questionId: string) => {
  registerAskUserQuestionAnswerHandler({ sendMessageHandler, publishQueueStateToSync: vi.fn(async () => {}), driveQueuedPrompts: drive } as any);
  return h.handlers.get('claude-code:answer-question')!({}, { questionId, answers: { Q: 'stale' }, sessionId: sid });
};

describe('an answer for a card with no live waiter', () => {
  it('closes its own form and leaves the live form and its turn alone', async () => {
    const liveForm = vi.fn();
    h.ipcMain.on(`request-user-input-response:${sid}:toolu_live`, vi.fn());
    h.ipcMain.on(`request-user-input-response:${sid}:__fallback__`, liveForm);
    noteLiveInteractivePrompt(sid);
    const resume = vi.fn(async () => undefined);
    configureRequestUserInputResume(resume);
    try {
      expect(await respondToForm('toolu_stale')).toMatchObject({ success: true });

      expect(liveForm).not.toHaveBeenCalled();
      expect(h.rows).toEqual([expect.objectContaining({ toolUseId: 'toolu_stale', result: expect.objectContaining({ cancelled: false }) })]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(resume).not.toHaveBeenCalled();
      // NIM-7649: the answer still reaches the agent, once the running turn ends.
      expect([...h.queued.values()]).toEqual([expect.objectContaining({
        sessionId: sid,
        prompt: expect.stringContaining('"ok"'),
        documentContext: { promptOrigin: 'interactive-question' },
      })]);
      expect(await respondToForm('toolu_stale')).toMatchObject({ success: false });
      expect(h.queued.size).toBe(1);
    } finally {
      clearLiveInteractivePrompt(sid);
    }
  });

  it('closes its own question and leaves the live question and its turn alone', async () => {
    const liveQuestion = vi.fn();
    h.ipcMain.on(`ask-user-question-response:${sid}:toolu_live`, vi.fn());
    h.ipcMain.on(`ask-user-question:${sid}`, liveQuestion);
    noteLiveInteractivePrompt(sid);
    const sendMessageHandler = vi.fn();
    try {
      expect(await answerQuestion(sendMessageHandler, 'toolu_stale')).toEqual({ success: true });

      expect(liveQuestion).not.toHaveBeenCalled();
      expect(h.rows).toEqual([expect.objectContaining({ toolUseId: 'toolu_stale' })]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(sendMessageHandler).not.toHaveBeenCalled();
      // NIM-7649: queued instead of dropped.
      expect([...h.queued.values()]).toEqual([expect.objectContaining({
        sessionId: sid,
        prompt: '[Resuming after answering a question]\n\nQ: stale',
        documentContext: { promptOrigin: 'interactive-question' },
      })]);
    } finally {
      clearLiveInteractivePrompt(sid);
    }
  });

  it('still reaches a fallback waiter on a provider whose waiter ids do not match its cards', async () => {
    h.provider = 'opencode';
    const waiter = vi.fn();
    h.ipcMain.on(`request-user-input-response:${sid}:__fallback__`, waiter);

    expect(await respondToForm('toolu_card')).toMatchObject({ success: true });

    expect(waiter).toHaveBeenCalledWith(null, expect.objectContaining({ promptId: 'toolu_card' }));
    expect(h.rows).toEqual([]);
  });
});

// 2026-11-07: an answer for a card left over from an earlier process arrived
// while the lead was mid-turn with no other card open. The auto-resume replaced
// the running turn, and Claude Code padded the cut-off turn with a synthetic
// "No response requested." reply that the agent took for its own.
describe('an answer with no live waiter while the lead turn is running', () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const endTurn = async () => {
    if (getSessionStateManager().getSessionState(sid)) await getSessionStateManager().endSession(sid);
  };

  it.each([
    ['the turn is running', async () => { await getSessionStateManager().startSession({ sessionId: sid, workspacePath: '/ws' }); }],
    ['the provider is about to start its own turn', async () => { h.providerInstance = { isLeadBusy: () => true }; }],
  ])('queues a question answer instead of resuming when %s', async (_label, arrange) => {
    await arrange();
    const sendMessageHandler = vi.fn();
    try {
      expect(await answerQuestion(sendMessageHandler, 'toolu_old')).toEqual({ success: true });
      await settle();

      expect(sendMessageHandler).not.toHaveBeenCalled();
      expect([...h.queued.values()]).toEqual([expect.objectContaining({
        sessionId: sid,
        prompt: '[Resuming after answering a question]\n\nQ: stale',
        documentContext: { promptOrigin: 'interactive-question' },
      })]);
      // The turn may end before the row exists; the drive covers that.
      expect(drive).toHaveBeenCalledWith(sid, '/ws', 'session-idle');
    } finally {
      await endTurn();
    }
  });

  it('queues a form answer instead of resuming while the turn is running', async () => {
    await getSessionStateManager().startSession({ sessionId: sid, workspacePath: '/ws' });
    const resume = vi.fn(async () => undefined);
    configureRequestUserInputResume(resume, vi.fn(async () => {}), drive);
    try {
      expect(await respondToForm('toolu_old')).toMatchObject({ success: true });
      await settle();

      expect(resume).not.toHaveBeenCalled();
      expect([...h.queued.values()]).toEqual([expect.objectContaining({ sessionId: sid, prompt: expect.stringContaining('"ok"') })]);
      expect(drive).toHaveBeenCalledWith(sid, '/ws');
    } finally {
      await endTurn();
    }
  });

  it('still resumes at once when nothing is running', async () => {
    const sendMessageHandler = vi.fn(async () => undefined);

    expect(await answerQuestion(sendMessageHandler, 'toolu_old')).toEqual({ success: true });
    await settle();

    expect(sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(h.queued.size).toBe(0);
  });
});

// An hour-long turn would otherwise work on without the answer until it ends.
// The runtime's PostToolBatch hook hands it to the turn at its next tool boundary.
describe('a queued answer reaching the running turn at its next tool boundary', () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const status = () => Object.fromEntries([...h.queued.values()].map((row) => [row.id, row.status]));

  it.each([
    ['question', () => answerQuestion(vi.fn(), 'toolu_old'), 'Q: stale'],
    ['form', () => { configureRequestUserInputResume(vi.fn(), vi.fn(async () => {}), drive); return respondToForm('toolu_old'); }, '"ok"'],
  ])('hands over a %s answer once, completing it only after delivery', async (_label, answer, text) => {
    await getSessionStateManager().startSession({ sessionId: sid, workspacePath: '/ws' });
    try {
      await answer();
      await settle();
      const [id] = Object.keys(status());
      const claimed = vi.fn();

      const batch = await takeLateAnswersForRunningTurn(sid, claimed);

      expect(batch?.text.startsWith(`${LATE_ANSWER_PREAMBLE}\n\n`)).toBe(true);
      expect(batch?.text).toContain(text);
      expect(batch?.text).not.toContain('[Resuming after');
      // Claimed, so the turn-end dispatch cannot take it meanwhile.
      expect(status()).toEqual({ [id]: 'executing' });
      expect(claimed).not.toHaveBeenCalled();

      await batch!.settle(true);
      expect(status()).toEqual({ [id]: 'completed' });
      expect(claimed).toHaveBeenCalledWith(id);
      expect(await takeLateAnswersForRunningTurn(sid)).toBeNull();
    } finally {
      await getSessionStateManager().endSession(sid);
    }
  });

  it('puts an answer that did not reach the turn back in the queue for the turn end', async () => {
    h.queued.set('answer-a', { id: 'answer-a', sessionId: sid, prompt: 'Q: a', documentContext: { promptOrigin: 'interactive-question' }, status: 'pending' });
    const claimed = vi.fn();

    await (await takeLateAnswersForRunningTurn(sid, claimed))!.settle(false);

    expect([...h.queued.values()]).toEqual([expect.objectContaining({
      id: 'answer-a', prompt: 'Q: a', documentContext: { promptOrigin: 'interactive-question' }, status: 'pending',
    })]);
    expect(claimed).not.toHaveBeenCalled();
  });

  it('leaves the user\'s own queued prompts, and an answer the turn-end dispatch claims first', async () => {
    h.queued.set('user-1', { id: 'user-1', sessionId: sid, prompt: 'next task', status: 'pending' });
    h.queued.set('answer-raced', { id: 'answer-raced', sessionId: sid, prompt: 'Q: a', status: 'pending' });
    h.raced.add('answer-raced');

    expect(await takeLateAnswersForRunningTurn(sid)).toBeNull();
    expect(status()).toEqual({ 'user-1': 'pending', 'answer-raced': 'executing' });
  });
});

// Round 2: Cancel had the same cross-card fallback. On a dead MCP card it either
// did nothing (another question's listener swallowed it, the reservation was
// spent, and the card could neither close nor be answered) or aborted whatever
// turn was running, background subagents included.
describe('Cancel on a card with no live waiter', () => {
  const cancel = (questionId: string) => {
    registerInteractivePromptHandlers({ sendMessageHandler: vi.fn(), driveQueuedPrompts: vi.fn(), publishQueueStateToSync: vi.fn() } as any);
    return h.handlers.get('claude-code:cancel-question')!({}, { questionId, sessionId: sid });
  };

  it.each([
    ['another question is live', true],
    ['nothing else is live', false],
  ])('closes its own card and never aborts the turn when %s', async (_label, otherLive) => {
    const provider = { rejectAskUserQuestion: vi.fn(), abort: vi.fn() };
    h.providerInstance = provider;
    const liveQuestion = vi.fn();
    if (otherLive) {
      h.ipcMain.on(`ask-user-question-response:${sid}:toolu_live`, vi.fn());
      h.ipcMain.on(`ask-user-question:${sid}`, liveQuestion);
      noteLiveInteractivePrompt(sid);
    }
    try {
      expect(await cancel('toolu_stale')).toMatchObject({ success: true });

      expect(liveQuestion).not.toHaveBeenCalled();
      expect(provider.abort).not.toHaveBeenCalled();
      expect(h.rows).toEqual([expect.objectContaining({ toolUseId: 'toolu_stale', result: expect.objectContaining({ cancelled: true }) })]);
      // The live question still owns the session's pending-prompt bit.
      expect(vi.mocked(setSessionPendingPrompt).mock.calls.some(([id, on]) => id === sid && on === false)).toBe(!otherLive);
    } finally {
      if (otherLive) clearLiveInteractivePrompt(sid);
    }
  });

  it('still rejects a question the provider holds and stops its turn', async () => {
    const provider = { rejectAskUserQuestion: vi.fn(), abort: vi.fn() };
    h.providerInstance = provider;
    openPrompt(sid, 'toolu_sdk', 'decision');

    expect(await cancel('toolu_sdk')).toEqual({ success: true });

    expect(provider.rejectAskUserQuestion).toHaveBeenCalledWith('toolu_sdk', expect.any(Error));
    expect(provider.abort).toHaveBeenCalledTimes(1);
    // The provider logs this card's cancelled result itself.
    expect(h.rows).toEqual([]);
  });

  it('keeps the turn running when the provider answers the cancel as a dismissal', async () => {
    // A CLI advertising ask_user_question_unanswered_v1 takes the dismissal as
    // an answer, so the model reads it and continues; aborting would discard it.
    const provider = { rejectAskUserQuestion: vi.fn().mockReturnValue('dismissed'), abort: vi.fn() };
    h.providerInstance = provider;
    openPrompt(sid, 'toolu_sdk_dismiss', 'decision');

    expect(await cancel('toolu_sdk_dismiss')).toEqual({ success: true });

    expect(provider.rejectAskUserQuestion).toHaveBeenCalledWith('toolu_sdk_dismiss', expect.any(Error));
    expect(provider.abort).not.toHaveBeenCalled();
  });
});
