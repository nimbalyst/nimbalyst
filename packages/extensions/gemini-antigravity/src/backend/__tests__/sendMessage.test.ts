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
  const ctx = {
    extensionId: 'gemini-antigravity',
    extensionPath: os.tmpdir(), // resolveServerConfig probes for an optional config file here
    services: { logRaw, toolExecutor },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  return { ctx, logRaw, toolExecutor };
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
    const api = await activate(ctx as never);
    await api.createSession({
      sessionId: 's1',
      model: 'gemini-3-flash-agent',
      tools: [],
      systemPrompt: 'sys',
    });

    const events: AnyProtocolEvent[] = [];
    for await (const ev of api.sendMessage({ sessionId: 's1', message: 'hi' })) {
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

    const api = await activate(ctx as never);
    await api.createSession({
      sessionId: 's2',
      model: 'gemini-3-flash-agent',
      tools: [{ type: 'function', function: { name: 'echo' } }],
      systemPrompt: 'sys',
    });

    const events: AnyProtocolEvent[] = [];
    for await (const ev of api.sendMessage({ sessionId: 's2', message: 'use the tool' })) {
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
});
