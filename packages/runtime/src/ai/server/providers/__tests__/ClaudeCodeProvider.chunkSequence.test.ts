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

vi.mock('electron', async () => ({
  app: { ...(await import('../../../../../../electron/test-stubs/privateUserData')).testApp, isPackaged: false },
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
        // #1493 made this flag load-bearing. The fixture carried no background
        // evidence at all — no flag and no launch-acknowledgement tool_result —
        // which is now indistinguishable from an ordinary foreground Bash. The
        // scenario it models is a backgrounded shell, so it says so.
        is_backgrounded: true,
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

  // Regression: GitHub #1493. The CLI tracks every Bash call as a local_bash
  // task and flags foregroundness on task_started. The provider dropped
  // is_backgrounded, refused to settle the task from the inline tool_result,
  // then stamped isBackgrounded on it — so an ordinary `npm test` produced a
  // "[System: background task(s) you launched have settled" continuation turn
  // after the user's turn had already ended.
  it('neither closes nor wakes when a foreground Bash settles via its own tool_result', async () => {
    const { provider } = await makeProvider();
    const { query, close } = scriptQueryWithClose([
      INIT_CHUNK,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task_1',
        task_type: 'local_bash',
        is_backgrounded: false,
        description: 'npm test',
        tool_use_id: 'toolu_fg',
      },
      {
        type: 'assistant',
        session_id: 'sdk-session-1',
        message: {
          id: 'msg_1',
          content: [{ type: 'tool_use', id: 'toolu_fg', name: 'Bash', input: { command: 'npm test' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_fg',
              content: 'Tests: 42 passed, 42 total',
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
        summary: 'npm test finished',
      },
      {
        type: 'assistant',
        session_id: 'sdk-session-1',
        message: { id: 'msg_2', content: [{ type: 'text', text: 'all tests pass' }] },
      },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 3 },
    ]);
    queryMock.mockImplementation(() => query);

    const idleMessages: unknown[] = [];
    provider.on('teammate:messageWhileIdle', (payload) => idleMessages.push(payload));

    await runTurn(provider, 'run the tests');

    expect(close).not.toHaveBeenCalled();
    expect(idleMessages).toEqual([]);
  });

  // Older CLIs send no is_backgrounded at all. The absent flag must not be read
  // as "backgrounded" — the inline output is what settles the task.
  it('neither closes nor wakes for a foreground Bash whose task carries no is_backgrounded flag', async () => {
    const { provider } = await makeProvider();
    const { query, close } = scriptQueryWithClose([
      INIT_CHUNK,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task_1',
        task_type: 'local_bash',
        description: 'grep -c TODO src',
        tool_use_id: 'toolu_old',
      },
      {
        type: 'assistant',
        session_id: 'sdk-session-1',
        message: {
          id: 'msg_1',
          content: [{ type: 'tool_use', id: 'toolu_old', name: 'Bash', input: { command: 'grep -c TODO src' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_old', content: '17', is_error: false },
          ],
        },
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task_1',
        status: 'completed',
      },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 3 },
    ]);
    queryMock.mockImplementation(() => query);

    const idleMessages: unknown[] = [];
    provider.on('teammate:messageWhileIdle', (payload) => idleMessages.push(payload));

    await runTurn(provider, 'count the TODOs');

    expect(close).not.toHaveBeenCalled();
    expect(idleMessages).toEqual([]);
  });

  // The CLI can report a task foreground on task_started and then move it to
  // the background without ever sending a task_updated patch — the launch
  // acknowledgement is the only notice. The stale `false` must lose to it, or
  // the shell is killed at teardown (NIM-1470) and its result never reported.
  it('wakes when a task_started foreground shell is auto-backgrounded by its acknowledgement', async () => {
    const { provider } = await makeProvider();
    const { query } = scriptQueryWithClose([
      INIT_CHUNK,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task_1',
        task_type: 'local_bash',
        is_backgrounded: false,
        description: 'npm run e2e',
        tool_use_id: 'toolu_auto',
      },
      {
        type: 'assistant',
        session_id: 'sdk-session-1',
        message: {
          id: 'msg_1',
          content: [{ type: 'tool_use', id: 'toolu_auto', name: 'Bash', input: { command: 'npm run e2e' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_auto',
              content: 'Command running in background with ID: b0hywzbc1.',
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
        summary: 'e2e passed',
      },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 3 },
    ]);
    queryMock.mockImplementation(() => query);

    const idleMessages: Array<{ message: string }> = [];
    provider.on('teammate:messageWhileIdle', (payload) => idleMessages.push(payload));

    await runTurn(provider, 'run the e2e suite in the background');

    expect(idleMessages).toHaveLength(1);
    expect(idleMessages[0].message).toContain('npm run e2e');
    expect(idleMessages[0].message).toContain('e2e passed');
  });

  // The notification can beat the inline tool_result. The task is already
  // terminal by the time the result lands, so nothing may settle it a second
  // time or retro-stamp it as backgrounded.
  it('neither closes nor wakes when a foreground Bash notification precedes its tool_result', async () => {
    const { provider } = await makeProvider();
    const { query, close } = scriptQueryWithClose([
      INIT_CHUNK,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task_1',
        task_type: 'local_bash',
        is_backgrounded: false,
        description: 'npm test',
        tool_use_id: 'toolu_early',
      },
      {
        type: 'assistant',
        session_id: 'sdk-session-1',
        message: {
          id: 'msg_1',
          content: [{ type: 'tool_use', id: 'toolu_early', name: 'Bash', input: { command: 'npm test' } }],
        },
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task_1',
        status: 'completed',
        summary: 'tests passed',
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_early', content: '42 passed', is_error: false },
          ],
        },
      },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 3 },
    ]);
    queryMock.mockImplementation(() => query);

    const idleMessages: unknown[] = [];
    provider.on('teammate:messageWhileIdle', (payload) => idleMessages.push(payload));

    await runTurn(provider, 'run the tests');

    expect(close).not.toHaveBeenCalled();
    expect(idleMessages).toEqual([]);
  });

  // Regression: a fast background shell on an older CLI settles BEFORE the
  // launch acknowledgement reaches us. At notification time there is no
  // background evidence yet, so nothing is recorded; the acknowledgement then
  // arrives for an already-terminal task. The result chunk sees no running task
  // and an empty buffer, and the continuation is lost entirely -- the reporter
  // never learns the background command finished. The notification has to be
  // held until the acknowledgement can classify it.
  it('wakes when an older-CLI background shell settles before its launch acknowledgement', async () => {
    const { provider } = await makeProvider();
    const { query, close } = scriptQueryWithClose([
      INIT_CHUNK,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task_1',
        task_type: 'local_bash',
        description: 'npm run build',
        tool_use_id: 'toolu_fast',
      },
      {
        type: 'assistant',
        session_id: 'sdk-session-1',
        message: {
          id: 'msg_1',
          content: [{ type: 'tool_use', id: 'toolu_fast', name: 'Bash', input: { command: 'npm run build' } }],
        },
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task_1',
        status: 'completed',
        summary: 'build succeeded',
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_fast',
              content: 'Command running in background with ID: b0hywzbc1.',
              is_error: false,
            },
          ],
        },
      },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 3 },
    ]);
    queryMock.mockImplementation(() => query);

    const idleMessages: Array<{ message: string }> = [];
    provider.on('teammate:messageWhileIdle', (payload) => idleMessages.push(payload));

    await runTurn(provider, 'run the build in the background');

    expect(close).toHaveBeenCalledTimes(1);
    expect(idleMessages).toHaveLength(1);
    expect(idleMessages[0].message).toContain('npm run build');
    expect(idleMessages[0].message).toContain('build succeeded');
  });

  // The held notification must still be released exactly once when the
  // acknowledgement is followed by a repeat notification.
  it('wakes once when a held notification is followed by a duplicate after the acknowledgement', async () => {
    const { provider } = await makeProvider();
    const { query } = scriptQueryWithClose([
      INIT_CHUNK,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task_1',
        task_type: 'local_bash',
        description: 'npm run build',
        tool_use_id: 'toolu_fast',
      },
      {
        type: 'assistant',
        session_id: 'sdk-session-1',
        message: {
          id: 'msg_1',
          content: [{ type: 'tool_use', id: 'toolu_fast', name: 'Bash', input: { command: 'npm run build' } }],
        },
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task_1',
        status: 'completed',
        summary: 'build succeeded',
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_fast',
              content: 'Command running in background with ID: b0hywzbc1.',
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
        summary: 'build succeeded',
      },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 3 },
    ]);
    queryMock.mockImplementation(() => query);

    const idleMessages: Array<{ message: string }> = [];
    provider.on('teammate:messageWhileIdle', (payload) => idleMessages.push(payload));

    await runTurn(provider, 'run the build in the background');

    expect(idleMessages).toHaveLength(1);
    expect(idleMessages[0].message.match(/npm run build/g)).toHaveLength(1);
  });

  // A genuinely backgrounded shell still has to reach the drain path, and the
  // repeat task_notification the CLI can send for one must not bill a second
  // continuation turn.
  it('wakes once when a backgrounded shell reports terminally twice', async () => {
    const { provider } = await makeProvider();
    const { query } = scriptQueryWithClose([
      INIT_CHUNK,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task_1',
        task_type: 'local_bash',
        is_backgrounded: true,
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

    await runTurn(provider, 'run the build in the background');

    expect(idleMessages).toHaveLength(1);
    expect(idleMessages[0].message.match(/npm run build/g)).toHaveLength(1);
  });

  // The recording buffer is per-turn, so a repeat notification arriving on a
  // LATER turn clears it and would wake the session again for work already
  // reported. The guard has to live on the tracked task, not the buffer.
  it('does not wake a second time when the notification repeats on a later turn', async () => {
    const { provider } = await makeProvider();
    const backgroundedTurn = [
      INIT_CHUNK,
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task_1',
        task_type: 'local_bash',
        is_backgrounded: true,
        description: 'npm run build',
        tool_use_id: 'toolu_bg',
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task_1',
        status: 'completed',
        summary: 'build succeeded',
      },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 2 },
    ];
    const repeatTurn = [
      INIT_CHUNK,
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task_1',
        status: 'completed',
        summary: 'build succeeded',
      },
      {
        type: 'assistant',
        session_id: 'sdk-session-1',
        message: { id: 'msg_2', content: [{ type: 'text', text: 'acknowledged' }] },
      },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 2 },
    ];

    const idleMessages: unknown[] = [];
    provider.on('teammate:messageWhileIdle', (payload) => idleMessages.push(payload));

    queryMock.mockImplementation(() => scriptQueryWithClose(backgroundedTurn).query);
    await runTurn(provider, 'run the build in the background');
    expect(idleMessages).toHaveLength(1);

    queryMock.mockImplementation(() => scriptQueryWithClose(repeatTurn).query);
    await runTurn(provider, 'thanks');

    expect(idleMessages).toHaveLength(1);
  });

  // GitHub #1555 (duplicate of #1493): the reported turn ran SEVERAL shell
  // commands, "some in the background", and the continuation listed notices
  // "for commands I already reported on". A single-task fixture cannot catch
  // that — the wake is legitimate here, so what has to hold is which tasks the
  // message names. The foreground ones settled inline and must be absent.
  it('names only the backgrounded command when foreground commands ran in the same turn', async () => {
    const { provider } = await makeProvider();
    const foregroundPair = (taskId: string, toolUseId: string, command: string, output: string) => [
      {
        type: 'system',
        subtype: 'task_started',
        task_id: taskId,
        task_type: 'local_bash',
        is_backgrounded: false,
        description: command,
        tool_use_id: toolUseId,
      },
      {
        type: 'assistant',
        session_id: 'sdk-session-1',
        message: {
          id: `msg_${taskId}`,
          content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command } }],
        },
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: taskId,
        status: 'completed',
        summary: output,
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: toolUseId, content: output, is_error: false }],
        },
      },
    ];

    const { query } = scriptQueryWithClose([
      INIT_CHUNK,
      ...foregroundPair('task_fg1', 'toolu_fg1', 'git status', 'nothing to commit'),
      ...foregroundPair('task_fg2', 'toolu_fg2', 'npm run typecheck', 'no errors'),
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task_bg',
        task_type: 'local_bash',
        is_backgrounded: true,
        description: 'npm run build',
        tool_use_id: 'toolu_bg',
      },
      {
        type: 'assistant',
        session_id: 'sdk-session-1',
        message: { id: 'msg_lead', content: [{ type: 'text', text: 'build is running in the background' }] },
      },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 4 },
      // Settles after the lead's result — this is the drain, and the only
      // outcome the session has not already been told about.
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task_bg',
        status: 'completed',
        summary: 'build succeeded',
      },
    ]);
    queryMock.mockImplementation(() => query);

    const idleMessages: Array<{ message: string }> = [];
    provider.on('teammate:messageWhileIdle', (payload) => idleMessages.push(payload));

    await runTurn(provider, 'check the tree, typecheck, then build in the background');

    expect(idleMessages).toHaveLength(1);
    expect(idleMessages[0].message).toContain('npm run build');
    expect(idleMessages[0].message).not.toContain('git status');
    expect(idleMessages[0].message).not.toContain('npm run typecheck');
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
    // #1549: Nimbalyst renders its own question widget and waits for a real
    // human answer, so the CLI's idle auto-continue must never fill one in —
    // whatever a user's or enterprise's settings file says. The SDK default is
    // already 'never'; pinning it keeps an inherited setting from changing that.
    expect((options.settings as Record<string, unknown>).askUserQuestionTimeout).toBe('never');
  });
});
