// @vitest-environment node
/**
 * Two sendMessage calls can overlap on one provider: an answer to a form whose
 * waiter is gone resumes the session while its turn is still running. The newer
 * turn takes over the provider's live fields, so the older turn's teardown must
 * leave them alone. If it clears them, the newer subprocess has no handle: it
 * cannot be aborted, the provider reports idle, and the next message starts
 * another subprocess beside it.
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

const INIT_CHUNK = {
  type: 'system',
  subtype: 'init',
  session_id: 'sdk-session-1',
  slash_commands: [],
  skills: [],
  mcp_servers: [],
  tools: [],
};

type LiveQuery = AsyncIterable<unknown> & { close: ReturnType<typeof vi.fn>; controller: AbortController };

/** A subprocess that stays busy until its turn's controller aborts. */
function liveQuery(controller: AbortController): LiveQuery {
  return {
    async *[Symbol.asyncIterator]() {
      yield INIT_CHUNK;
      if (!controller.signal.aborted) {
        await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
      }
    },
    interrupt: async () => {},
    streamInput: async () => {},
    close: vi.fn(),
    controller,
  } as unknown as LiveQuery;
}

async function makeProvider(): Promise<ClaudeCodeProvider> {
  const provider = new ClaudeCodeProvider();
  await provider.initialize({ provider: 'claude-code', model: 'sonnet' } as never);
  const internals = provider as unknown as Record<string, unknown>;
  internals.logAgentMessage = vi.fn(async () => {});
  internals.logAgentMessageNonBlocking = vi.fn();
  internals.logError = vi.fn();
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
    captureSessionId: vi.fn(),
    expireSession: vi.fn(),
    getBranchedFrom: () => null,
  };
  return provider;
}

async function drain(provider: ClaudeCodeProvider, message: string): Promise<void> {
  const turn = provider.sendMessage(message, { mode: 'agent' } as never, 'nimbalyst-session-1', undefined, os.tmpdir());
  for await (const _chunk of turn) {
    // Only the provider's state matters here.
  }
}

const ASSISTANT_CHUNK = {
  type: 'assistant',
  session_id: 'sdk-session-1',
  message: { id: 'msg_1', content: [{ type: 'text', text: 'done' }] },
};

const RESULT_CHUNK = { type: 'result', subtype: 'success', is_error: false, num_turns: 1 };

/** A subprocess that finishes its turn, then stays alive the way the CLI does between turns. */
function finishedQuery(controller: AbortController): LiveQuery {
  return {
    async *[Symbol.asyncIterator]() {
      yield INIT_CHUNK;
      yield ASSISTANT_CHUNK;
      yield RESULT_CHUNK;
      if (!controller.signal.aborted) {
        await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
      }
    },
    interrupt: async () => {},
    streamInput: async () => {},
    close: vi.fn(),
    controller,
  } as unknown as LiveQuery;
}

type PromptController = { isEnded(): boolean };

async function waitForQueries(count: number): Promise<void> {
  await vi.waitFor(() => expect(queryMock.mock.calls.length).toBe(count), { timeout: 5000 });
}

describe('overlapping ClaudeCodeProvider turns', () => {
  const started: LiveQuery[] = [];

  beforeEach(() => {
    started.length = 0;
    queryMock.mockReset();
    queryMock.mockImplementation(({ options }: { options: { abortController: AbortController } }) => {
      const query = liveQuery(options.abortController);
      started.push(query);
      return query;
    });
  });

  it('keeps the newer turn stoppable after the older turn tears down', async () => {
    const provider = await makeProvider();
    const internals = provider as unknown as { leadQuery: unknown; abortController: AbortController | null };

    const first = drain(provider, 'first');
    await waitForQueries(1);
    const second = drain(provider, 'second');
    await waitForQueries(2);
    await first;

    expect(started[0].controller.signal.aborted).toBe(true);
    expect(internals.leadQuery).toBe(started[1]);
    expect(internals.abortController).toBe(started[1].controller);
    expect(provider.isLeadBusy()).toBe(true);

    provider.abort();
    expect(started[1].controller.signal.aborted).toBe(true);
    await second;
  });

  it('never leaves two subprocesses running when a third message arrives', async () => {
    const provider = await makeProvider();

    const first = drain(provider, 'first');
    await waitForQueries(1);
    const second = drain(provider, 'second');
    await waitForQueries(2);
    await first;
    const third = drain(provider, 'third');
    await waitForQueries(3);
    await second;

    expect(started[0].controller.signal.aborted).toBe(true);
    expect(started[1].controller.signal.aborted).toBe(true);
    expect(started[2].controller.signal.aborted).toBe(false);

    provider.abort();
    await third;
  });

  it('closes the superseded subprocess', async () => {
    const provider = await makeProvider();

    const first = drain(provider, 'first');
    await waitForQueries(1);
    const second = drain(provider, 'second');
    await waitForQueries(2);
    await first;

    expect(started[0].close).toHaveBeenCalled();
    expect(started[1].close).not.toHaveBeenCalled();

    provider.abort();
    await second;
  });

  it('does not let the older turn\'s grace timer close the newer turn\'s prompt stream', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      queryMock.mockImplementationOnce(({ options }: { options: { abortController: AbortController } }) => {
        const query = finishedQuery(options.abortController);
        started.push(query);
        return query;
      });
      const provider = await makeProvider();
      const internals = provider as unknown as { promptController: PromptController | null };

      // The consumer stops pulling right after `complete`, so the first turn's
      // grace timer is armed and its teardown has not run yet.
      const firstTurn = provider.sendMessage('first', { mode: 'agent' } as never, 'nimbalyst-session-1', undefined, os.tmpdir());
      const firstIterator = firstTurn[Symbol.asyncIterator]();
      for (;;) {
        const { value, done } = await firstIterator.next();
        if (done || (value as { type?: string }).type === 'complete') break;
      }

      const second = drain(provider, 'second');
      await waitForQueries(2);
      const secondPrompt = internals.promptController;
      expect(secondPrompt?.isEnded()).toBe(false);

      vi.advanceTimersByTime(31_000);
      expect(secondPrompt?.isEnded()).toBe(false);

      while (!(await firstIterator.next()).done) { /* let the first turn tear down */ }
      expect(internals.promptController).toBe(secondPrompt);
      expect(secondPrompt?.isEnded()).toBe(false);

      provider.abort();
      await second;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the newer turn\'s prompt stream when the older turn finishes building its prompt last', async () => {
    const provider = await makeProvider();
    const internals = provider as unknown as {
      promptController: PromptController | null;
      getMcpServersSnapshot: () => Promise<Record<string, unknown>>;
    };
    let releaseFirstBuild!: () => void;
    const firstBuildGate = new Promise<void>((resolve) => { releaseFirstBuild = resolve; });
    let snapshotCalls = 0;
    internals.getMcpServersSnapshot = vi.fn(async () => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) await firstBuildGate;
      return {};
    });

    const first = drain(provider, 'first');
    await vi.waitFor(() => expect(snapshotCalls).toBe(1), { timeout: 5000 });
    const second = drain(provider, 'second');
    await waitForQueries(1);
    const secondPrompt = internals.promptController;
    expect(secondPrompt?.isEnded()).toBe(false);

    releaseFirstBuild();
    await first;

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(internals.promptController).toBe(secondPrompt);
    expect(secondPrompt?.isEnded()).toBe(false);

    provider.abort();
    await second;
  });
});
