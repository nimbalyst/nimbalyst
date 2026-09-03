// @vitest-environment node
/**
 * Characterization gate for `ClaudeCodeProvider.sendMessage()`.
 *
 * `sendMessage` is an async generator whose chunk loop and epilogue share ~18
 * mutable turn-local variables. Any decomposition that copies one of those
 * instead of sharing it breaks the epilogue silently -- the turn still streams
 * text, it just stops emitting `complete`, or emits it twice, or loses the
 * usage payload.
 *
 * This test drives the generator with a scripted SDK message stream and pins
 * the exact sequence of StreamChunks it yields, plus the prologue's inputs to
 * buildSdkOptions. It was written and confirmed green against the undecomposed
 * method, so it certifies the *old* behavior rather than the new shape.
 *
 * It is a behavior snapshot, not a spec: if you intentionally change what
 * sendMessage emits, update the expectations and say so in the commit.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

vi.mock('../claudeCode/cliPathResolver', () => ({
  resolveClaudeAgentCliPath: async () => '/fake/claude',
}));

vi.mock('../../../../electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: () => ({}),
  resolveNativeBinaryPath: () => undefined,
}));

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: unknown) => queryMock(args),
}));

import os from 'os';
import { ClaudeCodeProvider } from '../ClaudeCodeProvider';
import type { StreamChunk } from '../../types';

/** A scripted stand-in for the SDK's Query handle. */
function scriptQuery(script: Array<Record<string, unknown> | (() => never)>): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const entry of script) {
        if (typeof entry === 'function') entry();
        yield entry;
      }
    },
    // The provider narrows this to `Query` and only touches these on the
    // teammate/interrupt paths, which this test never enters.
    interrupt: async () => {},
    streamInput: async () => {},
    close: () => {},
  } as AsyncIterable<unknown>;
}

/**
 * Scripted query plus the `close` spy. Closing the subprocess is how the
 * provider stops the CLI from running its own queued `<task-notification>`
 * continuation against a control channel we already tore down. See #1410.
 */
function scriptQueryWithClose(
  script: Array<Record<string, unknown> | (() => never)>,
): { query: AsyncIterable<unknown>; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  const query = scriptQuery(script) as AsyncIterable<unknown> & { close: () => void };
  query.close = close;
  return { query, close };
}

type Stubs = {
  logError: ReturnType<typeof vi.fn>;
  logAgentMessage: ReturnType<typeof vi.fn>;
  captureSessionId: ReturnType<typeof vi.fn>;
};

async function makeProvider(): Promise<{ provider: ClaudeCodeProvider; stubs: Stubs }> {
  const provider = new ClaudeCodeProvider();
  await provider.initialize({ provider: 'claude-code', model: 'sonnet' } as never);

  const stubs: Stubs = {
    logError: vi.fn(),
    logAgentMessage: vi.fn(async () => {}),
    captureSessionId: vi.fn(),
  };

  // Everything below is infrastructure the chunk sequence does not depend on:
  // DB writes, transcript transformation, git context, MCP config, tool hooks.
  const internals = provider as unknown as Record<string, unknown>;
  internals.logAgentMessage = stubs.logAgentMessage;
  internals.logAgentMessageNonBlocking = vi.fn();
  internals.logError = stubs.logError;
  internals.logSecurity = vi.fn();
  internals.flushPendingWrites = vi.fn(async () => {});
  internals.processTranscriptMessages = vi.fn(async () => {});
  internals.scheduleTranscriptProcessing = vi.fn();
  internals.emitTodoUpdate = vi.fn(async () => {});
  internals.emitTaskUpdate = vi.fn(async () => {});
  internals.maybeApplyDefaultSessionPhase = vi.fn(async () => {});
  internals.checkSessionExists = vi.fn(async () => true);
  internals.getMcpServersSnapshot = vi.fn(async () => ({}));
  internals.ensureGitContext = vi.fn(async () => {});
  internals.sessions = {
    getSessionId: () => null,
    captureSessionId: stubs.captureSessionId,
    expireSession: vi.fn(),
    getBranchedFrom: () => null,
  };

  return { provider, stubs };
}

/** Drop volatile fields so the sequence is comparable across runs. */
function normalize(chunks: StreamChunk[]): unknown[] {
  return chunks.map((chunk) => {
    const c = chunk as unknown as Record<string, unknown>;
    if (c.type === 'tool_call' || c.type === 'tool_result') {
      const call = c.toolCall as Record<string, unknown>;
      return { type: c.type, id: call.id, name: call.name, isError: call.isError ?? false };
    }
    return c;
  });
}

async function runTurn(
  provider: ClaudeCodeProvider,
  message: string,
  onChunk?: (chunk: StreamChunk, index: number) => void,
): Promise<StreamChunk[]> {
  const collected: StreamChunk[] = [];
  let index = 0;
  for await (const chunk of provider.sendMessage(
    message,
    { mode: 'agent' } as never,
    'nimbalyst-session-1',
    undefined,
    os.tmpdir(),
  )) {
    collected.push(chunk);
    onChunk?.(chunk, index++);
  }
  return collected;
}

const INIT_CHUNK = {
  type: 'system',
  subtype: 'init',
  session_id: 'sdk-session-1',
  slash_commands: [],
  skills: [],
  mcp_servers: [],
  tools: [],
};

describe('ClaudeCodeProvider.sendMessage chunk sequence', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('emits per-step context usage, text, then a terminal complete carrying usage', async () => {
    const { provider, stubs } = await makeProvider();
    queryMock.mockImplementation(() =>
      scriptQuery([
        INIT_CHUNK,
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            id: 'msg_1',
            content: [{ type: 'text', text: 'Hello ' }],
            usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 },
          },
        },
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { id: 'msg_2', content: [{ type: 'text', text: 'world' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          num_turns: 2,
          usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 5 },
        },
      ]),
    );

    const chunks = await runTurn(provider, 'hi');

    expect(normalize(chunks)).toEqual([
      { type: 'context_usage', contextFillTokens: 15 },
      { type: 'text', content: 'Hello ' },
      { type: 'text', content: 'world' },
      {
        type: 'complete',
        isComplete: true,
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 0,
          total_tokens: 19,
        },
        contextFillTokens: 15,
      },
    ]);
    expect(stubs.captureSessionId).toHaveBeenCalledWith('nimbalyst-session-1', 'sdk-session-1');
    expect(stubs.logError).not.toHaveBeenCalled();
  });

  it('yields tool_call at tool_use and tool_result when the result comes back', async () => {
    const { provider } = await makeProvider();
    queryMock.mockImplementation(() =>
      scriptQuery([
        INIT_CHUNK,
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            id: 'msg_1',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a.txt' } }],
          },
        },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body', is_error: false }],
          },
        },
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { id: 'msg_2', content: [{ type: 'text', text: 'done' }] },
        },
        { type: 'result', subtype: 'success', is_error: false, num_turns: 2 },
      ]),
    );

    const chunks = await runTurn(provider, 'read the file');

    expect(normalize(chunks)).toEqual([
      { type: 'tool_call', id: 'toolu_1', name: 'Read', isError: false },
      { type: 'tool_result', id: 'toolu_1', name: 'Read', isError: false },
      { type: 'text', content: 'done' },
      { type: 'complete', isComplete: true },
    ]);
  });

  it('classifies an is_error result chunk as an error followed by complete', async () => {
    const { provider, stubs } = await makeProvider();
    queryMock.mockImplementation(() =>
      scriptQuery([
        INIT_CHUNK,
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'upstream exploded',
        },
      ]),
    );

    const chunks = await runTurn(provider, 'hi');

    // Exactly one `complete`. The chunk loop used to yield its own and leave
    // `completeEmitted` false, so the epilogue's fallback yielded a second.
    expect(normalize(chunks)).toEqual([
      { type: 'error', error: 'upstream exploded' },
      { type: 'complete', isComplete: true },
    ]);
    expect(stubs.logError.mock.calls[0]?.[3]).toBe('result_chunk');
  });

  it('emits one complete when the SDK reports an authentication failure', async () => {
    const { provider, stubs } = await makeProvider();
    queryMock.mockImplementation(() =>
      scriptQuery([
        INIT_CHUNK,
        { type: 'assistant', session_id: 'sdk-session-1', error: 'authentication_failed' },
      ]),
    );

    const chunks = await runTurn(provider, 'hi');

    expect(normalize(chunks)).toEqual([
      { type: 'error', error: 'Authentication failed. Please log in to continue.', isAuthError: true },
      { type: 'complete', isComplete: true },
    ]);
    expect(stubs.logError.mock.calls[0]?.[3]).toBe('assistant_chunk');
  });

  it('carries usage on the terminal complete when a turn errors after streaming', async () => {
    // The epilogue owns terminal completion on the error path too, so the
    // tokens already spent this turn still reach the consumer.
    const { provider } = await makeProvider();
    queryMock.mockImplementation(() =>
      scriptQuery([
        INIT_CHUNK,
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            id: 'msg_1',
            content: [{ type: 'text', text: 'partial answer' }],
            usage: { input_tokens: 30, output_tokens: 4, cache_read_input_tokens: 2 },
          },
        },
        { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'rate limit exceeded' },
      ]),
    );

    const chunks = await runTurn(provider, 'hi');

    expect(normalize(chunks)).toEqual([
      { type: 'context_usage', contextFillTokens: 32 },
      { type: 'text', content: 'partial answer' },
      { type: 'error', error: 'rate limit exceeded' },
      {
        type: 'complete',
        isComplete: true,
        usage: {
          input_tokens: 30,
          output_tokens: 4,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 0,
          total_tokens: 34,
        },
        contextFillTokens: 32,
      },
    ]);
  });

  it('yields error then complete when the SDK iterator throws mid-stream', async () => {
    const { provider, stubs } = await makeProvider();
    queryMock.mockImplementation(() =>
      scriptQuery([
        INIT_CHUNK,
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { id: 'msg_1', content: [{ type: 'text', text: 'partial' }] },
        },
        () => {
          throw new Error('transport blew up');
        },
      ]),
    );

    const chunks = await runTurn(provider, 'hi');

    expect(chunks[0]).toEqual({ type: 'text', content: 'partial' });
    expect((chunks[1] as { type: string; error: string }).type).toBe('error');
    expect((chunks[1] as { type: string; error: string }).error).toContain('transport blew up');
    expect(chunks[2]).toEqual({ type: 'complete' });
    expect(stubs.logError.mock.calls[0]?.[3]).toBe('catch_block');
  });

  it('emits a bare complete when the turn is aborted mid-stream', async () => {
    const { provider } = await makeProvider();
    queryMock.mockImplementation(() =>
      scriptQuery([
        INIT_CHUNK,
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { id: 'msg_1', content: [{ type: 'text', text: 'first' }] },
        },
        {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { id: 'msg_2', content: [{ type: 'text', text: 'never reached' }] },
        },
        { type: 'result', subtype: 'success', is_error: false, num_turns: 2 },
      ]),
    );

    const chunks = await runTurn(provider, 'hi', (chunk) => {
      if (chunk.type === 'text') provider.abort();
    });

    expect(normalize(chunks)).toEqual([
      { type: 'text', content: 'first' },
      { type: 'complete', isComplete: true },
    ]);
  });

  it('logs a slash-command-error when a slash command produces no output and no tool calls', async () => {
    const { provider, stubs } = await makeProvider();
    queryMock.mockImplementation(() =>
      scriptQuery([INIT_CHUNK, { type: 'result', subtype: 'success', is_error: false, num_turns: 1 }]),
    );

    const chunks = await runTurn(provider, '/nosuchcommand');

    expect(normalize(chunks)).toEqual([{ type: 'complete', isComplete: true }]);
    expect(stubs.logError.mock.calls[0]?.[3]).toBe('slash_command');
    expect((stubs.logError.mock.calls[0]?.[2] as Error).message).toContain('/nosuchcommand');
  });

  it('does not log a slash-command-error when the turn was compacted', async () => {
    const { provider, stubs } = await makeProvider();
    queryMock.mockImplementation(() =>
      scriptQuery([
        INIT_CHUNK,
        { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 1234 } },
        { type: 'result', subtype: 'success', is_error: false, num_turns: 1 },
      ]),
    );

    const chunks = await runTurn(provider, '/compact');

    expect(normalize(chunks)).toEqual([
      { type: 'text', content: 'Conversation compacted (was 1234 tokens)' },
      { type: 'complete', isComplete: true, contextCompacted: true },
    ]);
    expect(stubs.logError).not.toHaveBeenCalled();
  });

  // #1410: a backgrounded task that settles DURING the turn engages none of the
  // drain machinery (hasRunningTasks() is already false at the result chunk), so
  // the CLI's queued continuation turn used to run invisibly against a channel
  // we closed ~0.3s earlier and every tool needing permission was denied.
  it('closes the subprocess and wakes the session when a backgrounded task settles mid-turn', async () => {
    const { provider } = await makeProvider();
    const { query, close } = scriptQueryWithClose([
      INIT_CHUNK,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task_1',
        task_type: 'local_bash',
        description: 'npm run build',
        tool_use_id: 'toolu_bg',
      },
      {
        type: 'assistant',
        session_id: 'sdk-session-1',
        message: { id: 'msg_1', content: [{ type: 'text', text: 'started the build' }] },
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task_1',
        status: 'completed',
        summary: 'build succeeded',
      },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 2 },
    ]);
    queryMock.mockImplementation(() => query);

    const idleMessages: Array<{ sessionId: string; message: string }> = [];
    provider.on('teammate:messageWhileIdle', (payload) => idleMessages.push(payload));

    const chunks = await runTurn(provider, 'run the build in the background');

    expect(normalize(chunks)).toEqual([
      { type: 'text', content: 'started the build' },
      { type: 'complete', isComplete: true },
    ]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(idleMessages).toHaveLength(1);
    expect(idleMessages[0].sessionId).toBe('nimbalyst-session-1');
    expect(idleMessages[0].message).toContain('npm run build');
    expect(idleMessages[0].message).toContain('build succeeded');
  });

  // The negative half of #1410's gate: a FOREGROUND Task settles via its own
  // tool_result, the model already saw the result inline, and the CLI queues no
  // continuation. Treating its notification as a trigger would bill an extra
  // turn per delegation.
  it('neither closes nor wakes when a foreground Task settles via its own tool_result', async () => {
    const { provider } = await makeProvider();
    const { query, close } = scriptQueryWithClose([
      INIT_CHUNK,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task_1',
        task_type: 'agent',
        description: 'review the diff',
        tool_use_id: 'toolu_1',
      },
      {
        type: 'assistant',
        session_id: 'sdk-session-1',
        message: {
          id: 'msg_1',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { prompt: 'review' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'Agent finished: findings attached.',
              is_error: false,
            },
          ],
        },
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task_1',
        status: 'completed',
        summary: 'reviewed',
      },
      {
        type: 'assistant',
        session_id: 'sdk-session-1',
        message: { id: 'msg_2', content: [{ type: 'text', text: 'the review is in' }] },
      },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 3 },
    ]);
    queryMock.mockImplementation(() => query);

    const idleMessages: unknown[] = [];
    provider.on('teammate:messageWhileIdle', (payload) => idleMessages.push(payload));

    await runTurn(provider, 'review the diff');

    expect(close).not.toHaveBeenCalled();
    expect(idleMessages).toEqual([]);
  });

  it('passes the resolved turn inputs through to buildSdkOptions', async () => {
    const { provider } = await makeProvider();
    queryMock.mockImplementation(() =>
      scriptQuery([INIT_CHUNK, { type: 'result', subtype: 'success', is_error: false, num_turns: 1 }]),
    );

    await runTurn(provider, 'hello there');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const { options } = queryMock.mock.calls[0][0] as { options: Record<string, unknown> };
    expect(options.cwd).toBe(os.tmpdir());
    expect(options.pathToClaudeCodeExecutable).toBe('/fake/claude');
    expect(typeof options.canUseTool).toBe('function');
    expect(typeof options.stderr).toBe('function');
  });
});
