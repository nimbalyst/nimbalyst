import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';

import {
  buildCodexToolLookupId,
  getCodexToolLookupAliases,
} from '@nimbalyst/runtime/ai/server/toolLookupIds';

const ipc = new EventEmitter();

const SESSION_ID = 'test-session-aaaa-bbbb-cccc';
const RAW_PROMPT_ID = 'call_prompt_123';
const SYNTHETIC_PROMPT_ID = buildCodexToolLookupId(RAW_PROMPT_ID, 1234567890, 42);
const OTHER_RAW_PROMPT_ID = 'call_prompt_456';
const OTHER_SYNTHETIC_PROMPT_ID = buildCodexToolLookupId(OTHER_RAW_PROMPT_ID, 1234567891, 43);

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

  return {
    isSettled: () => settled,
    promise: new Promise<{ answers?: Record<string, unknown>; cancelled?: boolean; source: string }>((resolve) => {
      const settle = (
        data: { answers?: Record<string, unknown>; cancelled?: boolean },
        source: string,
      ) => {
        if (settled) return;
        settled = true;
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
          responsePromptIds.length === 0
          || !responsePromptIds.some((id) => promptIdAliases.has(id))
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

  it('resolves via session fallback IPC only when the response carries an exact prompt alias', async () => {
    const answers = { moveToComplete: { type: 'multiSelect', selectedIds: ['session-3'] } };
    const mcp = simulateMcpServer(SESSION_ID, RAW_PROMPT_ID);

    simulateRendererResponse(SESSION_ID, SYNTHETIC_PROMPT_ID, { answers }, { forceFallback: true });

    const settled = await mcp.promise;
    expect(settled.source).toBe('ipc-fallback');
    expect(settled.answers).toEqual(answers);
    expect(mcp.isSettled()).toBe(true);
  });

  it('does not let a fallback response for prompt B settle prompt A in the same session', async () => {
    const answers = { moveToComplete: { type: 'multiSelect', selectedIds: ['session-b'] } };
    const promptA = simulateMcpServer(SESSION_ID, RAW_PROMPT_ID);
    const promptB = simulateMcpServer(SESSION_ID, OTHER_RAW_PROMPT_ID);

    simulateRendererResponse(SESSION_ID, OTHER_SYNTHETIC_PROMPT_ID, { answers }, { forceFallback: true });

    const settledB = await promptB.promise;
    expect(settledB.source).toBe('ipc-fallback');
    expect(settledB.answers).toEqual(answers);
    expect(promptB.isSettled()).toBe(true);
    expect(promptA.isSettled()).toBe(false);
  });
});
