import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';

import {
  buildCodexToolLookupId,
  getCodexToolLookupAliases,
} from '@nimbalyst/runtime/ai/server/toolLookupIds';
import {
  clearPendingInteractiveWaiter,
  countPendingInteractiveWaiters,
  notePendingInteractiveWaiter,
  shouldSettleFromSessionFallback,
} from '../tools/interactivePromptFallback';

const ipc = new EventEmitter();

const SESSION_ID = 'test-session-aaaa-bbbb-cccc';
const RAW_PROMPT_ID = 'call_prompt_123';
const SYNTHETIC_PROMPT_ID = buildCodexToolLookupId(RAW_PROMPT_ID, 1234567890, 42);

function specificChannel(sessionId: string, promptId: string) {
  return `request-user-input-response:${sessionId}:${promptId}`;
}

function fallbackChannel(sessionId: string) {
  return `request-user-input-response:${sessionId}:__fallback__`;
}

function simulateMcpServer(
  sessionId: string,
  promptId: string,
  opts?: {
    dbPollFn?: () => Promise<{
      type: string;
      promptId?: string;
      rawPromptId?: string;
      answers?: Record<string, unknown>;
      cancelled?: boolean;
      respondedBy?: string;
    } | null>;
  },
) {
  const channel = specificChannel(sessionId, promptId);
  const sessionFallbackChannel = fallbackChannel(sessionId);
  let settled = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const promptIdAliases = new Set(getCodexToolLookupAliases(promptId));
  // Mirror the real handler: register this waiter so the sole-pending
  // session-fallback relaxation (NIM-1981) can apply.
  notePendingInteractiveWaiter(sessionId);

  return {
    isSettled: () => settled,
    promise: new Promise<{ answers?: Record<string, unknown>; cancelled?: boolean; source: string }>((resolve) => {
      const settle = (
        data: { answers?: Record<string, unknown>; cancelled?: boolean },
        source: string,
      ) => {
        if (settled) return;
        settled = true;
        clearPendingInteractiveWaiter(sessionId);
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        ipc.removeListener(channel, onResponse);
        ipc.removeListener(sessionFallbackChannel, onFallbackResponse);
        resolve({ ...data, source });
      };

      const onResponse = (_event: unknown, data: any) => settle(data, 'ipc');
      const onFallbackResponse = (_event: unknown, data: any) => {
        const responsePromptIds = [
          typeof data?.promptId === 'string' ? data.promptId : null,
          typeof data?.rawPromptId === 'string' ? data.rawPromptId : null,
        ].filter((value): value is string => !!value);
        if (
          !shouldSettleFromSessionFallback({
            waiterPromptId: promptId,
            promptIdAliasSet: promptIdAliases,
            responsePromptIds,
            pendingWaiterCountForSession: countPendingInteractiveWaiters(sessionId),
          })
        ) {
          return;
        }
        settle(data, 'ipc-fallback');
      };
      ipc.on(channel, onResponse);
      ipc.on(sessionFallbackChannel, onFallbackResponse);

      const dbPollFn = opts?.dbPollFn;
      if (dbPollFn) {
        pollTimer = setInterval(async () => {
          if (settled) {
            if (pollTimer) {
              clearInterval(pollTimer);
              pollTimer = null;
            }
            return;
          }

          try {
            const msg = await dbPollFn();
            if (!msg || msg.type !== 'request_user_input_response') return;
            const responsePromptIds = [
              typeof msg.promptId === 'string' ? msg.promptId : null,
              typeof msg.rawPromptId === 'string' ? msg.rawPromptId : null,
            ].filter((value): value is string => !!value);
            if (!responsePromptIds.some((id) => promptIdAliases.has(id))) return;

            if (msg.cancelled) {
              settle({ cancelled: true }, 'db-poll');
            } else {
              settle({ answers: msg.answers }, 'db-poll');
            }
          } catch {
            // keep polling
          }
        }, 30);
      }
    }),
  };
}

function simulateRendererResponse(
  sessionId: string,
  promptId: string,
  response: { answers?: Record<string, unknown>; cancelled?: boolean },
  opts?: { forceFallback?: boolean },
  dbWriteFn?: (msg: any) => Promise<void>,
) {
  const promptIdAliases = getCodexToolLookupAliases(promptId);
  const rawPromptId = promptIdAliases.find((id) => id !== promptId);
  let emittedSpecific = false;

  for (const promptIdAlias of promptIdAliases) {
    const channel = specificChannel(sessionId, promptIdAlias);
    if (!opts?.forceFallback && ipc.listenerCount(channel) > 0) {
      emittedSpecific = true;
      ipc.emit(channel, {}, {
        answers: response.answers,
        cancelled: response.cancelled === true,
        respondedBy: 'desktop',
      });
    }
  }

  if (!emittedSpecific) {
    const channel = fallbackChannel(sessionId);
    if (ipc.listenerCount(channel) > 0) {
      ipc.emit(channel, {}, {
        promptId,
        ...(rawPromptId ? { rawPromptId } : {}),
        answers: response.answers,
        cancelled: response.cancelled === true,
        respondedBy: 'desktop',
      });
    }
  }

  if (dbWriteFn) {
    dbWriteFn({
      type: 'request_user_input_response',
      promptId,
      ...(rawPromptId ? { rawPromptId } : {}),
      answers: response.answers ?? {},
      cancelled: response.cancelled === true,
      respondedBy: 'desktop',
    });
  }
}

describe('RequestUserInput lifecycle', () => {
  beforeEach(() => {
    ipc.removeAllListeners();
  });

  afterEach(() => {
    ipc.removeAllListeners();
    // Drain the module-level pending-waiter registry so unsettled waiters from
    // one test don't leak into the next (shared SESSION_ID).
    while (countPendingInteractiveWaiters(SESSION_ID) > 0) {
      clearPendingInteractiveWaiter(SESSION_ID);
    }
  });

  it('resolves via raw-item IPC channel when renderer responds with a synthetic Codex prompt id', async () => {
    const answers = { moveToComplete: { type: 'multiSelect', selectedIds: ['session-1'] } };
    const mcp = simulateMcpServer(SESSION_ID, RAW_PROMPT_ID);

    simulateRendererResponse(SESSION_ID, SYNTHETIC_PROMPT_ID, { answers });

    const settled = await mcp.promise;
    expect(settled.source).toBe('ipc');
    expect(settled.answers).toEqual(answers);
    expect(mcp.isSettled()).toBe(true);
  });

  it('resolves via database polling when persisted response stores synthetic and raw prompt ids', async () => {
    const answers = { moveToValidating: { type: 'multiSelect', selectedIds: ['session-2'] } };
    const dbMessages: any[] = [];
    const mcp = simulateMcpServer(SESSION_ID, RAW_PROMPT_ID, {
      dbPollFn: async () => dbMessages.find((msg) => msg.type === 'request_user_input_response') ?? null,
    });

    ipc.removeAllListeners();
    await simulateRendererResponse(SESSION_ID, SYNTHETIC_PROMPT_ID, { answers }, undefined, async (msg) => {
      dbMessages.push(msg);
    });

    const settled = await mcp.promise;
    expect(settled.source).toBe('db-poll');
    expect(settled.answers).toEqual(answers);
    expect(mcp.isSettled()).toBe(true);
  });

  it('resolves via session fallback IPC when the waiter id is unrelated to the response prompt id', async () => {
    const answers = { moveToComplete: { type: 'multiSelect', selectedIds: ['session-3'] } };
    const mcp = simulateMcpServer(SESSION_ID, 'rui-session-fallback');

    simulateRendererResponse(SESSION_ID, SYNTHETIC_PROMPT_ID, { answers }, { forceFallback: true });

    const settled = await mcp.promise;
    expect(settled.source).toBe('ipc-fallback');
    expect(settled.answers).toEqual(answers);
    expect(mcp.isSettled()).toBe(true);
  });

  // NIM-1981: Codex resolved a real-but-WRONG exec id for the waiter, so the
  // response's ids don't match the alias set. With a single pending prompt the
  // session fallback is unambiguous and must still resume the turn.
  it('resolves via session fallback when the waiter has a real-but-mismatched exec id and is the sole pending prompt', async () => {
    const answers = { field: { type: 'editText', text: 'accepted draft' } };
    const mcp = simulateMcpServer(SESSION_ID, 'exec-67e90371');

    simulateRendererResponse(
      SESSION_ID,
      buildCodexToolLookupId('exec-8cbfbb2c', 1784586037572, 43),
      { answers },
      { forceFallback: true },
    );

    const settled = await mcp.promise;
    expect(settled.source).toBe('ipc-fallback');
    expect(settled.answers).toEqual(answers);
    expect(mcp.isSettled()).toBe(true);
  });

  it('does NOT resolve on a mismatched session fallback when multiple prompts are pending in the session', async () => {
    // Two waiters pending for the same session -> the session-scoped fallback is
    // ambiguous, so a mismatched-id answer must not settle either waiter.
    const first = simulateMcpServer(SESSION_ID, 'exec-aaaa1111');
    const second = simulateMcpServer(SESSION_ID, 'exec-bbbb2222');

    simulateRendererResponse(
      SESSION_ID,
      buildCodexToolLookupId('exec-cccc3333', 1784586037572, 7),
      { answers: { field: { type: 'editText', text: 'x' } } },
      { forceFallback: true },
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(first.isSettled()).toBe(false);
    expect(second.isSettled()).toBe(false);
  });
});
