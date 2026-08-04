// @vitest-environment node
/**
 * Issue #1116 / #773 — an AskUserQuestion answered when NO live handler remains
 * (provider gone, no MCP waiter) must still terminalize the tool call.
 *
 * Before the fix the fallback wrote only an `ask_user_question_response` row,
 * which no transcript parser projects, so `toolCall.result` stayed empty: the
 * widget looked answered via component-local state but reverted to pending on
 * every remount, and each re-click auto-resumed the session again.
 *
 * These assertions pin the durable row to the exact payload the widget's
 * completed/cancelled branches consume (see the AskUserQuestionWidget cases in
 * runtime's TranscriptWidgets.test.tsx).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const createdRows: Array<{ content: string }> = [];
vi.mock('@nimbalyst/runtime', () => ({
  AgentMessagesRepository: {
    create: vi.fn(async (row: { content: string }) => {
      createdRows.push(row);
      return undefined;
    }),
  },
  AISessionsRepository: { get: vi.fn(async () => ({ provider: 'claude-code' })) },
}));

import {
  hasTerminalizedAskUserQuestion,
  persistAskUserQuestionTerminalResult,
  clearTerminalizedAskUserQuestions,
} from '../askUserQuestionFallbackResolution';

function lastToolResult(toolUseId: string) {
  const rows = createdRows
    .map((r) => JSON.parse(r.content))
    .filter((p) => p?.type === 'nimbalyst_tool_result' && p?.tool_use_id === toolUseId);
  return rows[rows.length - 1];
}

beforeEach(() => {
  createdRows.length = 0;
});

describe('AskUserQuestion fallback terminal result', () => {
  it('writes the answered tool_result the widget renders as completed, and blocks a repeat answer', async () => {
    const sessionId = 'session-answer';
    const questionId = 'toolu_q1';
    clearTerminalizedAskUserQuestions(sessionId);

    expect(hasTerminalizedAskUserQuestion(sessionId, questionId)).toBe(false);

    await persistAskUserQuestionTerminalResult({
      sessionId,
      questionId,
      answers: { 'Which framework?': 'React' },
      cancelled: false,
    });

    const row = lastToolResult(questionId);
    expect(row.is_error).toBe(false);
    // The widget parses `result` (a JSON string) and reads `.answers`.
    expect(JSON.parse(row.result).answers).toEqual({ 'Which framework?': 'React' });

    // The repeat-resume loop in #773: a second answer for the same question must
    // be refused instead of auto-resuming the session again.
    expect(hasTerminalizedAskUserQuestion(sessionId, questionId)).toBe(true);
    expect(hasTerminalizedAskUserQuestion(sessionId, 'toolu_other')).toBe(false);
    expect(hasTerminalizedAskUserQuestion('other-session', questionId)).toBe(false);
  });

  it('writes a cancelled tool_result so a cancelled widget cannot resurrect', async () => {
    const sessionId = 'session-cancel';
    const questionId = 'toolu_q2';
    clearTerminalizedAskUserQuestions(sessionId);

    await persistAskUserQuestionTerminalResult({
      sessionId,
      questionId,
      answers: {},
      cancelled: true,
    });

    const row = lastToolResult(questionId);
    expect(row.is_error).toBe(true);
    expect(JSON.parse(row.result).cancelled).toBe(true);
  });
});
