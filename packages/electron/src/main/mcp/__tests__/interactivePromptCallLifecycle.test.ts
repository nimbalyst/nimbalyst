// @vitest-environment node
//
// NIM-2607 / #1341: a blocking prompt whose MCP call the client abandons used
// to leave the waiter pending forever -- the "awaiting input" bit stuck on, the
// timers and listeners leaked, and the widget kept offering buttons whose
// answer had nowhere to go.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ipcMain } from 'electron';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { handleAskUserQuestion } from '../tools/askUserQuestionHandler';
import { countLiveInteractivePrompts } from '../tools/interactivePromptLiveness';

import { attachInteractivePromptCall } from '../tools/interactivePromptKeepalive';
import { settleReasonFromResponse, shouldTerminalizePrompt } from '../tools/interactivePromptAbandonment';

const seams = vi.hoisted(() => ({ persistResult: vi.fn(), pending: vi.fn(), activity: vi.fn() }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { ipcMain: new EventEmitter(), BrowserWindow: { getAllWindows: () => [] } };
});
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({ AgentMessagesRepository: { listTail: async () => [] } }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: async () => ({ provider: 'claude-code-cli' }) } }));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({ getSessionStateManager: () => ({ updateActivity: async (...args: unknown[]) => { seams.activity(...args); }, isSessionActive: () => true }) }));
vi.mock('../../services/ai/pendingPromptPersistence', () => ({ setSessionPendingPrompt: async (...args: unknown[]) => { seams.pending(...args); } }));
vi.mock('../tools/interactivePromptTranscript', () => ({ isClaudeCliSession: async () => true, persistInteractivePromptToolResult: seams.persistResult }));
vi.mock('../tools/codexToolCallResolver', () => ({ resolveToolUseIdFromMcpRequest: async (req: { params: { _meta: { toolUseId: string } } }) => req.params._meta.toolUseId }));

describe('shouldTerminalizePrompt', () => {
  // A question in an old, dead session stays answerable: answering it persists
  // the answer and resumes the session with it as a new turn (#1116). That
  // fallback only runs when no live waiter is found, so an abandoned call must
  // tear its waiter down WITHOUT closing the widget out.
  it('leaves an abandoned question answerable so the answer can resume the session', () => {
    expect(shouldTerminalizePrompt({ kind: 'ask_user_question', reason: 'client-abandoned' })).toBe(false);
    expect(shouldTerminalizePrompt({ kind: 'request_user_input', reason: 'client-abandoned' })).toBe(false);
    expect(shouldTerminalizePrompt({ kind: 'git_commit_proposal', reason: 'client-abandoned' })).toBe(false);
  });

  it('fails closed on an abandoned permission request', () => {
    // NIM-2607: no resume story for an approval, and a stale Allow answers nobody.
    expect(shouldTerminalizePrompt({ kind: 'tool_permission', reason: 'client-abandoned' })).toBe(true);
  });

  it('always closes out a prompt the user actually answered', () => {
    for (const kind of ['ask_user_question', 'request_user_input', 'git_commit_proposal', 'tool_permission'] as const) {
      expect(shouldTerminalizePrompt({ kind, reason: 'user-responded' })).toBe(true);
    }
  });

  // NIM-7240: a new user turn closes the question for good, unlike a stop.
  it('closes out a question a waiter settles as superseded', () => {
    const reason = settleReasonFromResponse({ reason: 'superseded' });
    expect(reason).toBe('superseded');
    expect(shouldTerminalizePrompt({ kind: 'ask_user_question', reason })).toBe(true);
    expect(shouldTerminalizePrompt({ kind: 'request_user_input', reason })).toBe(true);
    expect(settleReasonFromResponse({})).toBe('user-responded');
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('attachInteractivePromptCall', () => {
  it('settles the waiter when the client aborts the call', () => {
    const controller = new AbortController();
    const onAbort = vi.fn();

    attachInteractivePromptCall({
      request: { params: { _meta: { progressToken: 1 } } },
      extra: { sendNotification: vi.fn(), signal: controller.signal },
      toolName: 'AskUserQuestion',
      onAbort,
    });

    controller.abort();
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('stops heartbeating once the call is aborted', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sendNotification = vi.fn();

    attachInteractivePromptCall({
      request: { params: { _meta: { progressToken: 1 } } },
      extra: { sendNotification, signal: controller.signal },
      toolName: 'AskUserQuestion',
      onAbort: () => {},
      intervalMs: 1000,
    });

    vi.advanceTimersByTime(2000);
    expect(sendNotification).toHaveBeenCalledTimes(2);

    controller.abort();
    vi.advanceTimersByTime(5000);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('does not fire onAbort after the prompt has settled normally', () => {
    const controller = new AbortController();
    const onAbort = vi.fn();

    const detach = attachInteractivePromptCall({
      request: { params: { _meta: { progressToken: 1 } } },
      extra: { sendNotification: vi.fn(), signal: controller.signal },
      toolName: 'AskUserQuestion',
      onAbort,
    });

    detach();
    controller.abort();
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('settles immediately when handed an already-aborted call', () => {
    const controller = new AbortController();
    controller.abort();
    const onAbort = vi.fn();

    attachInteractivePromptCall({
      request: { params: { _meta: { progressToken: 1 } } },
      extra: { sendNotification: vi.fn(), signal: controller.signal },
      toolName: 'AskUserQuestion',
      onAbort,
    });

    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('still heartbeats when the transport offers no abort signal', () => {
    vi.useFakeTimers();
    const sendNotification = vi.fn();

    const detach = attachInteractivePromptCall({
      request: { params: { _meta: { progressToken: 1 } } },
      extra: { sendNotification },
      toolName: 'AskUserQuestion',
      onAbort: () => { throw new Error('must not abort'); },
      intervalMs: 1000,
    });

    vi.advanceTimersByTime(3000);
    expect(sendNotification).toHaveBeenCalledTimes(3);
    detach();
  });
});

// Real production handler, real protocol cancellation and real stream transport;
// repositories, transcript writes and desktop IPC delivery are in-memory seams.
describe('connected AskUserQuestion lifecycle', () => {
  it.each(['answer', 'cancel', 'delete'] as const)('settles once on %s after progress and ignores late desktop/mobile answers', async reason => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const ipc = ipcMain as unknown as EventEmitter;
    const sessionId = `sdk-question-${reason}`;
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
    const server = new Server({ name: 'question-fixture', version: '1' }, { capabilities: { tools: {} } });
    let settlements = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const req = (body?: unknown, method = 'POST') => new Request('http://localhost/mcp', { method, headers: {
      accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-03-26',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const result = await handleAskUserQuestion(request.params.arguments, sessionId, request, extra);
      settlements++;
      return result;
    });
    try {
      await server.connect(transport);
      await (await transport.handleRequest(req({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' },
      } }))).text();
      const response = await transport.handleRequest(req({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'AskUserQuestion', _meta: { progressToken: 17, toolUseId: '2' }, arguments: { questions: [{ header: 'Choice', question: 'Select', options: [{ label: 'A', description: 'Option A' }] }] },
      } }));
      reader = response.body!.getReader();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(countLiveInteractivePrompts(sessionId)).toBe(1);
      expect(ipc.listenerCount(`ask-user-question-response:${sessionId}:2`)).toBe(1);
      vi.advanceTimersByTime(60000);
      await new Promise<void>(resolve => setImmediate(resolve));
      // The 60s semantic progress remains separate from 15s SSE comments.
      let progress = '';
      for (let i = 0; i < 5 && !progress.includes('notifications/progress'); i++) {
        progress += new TextDecoder().decode((await reader.read()).value);
      }
      expect(progress).toContain('notifications/progress');
      expect(progress).toContain('"progressToken":17');
      expect(settlements).toBe(0);
      if (reason === 'answer') {
        ipc.emit(`ask-user-question-response:${sessionId}:2`, null, { answers: { Choice: 'A' }, respondedBy: 'desktop' });
      } else if (reason === 'cancel') {
        expect((await transport.handleRequest(req({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'fixture cancellation' } }))).status).toBe(202);
      } else {
        expect((await transport.handleRequest(req(undefined, 'DELETE'))).status).toBe(200);
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settlements).toBe(1);
      expect(countLiveInteractivePrompts(sessionId)).toBe(0);
      expect(ipc.listenerCount(`ask-user-question-response:${sessionId}:2`)).toBe(0);
      expect(ipc.listenerCount(`ask-user-question:${sessionId}`)).toBe(0);
      expect(seams.pending.mock.calls.filter(args => args[0] === sessionId && args[1] === false)).toHaveLength(1);
      // Abandonment must retire the waiter without writing an answered widget.
      expect(seams.persistResult).toHaveBeenCalledTimes(reason === 'answer' ? 1 : 0);
      ipc.emit(`ask-user-question-response:${sessionId}:2`, null, { answers: { Choice: 'late' }, respondedBy: 'desktop' });
      ipc.emit(`ask-user-question:${sessionId}`, null, { answers: { Choice: 'late' }, respondedBy: 'mobile' });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settlements).toBe(1);
      expect(seams.persistResult).toHaveBeenCalledTimes(reason === 'answer' ? 1 : 0);
    } finally {
      await reader?.cancel();
      await server.close();
      ipc.removeAllListeners();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
