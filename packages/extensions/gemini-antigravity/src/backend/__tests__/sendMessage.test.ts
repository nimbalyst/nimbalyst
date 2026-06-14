/**
 * OBSERVED integration test for the gemini-antigravity backend sendMessage
 * stream (the stretch claim).
 *
 * Drives the REAL agent.ts activate() -> createSession -> sendMessage and the
 * REAL AntigravityToolLoopProtocol.run() tool loop. The ONLY mocked boundary is
 * AntigravityServerManager.prototype.getModelResponse (Seam A): mocking it means
 * the language_server.exe spawn, the ~/.gemini OAuth check, and the HTTPS
 * Connect-RPC never run, while every line of agent.ts's event-shaping and
 * logRaw audit path executes for real.
 *
 * Run from repo root:
 *   npx vitest --run packages/extensions/gemini-antigravity/src/backend/__tests__/sendMessage.test.ts
 */
import * as os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// agent.ts exports `activate` BOTH as a named export and as the default
// object `{ activate }`. Use the named export so `activate` is the function.
import { activate } from '../agent';
import { AntigravityServerManager } from '../ServerManager';

type AnyProtocolEvent = {
  type: 'text' | 'tool_call' | 'complete' | 'error';
  content?: string;
  isComplete?: boolean;
  error?: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown>; result?: unknown };
};

function makeCtx() {
  const logRaw = vi.fn(async () => {});
  const toolExecutor = vi.fn(async () => 'ok');
  const devToolExecutor = vi.fn(async () => 'dev-tool ok');
  const ctx = {
    extensionId: 'gemini-antigravity',
    extensionPath: os.tmpdir(), // resolveServerConfig probes for an optional config file here
    services: { logRaw, toolExecutor, devToolExecutor },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  return { ctx, logRaw, toolExecutor, devToolExecutor };
}

describe('gemini-antigravity backend sendMessage', () => {
  // Use vi.MockInstance with the explicit method signature. The
  // unparameterized `ReturnType<typeof vi.spyOn>` widens to a no-arg fallback
  // under vitest's overload set, which breaks assignability against the real
  // 3-arg AntigravityServerManager.getModelResponse signature.
  let getModelResponse: import('vitest').MockInstance<
    AntigravityServerManager['getModelResponse']
  >;

  beforeEach(() => {
    // Intercept the single server touch point inside run(). ensureRunning()
    // (and thus spawnStandalone) is never reached because we replace the method
    // that would call it.
    getModelResponse = vi.spyOn(
      AntigravityServerManager.prototype,
      'getModelResponse',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks(); // remove the prototype spy; the shared() singleton survives across tests
  });

  it('yields a text ProtocolEvent then a complete event for a no-tool turn, and audits via logRaw', async () => {
    getModelResponse.mockResolvedValue('Hello from the model.');

    const { ctx, logRaw, toolExecutor } = makeCtx();
    // activate() returns { methods }, so the lifecycle RPCs live under methods.
    const { methods } = await activate(ctx as never);
    await methods.createSession({
      sessionId: 's1',
      model: 'gemini-3-flash-agent',
      tools: [],
      systemPrompt: 'sys',
    });

    const events: AnyProtocolEvent[] = [];
    for await (const ev of methods.sendMessage({ sessionId: 's1', message: 'hi' })) {
      events.push(ev as AnyProtocolEvent);
    }

    // The stream is a real AsyncIterable<ProtocolEvent>.
    expect(events.length).toBeGreaterThanOrEqual(2);

    const textEvent = events.find((e) => e.type === 'text');
    expect(textEvent).toBeDefined();
    expect(textEvent?.content).toBe('Hello from the model.');

    const last = events[events.length - 1];
    expect(last.type).toBe('complete');
    expect(last.isComplete).toBe(true);
    expect(last.content).toBe('Hello from the model.');

    // Model called exactly once -> single no-tool round -> no spawn occurred.
    expect(getModelResponse).toHaveBeenCalledTimes(1);
    expect(toolExecutor).not.toHaveBeenCalled();

    // logRaw audited both the inbound user turn and the outbound assistant turn.
    expect(logRaw).toHaveBeenCalledWith(
      's1', 'inbound', 'hi',
      expect.objectContaining({ role: 'user' }),
    );
    expect(logRaw).toHaveBeenCalledWith(
      's1', 'outbound', 'Hello from the model.',
      expect.objectContaining({ role: 'assistant' }),
    );
  });

  it('yields a tool_call (with result) ProtocolEvent before text+complete when the model requests a tool', async () => {
    // 1st model round: request the tool. 2nd round: plain text -> complete.
    getModelResponse
      .mockResolvedValueOnce('{"tool_call":{"name":"echo","arguments":{"x":1}}}')
      .mockResolvedValueOnce('done');

    const { ctx, toolExecutor } = makeCtx();
    toolExecutor.mockResolvedValue('echoed-1');

    const { methods } = await activate(ctx as never);
    await methods.createSession({
      sessionId: 's2',
      model: 'gemini-3-flash-agent',
      tools: [{ type: 'function', function: { name: 'echo' } }],
      systemPrompt: 'sys',
    });

    const events: AnyProtocolEvent[] = [];
    for await (const ev of methods.sendMessage({ sessionId: 's2', message: 'use the tool' })) {
      events.push(ev as AnyProtocolEvent);
    }

    // The tool was dispatched through the host-injected executor with the
    // session-scoped payload.
    expect(toolExecutor).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's2', name: 'echo', args: { x: 1 } }),
    );

    // A tool_call ProtocolEvent carrying the result was yielded.
    const toolEventWithResult = events.find(
      (e) => e.type === 'tool_call' && e.toolCall?.result !== undefined,
    );
    expect(toolEventWithResult).toBeDefined();
    expect(toolEventWithResult?.toolCall?.name).toBe('echo');
    expect(toolEventWithResult?.toolCall?.arguments).toEqual({ x: 1 });
    expect(toolEventWithResult?.toolCall?.result).toBe('echoed-1');

    // Stream still terminates with text + complete.
    const textEvent = events.find((e) => e.type === 'text');
    expect(textEvent?.content).toBe('done');
    const last = events[events.length - 1];
    expect(last.type).toBe('complete');
    expect(last.isComplete).toBe(true);

    // Two model rounds (tool round + text round) -> still no spawn.
    expect(getModelResponse).toHaveBeenCalledTimes(2);
  });

  it('actually executes a run_command tool call in the workspace and returns its output', async () => {
    // run_command is handled locally in the backend (real child_process), NOT
    // via a host service - so this asserts genuine execution end-to-end through
    // the real tool loop. echo is a no-quote cross-platform marker (cmd + sh).
    const cmd = 'echo GEMINI_OK_5';
    getModelResponse
      .mockResolvedValueOnce(
        JSON.stringify({ tool_call: { name: 'run_command', arguments: { command: cmd } } }),
      )
      .mockResolvedValueOnce('done');

    const { ctx } = makeCtx();
    const { methods } = await activate(ctx as never);
    await methods.createSession({
      sessionId: 'rc1',
      model: 'gemini-3-flash-agent',
      workspacePath: os.tmpdir(),
      tools: [{ type: 'function', function: { name: 'run_command' } }],
      systemPrompt: 'sys',
    });

    const events: AnyProtocolEvent[] = [];
    for await (const ev of methods.sendMessage({ sessionId: 'rc1', message: 'run it' })) {
      events.push(ev as AnyProtocolEvent);
    }

    const toolEvent = events.find(
      (e) => e.type === 'tool_call' && e.toolCall?.name === 'run_command' && e.toolCall?.result !== undefined,
    );
    expect(toolEvent).toBeDefined();
    // Real child process ran in the workspace and its stdout was captured.
    expect(String(toolEvent?.toolCall?.result)).toContain('GEMINI_OK_5');
    expect(String(toolEvent?.toolCall?.result)).toContain('exit code: 0');
  });

  it('routes a write_file tool call to the workspace-files devToolExecutor channel, not toolExecutor', async () => {
    getModelResponse
      .mockResolvedValueOnce(
        JSON.stringify({
          tool_call: { name: 'write_file', arguments: { path: 'note.md', content: 'hello' } },
        }),
      )
      .mockResolvedValueOnce('saved');

    const { ctx, devToolExecutor, toolExecutor } = makeCtx();
    const { methods } = await activate(ctx as never);
    await methods.createSession({
      sessionId: 'wf1',
      model: 'gemini-3-flash-agent',
      workspacePath: os.tmpdir(),
      tools: [{ type: 'function', function: { name: 'write_file' } }],
      systemPrompt: 'sys',
    });

    const events: AnyProtocolEvent[] = [];
    for await (const ev of methods.sendMessage({ sessionId: 'wf1', message: 'write it' })) {
      events.push(ev as AnyProtocolEvent);
    }

    // write_file is in DEV_AGENT_TOOL_NAMES -> routed to the workspace-files
    // gated devToolExecutor, never the db-write toolExecutor channel.
    expect(devToolExecutor).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'write_file', args: { path: 'note.md', content: 'hello' } }),
    );
    expect(toolExecutor).not.toHaveBeenCalled();
  });

  it('nudges and recovers when the model narrates a tool call instead of emitting it', async () => {
    // 1st round: prose intent, NO envelope (the stall failure mode). 2nd round:
    // real tool call. 3rd: final text. Without the nudge the loop would end
    // after round 1 and the tool would never run.
    getModelResponse
      .mockResolvedValueOnce("Now I'll read the file. Let's use read_file on package.json.")
      .mockResolvedValueOnce(
        JSON.stringify({ tool_call: { name: 'read_file', arguments: { path: 'package.json' } } }),
      )
      .mockResolvedValueOnce('done');

    const { ctx, devToolExecutor } = makeCtx();
    devToolExecutor.mockResolvedValue('file contents here');
    const { methods } = await activate(ctx as never);
    await methods.createSession({
      sessionId: 'nudge1',
      model: 'gemini-3-flash-agent',
      workspacePath: os.tmpdir(),
      tools: [{ type: 'function', function: { name: 'read_file' } }],
      systemPrompt: 'sys',
    });

    const events: AnyProtocolEvent[] = [];
    for await (const ev of methods.sendMessage({ sessionId: 'nudge1', message: 'read it' })) {
      events.push(ev as AnyProtocolEvent);
    }

    // The nudge recovered: read_file actually ran rather than being abandoned
    // after the prose, and the loop took three model rounds.
    expect(devToolExecutor).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'read_file', args: { path: 'package.json' } }),
    );
    expect(getModelResponse).toHaveBeenCalledTimes(3);
    const last = events[events.length - 1];
    expect(last.type).toBe('complete');
    expect(last.content).toBe('done');
  });
});
