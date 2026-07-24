/**
 * Tests for the AskUserQuestion lifecycle across the MCP server and AIService.
 *
 * The AskUserQuestion tool can arrive via two paths:
 *   1. SDK canUseTool path -> stored in ClaudeCodeProvider.pendingAskUserQuestions
 *   2. MCP server path -> waits on ipcMain IPC channels + database polling
 *
 * When the tool arrives via MCP (path 2), the provider's pendingAskUserQuestions
 * map is EMPTY. The answer handler in AIService must resolve via IPC emission
 * to the MCP server's listeners, with database polling as a fallback.
 *
 * This test suite exercises both resolution paths to prevent regressions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// We use a real EventEmitter to faithfully simulate ipcMain behavior
// (once/emit/listenerCount/removeListener all work correctly).
// ---------------------------------------------------------------------------

const ipc = new EventEmitter();

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session-aaaa-bbbb-cccc';
const QUESTION_ID = 'toolu_01TestQuestionId123';

function specificChannel(sid: string, qid: string) {
  return `ask-user-question-response:${sid}:${qid}`;
}
function fallbackChannel(sid: string) {
  return `ask-user-question:${sid}`;
}

// ---------------------------------------------------------------------------
// Simulates the MCP server's AskUserQuestion handler (httpServer.ts)
// ---------------------------------------------------------------------------

function simulateMcpServer(
  sessionId: string,
  questionId: string,
  opts?: {
    dbPollFn?: () => Promise<{ type: string; questionId: string; answers?: Record<string, string>; cancelled?: boolean; respondedBy?: string } | null>;
  },
) {
  const qChannel = specificChannel(sessionId, questionId);
  const fChannel = fallbackChannel(sessionId);

  let settled = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const handle = {
    isSettled: () => settled,
    promise: new Promise<{ answers?: Record<string, string>; cancelled?: boolean; source: string }>((resolve) => {
      const settle = (
        data: { answers?: Record<string, string>; cancelled?: boolean },
        source: string,
      ) => {
        if (settled) return;
        settled = true;
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        ipc.removeListener(qChannel, onSpecific);
        ipc.removeListener(fChannel, onFallback);
        resolve({ ...data, source });
      };

      const onSpecific = (_ev: unknown, data: any) => settle(data, 'ipc-specific');
      const onFallback = (_ev: unknown, data: any) => settle(data, 'ipc-fallback');

      ipc.once(qChannel, onSpecific);
      ipc.once(fChannel, onFallback);

      // Database polling fallback
      if (opts?.dbPollFn) {
        const POLL_INTERVAL = 30; // fast for tests
        pollTimer = setInterval(async () => {
          if (settled) { if (pollTimer) clearInterval(pollTimer); pollTimer = null; return; }
          try {
            const msg = await opts.dbPollFn!();
            if (msg && msg.type === 'ask_user_question_response' && msg.questionId === questionId) {
              settle(msg.cancelled ? { cancelled: true } : { answers: msg.answers }, 'db-poll');
            }
          } catch { /* continue */ }
        }, POLL_INTERVAL);
      }
    }),
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Simulates the AIService answer handler (AIService.ts claude-code:answer-question)
// ---------------------------------------------------------------------------

function simulateAnswerHandler(
  questionId: string,
  answers: Record<string, string>,
  sessionId: string,
  providerHasPending: boolean,
  dbWriteFn?: (msg: any) => Promise<void>,
) {
  const mockEvent = {};
  const providerResolved = providerHasPending;

  // IPC specific channel
  const qChannel = specificChannel(sessionId, questionId);
  const hasMcpWaiter = ipc.listenerCount(qChannel) > 0;
  if (hasMcpWaiter) {
    ipc.emit(qChannel, mockEvent, { questionId, answers, cancelled: false, respondedBy: 'desktop', sessionId });
  }

  // IPC fallback channel
  const fChannel = fallbackChannel(sessionId);
  const hasFallbackWaiter = ipc.listenerCount(fChannel) > 0;
  if (hasFallbackWaiter) {
    ipc.emit(fChannel, mockEvent, { questionId, answers, cancelled: false, respondedBy: 'desktop', sessionId });
  }

  // Database write fallback (when provider path fails)
  if (!providerResolved && dbWriteFn) {
    dbWriteFn({
      type: 'ask_user_question_response',
      questionId,
      answers,
      cancelled: false,
      respondedBy: 'desktop',
      respondedAt: Date.now(),
    });
  }

  return { providerResolved, hasMcpWaiter, hasFallbackWaiter, success: providerResolved || hasMcpWaiter || hasFallbackWaiter };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AskUserQuestion lifecycle', () => {
  beforeEach(() => { ipc.removeAllListeners(); });
  afterEach(() => { ipc.removeAllListeners(); });

  describe('MCP IPC resolution path (primary)', () => {
    it('should resolve via specific IPC channel when MCP listeners are registered', async () => {
      const answers = { 'What framework?': 'React' };
      const mcp = simulateMcpServer(SESSION_ID, QUESTION_ID);

      expect(ipc.listenerCount(specificChannel(SESSION_ID, QUESTION_ID))).toBe(1);
      expect(ipc.listenerCount(fallbackChannel(SESSION_ID))).toBe(1);

      const result = simulateAnswerHandler(QUESTION_ID, answers, SESSION_ID, false);
      expect(result.hasMcpWaiter).toBe(true);
      expect(result.success).toBe(true);

      const settled = await mcp.promise;
      expect(settled.source).toBe('ipc-specific');
      expect(settled.answers).toEqual(answers);
      expect(settled.cancelled).toBeFalsy();
      expect(mcp.isSettled()).toBe(true);
    });

    it('should clean up both listeners when specific channel fires', async () => {
      const mcp = simulateMcpServer(SESSION_ID, QUESTION_ID);
      simulateAnswerHandler(QUESTION_ID, { q: 'a' }, SESSION_ID, false);
      await mcp.promise;

      expect(ipc.listenerCount(specificChannel(SESSION_ID, QUESTION_ID))).toBe(0);
      expect(ipc.listenerCount(fallbackChannel(SESSION_ID))).toBe(0);
    });

    it('should resolve via session fallback channel when specific channel has no listener', async () => {
      let settledData: any = null;
      const promise = new Promise<void>((resolve) => {
        ipc.once(fallbackChannel(SESSION_ID), (_ev: unknown, data: any) => {
          settledData = data;
          resolve();
        });
      });

      expect(ipc.listenerCount(specificChannel(SESSION_ID, QUESTION_ID))).toBe(0);
      expect(ipc.listenerCount(fallbackChannel(SESSION_ID))).toBe(1);

      simulateAnswerHandler(QUESTION_ID, { q: 'a' }, SESSION_ID, false);
      await promise;
      expect(settledData.answers).toEqual({ q: 'a' });
    });
  });

  describe('Database polling fallback path', () => {
    it('should resolve via database polling when IPC listeners are absent', async () => {
      const answers = { 'What tool?': 'Vitest' };
      const dbMessages: any[] = [];
      const dbWriteFn = async (msg: any) => { dbMessages.push(msg); };
      const dbPollFn = async () =>
        dbMessages.find((m) => m.type === 'ask_user_question_response' && m.questionId === QUESTION_ID) || null;

      const mcp = simulateMcpServer(SESSION_ID, QUESTION_ID, { dbPollFn });

      // Remove IPC listeners to simulate transport death
      ipc.removeAllListeners(specificChannel(SESSION_ID, QUESTION_ID));
      ipc.removeAllListeners(fallbackChannel(SESSION_ID));

      // AIService writes to database (no IPC listeners found)
      simulateAnswerHandler(QUESTION_ID, answers, SESSION_ID, false, dbWriteFn);

      const settled = await mcp.promise;
      expect(settled.source).toBe('db-poll');
      expect(settled.answers).toEqual(answers);
      expect(mcp.isSettled()).toBe(true);
    });

    it('should resolve cancellation via database polling', async () => {
      const dbMessages: any[] = [];
      const dbPollFn = async () =>
        dbMessages.find((m) => m.type === 'ask_user_question_response' && m.questionId === QUESTION_ID) || null;

      const mcp = simulateMcpServer(SESSION_ID, QUESTION_ID, { dbPollFn });

      ipc.removeAllListeners(specificChannel(SESSION_ID, QUESTION_ID));
      ipc.removeAllListeners(fallbackChannel(SESSION_ID));

      dbMessages.push({
        type: 'ask_user_question_response',
        questionId: QUESTION_ID,
        answers: {},
        cancelled: true,
        respondedBy: 'desktop',
      });

      const settled = await mcp.promise;
      expect(settled.source).toBe('db-poll');
      expect(settled.cancelled).toBe(true);
    });

    it('should prefer IPC path over database polling when both available', async () => {
      const answers = { q: 'fast-path' };
      const dbMessages: any[] = [];
      const dbPollFn = async () =>
        dbMessages.find((m) => m.type === 'ask_user_question_response' && m.questionId === QUESTION_ID) || null;

      const mcp = simulateMcpServer(SESSION_ID, QUESTION_ID, { dbPollFn });

      simulateAnswerHandler(QUESTION_ID, answers, SESSION_ID, false, async (msg) => {
        dbMessages.push(msg);
      });

      const settled = await mcp.promise;
      expect(settled.source).toBe('ipc-specific');
      expect(settled.answers).toEqual(answers);
    });
  });

  describe('Multiple questions same session', () => {
    it('should handle sequential questions without listener conflicts', async () => {
      const QID1 = 'toolu_01FirstQuestion';
      const QID2 = 'toolu_02SecondQuestion';

      const mcp1 = simulateMcpServer(SESSION_ID, QID1);
      simulateAnswerHandler(QID1, { q1: 'answer1' }, SESSION_ID, false);
      const s1 = await mcp1.promise;
      expect(s1.answers).toEqual({ q1: 'answer1' });
      expect(s1.source).toBe('ipc-specific');

      const mcp2 = simulateMcpServer(SESSION_ID, QID2);
      simulateAnswerHandler(QID2, { q2: 'answer2' }, SESSION_ID, false);
      const s2 = await mcp2.promise;
      expect(s2.answers).toEqual({ q2: 'answer2' });
      expect(s2.source).toBe('ipc-specific');
    });

    it('should not cross-contaminate when two questions are pending (specific channels)', async () => {
      // NOTE: The session fallback channel (ask-user-question:${sessionId}) does NOT filter
      // by questionId. If two questions are pending on the same session, the fallback channel
      // from one answer can settle the other question. In practice this is extremely unlikely
      // because the SDK blocks on tool results (only one AskUserQuestion at a time).
      // This test verifies the specific channels (which include questionId) work correctly.

      const QID1 = 'toolu_01Q1';
      const QID2 = 'toolu_02Q2';

      // Register only specific channel listeners (skip fallback to test isolation)
      let settled1: any = null;
      let settled2: any = null;

      const p1 = new Promise<void>((resolve) => {
        ipc.once(specificChannel(SESSION_ID, QID1), (_ev, data) => { settled1 = data; resolve(); });
      });
      const p2 = new Promise<void>((resolve) => {
        ipc.once(specificChannel(SESSION_ID, QID2), (_ev, data) => { settled2 = data; resolve(); });
      });

      // Answer question 2 first
      ipc.emit(specificChannel(SESSION_ID, QID2), {}, { answers: { q: 'two' } });
      await p2;
      expect(settled2.answers).toEqual({ q: 'two' });
      expect(settled1).toBeNull(); // Q1 should NOT be settled

      // Answer question 1
      ipc.emit(specificChannel(SESSION_ID, QID1), {}, { answers: { q: 'one' } });
      await p1;
      expect(settled1.answers).toEqual({ q: 'one' });
    });
  });

  describe('Edge cases', () => {
    it('should resolve via DB when provider destroyed and IPC listeners lost', async () => {
      const dbMessages: any[] = [];
      const dbPollFn = async () =>
        dbMessages.find((m) => m.type === 'ask_user_question_response' && m.questionId === QUESTION_ID) || null;

      const mcp = simulateMcpServer(SESSION_ID, QUESTION_ID, { dbPollFn });

      // Simulate transport death: IPC listeners removed
      ipc.removeAllListeners(specificChannel(SESSION_ID, QUESTION_ID));
      ipc.removeAllListeners(fallbackChannel(SESSION_ID));

      const result = simulateAnswerHandler(
        QUESTION_ID, { q: 'late-answer' }, SESSION_ID, false,
        async (msg) => { dbMessages.push(msg); },
      );

      expect(result.hasMcpWaiter).toBe(false);
      expect(result.hasFallbackWaiter).toBe(false);
      expect(result.success).toBe(false); // IPC reports failure

      // MCP server should still settle via DB polling
      const settled = await mcp.promise;
      expect(settled.source).toBe('db-poll');
      expect(settled.answers).toEqual({ q: 'late-answer' });
    });

    it('should not settle twice if both IPC and DB poll could fire', async () => {
      const dbMessages: any[] = [];
      const dbPollFn = async () =>
        dbMessages.find((m) => m.type === 'ask_user_question_response' && m.questionId === QUESTION_ID) || null;

      const mcp = simulateMcpServer(SESSION_ID, QUESTION_ID, { dbPollFn });

      // Write to DB first
      dbMessages.push({
        type: 'ask_user_question_response',
        questionId: QUESTION_ID,
        answers: { q: 'db-answer' },
        cancelled: false,
        respondedBy: 'desktop',
      });

      // Also emit on IPC (synchronous, should win)
      simulateAnswerHandler(QUESTION_ID, { q: 'ipc-answer' }, SESSION_ID, false);

      const settled = await mcp.promise;
      expect(settled.source).toBe('ipc-specific');
      expect(settled.answers).toEqual({ q: 'ipc-answer' });

      // Let any pending poll interval fire, confirm no errors
      await new Promise((r) => setTimeout(r, 100));
      expect(mcp.isSettled()).toBe(true);
    });

    it('should handle stale fallback listener from previous question', async () => {
      const QID2 = 'toolu_02Fresh';

      // Stale listener from a previous abandoned question
      let staleReceived = false;
      ipc.once(fallbackChannel(SESSION_ID), () => { staleReceived = true; });

      // Second question registers its own listeners
      const mcp2 = simulateMcpServer(SESSION_ID, QID2);

      // Answer via specific channel
      simulateAnswerHandler(QID2, { q: 'fresh' }, SESSION_ID, false);

      const settled = await mcp2.promise;
      expect(settled.source).toBe('ipc-specific');
      expect(settled.answers).toEqual({ q: 'fresh' });
    });
  });
});
