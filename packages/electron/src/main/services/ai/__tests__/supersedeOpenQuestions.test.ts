// @vitest-environment node
/**
 * NIM-7240: a human turn closes every question asked before it; nothing else
 * does. A stop with no new turn leaves the question answerable (#1116), which
 * the gate below protects by never firing for non-human sends.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  return {
    ipcMain: new EventEmitter(),
    rows: [] as Array<{ sessionId: string; toolUseId: string; result: any; source?: string }>,
    messages: [] as unknown[],
    receipts: new Set<string>(),
    reservations: new Map<string, unknown>(),
    handlers: new Map<string, (...args: any[]) => any>(),
  };
});

vi.mock('electron', () => ({ ipcMain: h.ipcMain }));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../../utils/transcriptHelpers', () => ({
  loadViewMessages: vi.fn(async () => ({ success: true, messages: h.messages })),
}));
vi.mock('../../RepositoryManager', () => ({
  getQueuedPromptsStore: () => ({ get: async (id: string) => (h.receipts.has(id) ? { id, status: 'pending' } : null) }),
}));
vi.mock('../../../mcp/tools/interactivePromptTranscript', async () => {
  const seen = await import('../claudeCliToolResultSeen');
  return {
    buildInteractivePromptToolResultContent: (a: { toolUseId: string; result: unknown }) =>
      JSON.stringify({ type: 'nimbalyst_tool_result', tool_use_id: a.toolUseId, result: JSON.stringify(a.result) }),
    persistInteractivePromptToolResult: vi.fn(async (a: { sessionId: string; toolUseId: string; result: any; source?: string }) => {
      seen.markToolResultPersisted(a.sessionId, a.toolUseId);
      h.rows.push(a);
    }),
  };
});
vi.mock('../pendingPromptPersistence', () => ({ setSessionPendingPrompt: vi.fn(async () => {}) }));
vi.mock('../../../utils/privateSettingsStore', () => ({
  default: class {
    get(key: string) { return h.reservations.get(key); }
    set(key: string, value: unknown) { h.reservations.set(key, value); }
  },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { create: vi.fn(async () => undefined), list: vi.fn(async () => []) },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: vi.fn(async () => ({ provider: 'claude-code', workspacePath: '/ws' })) },
}));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ProviderFactory: { getProvider: () => undefined },
  isAskUserQuestionProvider: () => false,
}));
vi.mock('../../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, fn: (...args: any[]) => any) => h.handlers.set(channel, fn),
}));
// The "database" holds whatever terminal rows the test wrote, and survives a
// simulated restart that drops the in-memory guards.
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({
  database: {
    query: vi.fn(async (_sql: string, [sessionId, needle]: [string, string]) => ({
      rows: h.rows
        .filter((r) => r.sessionId === sessionId)
        .map((r) => ({
          content: JSON.stringify({ type: 'nimbalyst_tool_result', tool_use_id: r.toolUseId, result: JSON.stringify(r.result) }),
        }))
        .filter((r) => r.content.includes(needle.slice(1, -1))),
    })),
  },
}));
// Module-load imports of the prompt-response handler; the closed-form refusal
// returns before any of them is used.
vi.mock('../CommitProposalExecution', () => ({ cancelCommitProposalOnce: vi.fn(), acceptsCommitProposalResponse: vi.fn() }));
vi.mock('../../SessionCommitService', () => ({ SessionCommitService: {} }));
vi.mock('@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository', () => ({
  TranscriptMigrationRepository: { hasService: () => false },
}));
vi.mock('../../../tray/TrayManager', () => ({ TrayManager: { getInstance: () => ({ onPromptResolved: vi.fn() }) } }));
vi.mock('../../../mcp/tools/codexToolCallResolver', () => ({
  resolveRequestUserInputPromptTargets: (id: string) => ({ promptId: id, waiterPromptIds: [id] }),
}));
vi.mock('../gitCommitProposalPromptUtils', () => ({
  getGitCommitProposalResponseChannel: vi.fn(),
  resolveGitCommitProposalPromptId: vi.fn(),
}));
vi.mock('../codexQuestionDelivery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../codexQuestionDelivery')>()),
  deliverCodexQuestionAnswer: vi.fn(async () => ({ success: true, delivery: 'already-answered' })),
  hasAnswer: vi.fn(async () => false),
}));

import {
  closeSupersededQuestions,
  snapshotQuestionsToSupersede,
  supersedeOpenQuestions,
  type TurnOriginContext,
} from '../supersedeOpenQuestions';
import { openPrompt } from '../openPromptRegistry';
import { registerSessionPromptResponseHandler } from '../../../ipc/sessionPromptResponseHandler';
import { setSessionPendingPrompt } from '../pendingPromptPersistence';
import { loadViewMessages } from '../../../utils/transcriptHelpers';
import { codexQuestionRecoveryId, deliverCodexQuestionAnswer } from '../codexQuestionDelivery';
import { registerAskUserQuestionAnswerHandler } from '../ipc/registerAskUserQuestionAnswerHandler';
import { markToolResultPersisted } from '../claudeCliToolResultSeen';
import { clearTerminalizedAskUserQuestions } from '../askUserQuestionFallbackResolution';
import { configureRequestUserInputResume } from '../requestUserInputOrphanedAnswer';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';

const HUMAN = { inputType: 'user' };
const user = { type: 'user_message' };
const question = (id: string, toolName = 'mcp__nimbalyst__AskUserQuestion') => ({
  type: 'tool_call',
  toolCall: { toolName, providerToolCallId: id },
});
let n = 0;
let sid = '';

beforeEach(() => {
  sid = `session-${++n}`;
  h.rows.length = 0;
  h.receipts.clear();
  h.ipcMain.removeAllListeners();
  vi.clearAllMocks();
});

describe('supersedeOpenQuestions', () => {
  it('closes an open question on a human turn and refuses a late answer', async () => {
    // Production shape: the new turn's user row is not persisted yet.
    h.messages = [user, question('toolu_q1')];

    const outcome = await supersedeOpenQuestions({ sessionId: sid, provider: 'claude-code', context: HUMAN });

    expect(outcome.superseded).toEqual(['toolu_q1']);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({
      toolUseId: 'toolu_q1',
      result: { answers: {}, cancelled: true, reason: 'superseded', respondedBy: 'desktop' },
    });
    expect(setSessionPendingPrompt).toHaveBeenCalledWith(sid, false);

    const sendMessageHandler = vi.fn();
    registerAskUserQuestionAnswerHandler({ sendMessageHandler } as any);
    const answer = h.handlers.get('claude-code:answer-question')!;
    const response = await answer({}, { questionId: 'toolu_q1', answers: { Q: 'A' }, sessionId: sid });
    expect(response.success).toBe(false);
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it('refuses a late answer after a restart from the durable terminal row', async () => {
    h.messages = [user, question('toolu_q1')];
    await supersedeOpenQuestions({ sessionId: sid, provider: 'claude-code', context: HUMAN });
    // Restart: the in-memory terminalized set and the reservation store are gone.
    clearTerminalizedAskUserQuestions(sid);
    h.reservations.clear();

    const sendMessageHandler = vi.fn();
    registerAskUserQuestionAnswerHandler({ sendMessageHandler } as any);
    const answer = h.handlers.get('claude-code:answer-question')!;

    const late = await answer({}, { questionId: 'toolu_q1', answers: { Q: 'A' }, sessionId: sid });
    expect(late).toEqual({ success: false, error: 'Question already answered' });
    // A question with no terminal row still takes the #1116 resume path.
    const open = await answer({}, { questionId: 'toolu_q2', answers: { Q: 'A' }, sessionId: sid });
    expect(open).toEqual({ success: true });
  });

  it('lets a live CLI waiter write the only terminal row', async () => {
    h.messages = [user, question('toolu_live')];
    const payloads: unknown[] = [];
    h.ipcMain.once(`ask-user-question-response:${sid}:toolu_live`, (_e: unknown, payload: any) => {
      payloads.push(payload);
      markToolResultPersisted(sid, 'toolu_live');
      h.rows.push({ sessionId: sid, toolUseId: 'toolu_live', result: payload });
    });

    await supersedeOpenQuestions({ sessionId: sid, provider: 'claude-code-cli', context: HUMAN });

    expect(payloads).toEqual([expect.objectContaining({ cancelled: true, reason: 'superseded' })]);
    expect(h.rows).toHaveLength(1);
  });

  it.each<[string, TurnOriginContext | undefined]>([
    ['answer auto-resume', { promptOrigin: 'interactive-question' }],
    ['agent send_prompt', { inputType: 'user', promptProvenance: { actor: 'agent', origin: 'session-orchestration' } }],
    ['system wakeup', { promptOrigin: 'wakeup_resume', promptProvenance: { actor: 'system', origin: 'automation' } }],
    ['queued send without provenance', { inputType: 'user', queuedPromptId: 'q-1' }],
    ['no context', undefined],
  ])('supersedes nothing for %s', async (_label, context) => {
    h.messages = [user, question('toolu_q1')];

    const outcome = await supersedeOpenQuestions({ sessionId: sid, provider: 'claude-code', context });

    expect(outcome.superseded).toEqual([]);
    expect(loadViewMessages).not.toHaveBeenCalled();
    expect(h.rows).toHaveLength(0);
  });

  it('closes only what the pre-turn snapshot saw', async () => {
    // Every unanswered question before the new turn closes, on either side of
    // the last persisted user message.
    h.messages = [question('toolu_old', 'PromptForUserInput'), user, question('toolu_mid')];
    const snapshot = await snapshotQuestionsToSupersede({
      sessionId: sid,
      provider: 'claude-code-cli',
      context: { promptProvenance: { actor: 'human', origin: 'mobile' } },
    });
    // The CLI submit logs the new user row and the new turn asks again.
    h.messages = [...h.messages, user, question('toolu_new')];

    const outcome = await closeSupersededQuestions(snapshot);

    expect(outcome.superseded).toEqual(['toolu_old', 'toolu_mid']);
    expect(h.rows.map((r) => r.toolUseId)).toEqual(['toolu_old', 'toolu_mid']);
  });

  it('leaves an in-process question to the abort that owns it', async () => {
    h.messages = [user, question('toolu_sdk', 'AskUserQuestion')];
    openPrompt(sid, 'toolu_sdk', 'decision');

    const outcome = await supersedeOpenQuestions({ sessionId: sid, provider: 'claude-code', context: HUMAN });

    expect(outcome).toEqual({ superseded: [], skipped: ['toolu_sdk'] });
    expect(h.rows).toHaveLength(0);
  });

  it('never fails the send when the transcript read fails', async () => {
    vi.mocked(loadViewMessages).mockRejectedValueOnce(new Error('projection failed'));

    await expect(
      supersedeOpenQuestions({ sessionId: sid, provider: 'claude-code', context: HUMAN }),
    ).resolves.toEqual({ superseded: [], skipped: [] });
  });

  it('refuses an old form answer so it cannot settle a newer form through the fallback', async () => {
    h.messages = [user, question('form_old', 'mcp__nimbalyst__PromptForUserInput')];
    await supersedeOpenQuestions({ sessionId: sid, provider: 'claude-code', context: HUMAN });
    // Restart, then a newer form becomes the session's only waiter.
    clearTerminalizedAskUserQuestions(sid);
    const newForm = vi.fn();
    h.ipcMain.on(`request-user-input-response:${sid}:__fallback__`, newForm);

    registerSessionPromptResponseHandler();
    const respond = h.handlers.get('messages:respond-to-prompt')!;
    const result = await respond({ sender: { send: vi.fn() } }, {
      sessionId: sid,
      promptId: 'form_old',
      promptType: 'request_user_input_request',
      response: { answers: { name: 'old' } },
      respondedBy: 'mobile',
    });

    expect(result).toEqual({ success: false, error: 'This form is already closed.' });
    expect(newForm).not.toHaveBeenCalled();
  });

  // #1647: the form outlived its waiter (app restart, abandoned MCP call), so
  // the only way the answers reach the agent is a resumed turn carrying them.
  const respondToForm = (promptId: string, response: Record<string, unknown>) => {
    registerSessionPromptResponseHandler();
    return h.handlers.get('messages:respond-to-prompt')!({ sender: { send: vi.fn() } }, {
      sessionId: sid,
      promptId,
      promptType: 'request_user_input_request',
      response,
      respondedBy: 'desktop',
    });
  };

  it('resumes the session with a form answer that reaches no live waiter, exactly once', async () => {
    const resume = vi.fn(async () => undefined);
    configureRequestUserInputResume(resume);
    const answers = { notes: { type: 'editText', text: 'thirty minutes of typing', edited: true } };

    expect(await respondToForm('form_orphan', { answers })).toMatchObject({ success: true });

    expect(h.rows).toEqual([
      expect.objectContaining({ toolUseId: 'form_orphan', result: expect.objectContaining({ cancelled: false, answers }) }),
    ]);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: sid,
      workspacePath: '/ws',
      message: expect.stringContaining('thirty minutes of typing'),
    }));

    expect(await respondToForm('form_orphan', { answers })).toEqual({ success: false, error: 'This form is already closed.' });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a cancel', 'claude-code', { answers: {}, cancelled: true }, true],
    ['a claude-code-cli answer', 'claude-code-cli', { answers: { ok: { type: 'confirm', value: true } } }, false],
  ])('closes the form without resuming for %s', async (_label, provider, response, cancelled) => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue({ provider, workspacePath: '/ws' } as any);
    const resume = vi.fn(async () => undefined);
    configureRequestUserInputResume(resume);

    expect(await respondToForm('form_quiet', response)).toMatchObject({ success: true });

    expect(h.rows).toEqual([expect.objectContaining({ toolUseId: 'form_quiet', result: expect.objectContaining({ cancelled }) })]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(resume).not.toHaveBeenCalled();
    vi.mocked(AISessionsRepository.get).mockResolvedValue({ provider: 'claude-code', workspacePath: '/ws' } as any);
  });

  it('skips a Codex question whose answer recovery is already queued', async () => {
    const queued = 'nimtc|call_a|1000|0';
    const open = 'nimtc|call_b|2000|0';
    h.receipts.add(codexQuestionRecoveryId(sid, queued));
    h.messages = [user, question(queued), question(open)];

    const outcome = await supersedeOpenQuestions({ sessionId: sid, provider: 'openai-codex', context: HUMAN });

    expect(outcome).toEqual({ superseded: [open], skipped: [queued] });
    expect(deliverCodexQuestionAnswer).toHaveBeenCalledTimes(1);
    expect(deliverCodexQuestionAnswer).toHaveBeenCalledWith(
      sid,
      open,
      expect.objectContaining({ cancelled: true, reason: 'superseded' }),
    );
  });
});
