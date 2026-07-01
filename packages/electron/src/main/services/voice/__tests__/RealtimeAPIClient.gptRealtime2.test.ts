import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Hoisted so the mock factories (also hoisted) can reference them safely.
const { FakeWS, sendEvent } = vi.hoisted(() => {
  // Controllable fake WebSocket. Every constructed socket is recorded in
  // `sockets` so a test can drive its lifecycle (open/error/close/message).
  class FakeWS {
    static sockets: FakeWS[] = [];
    handlers: Record<string, Array<(...args: any[]) => void>> = {};
    sent: string[] = [];
    url: string;
    constructor(url: string) {
      this.url = url;
      FakeWS.sockets.push(this);
    }
    on(ev: string, cb: (...args: any[]) => void): void {
      (this.handlers[ev] ||= []).push(cb);
    }
    emit(ev: string, ...args: any[]): void {
      (this.handlers[ev] || []).forEach((h) => h(...args));
    }
    send(s: string): void {
      this.sent.push(s);
    }
    close(): void {
      this.emit('close', 1000, 'closed');
    }
    /** Parsed JSON of everything sent on this socket. */
    parsed(): any[] {
      return this.sent.map((s) => JSON.parse(s));
    }
  }
  return { FakeWS, sendEvent: vi.fn() };
});

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), once: vi.fn(), removeListener: vi.fn(), removeAllListeners: vi.fn() },
}));
vi.mock('../../analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent }) },
}));
vi.mock('ws', () => ({ default: FakeWS }));

import { RealtimeAPIClient, type RealtimeModel } from '../RealtimeAPIClient';

function makeClient(model?: RealtimeModel): RealtimeAPIClient {
  return new RealtimeAPIClient(
    'test-key',
    'coding-session',
    '/workspace',
    {} as any,
    'Session context',
    undefined,
    undefined,
    'cedar',
    model,
  );
}

/** Attach a fake connected socket directly (bypasses connect()). */
function attachFakeSocket(client: RealtimeAPIClient): any[] {
  const sent: any[] = [];
  (client as any).ws = { send: (s: string) => sent.push(JSON.parse(s)) };
  (client as any).connected = true;
  return sent;
}

beforeEach(() => {
  FakeWS.sockets = [];
  sendEvent.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session config (gpt-realtime-2)', () => {
  it('wires model, reasoning effort, streaming transcription, and voice', () => {
    const client = makeClient('gpt-realtime-2');
    (client as any).reasoningEffort = 'medium';
    const sent = attachFakeSocket(client);

    (client as any).updateSession();

    const update = sent.find((e) => e.type === 'session.update');
    expect(update).toBeDefined();
    expect(update.session.reasoning).toEqual({ effort: 'medium' });
    expect(update.session.audio.input.transcription.model).toBe('gpt-realtime-whisper');
    expect(update.session.audio.output.voice).toBe('cedar');
    expect(client.getModel()).toBe('gpt-realtime-2');
    expect(client.supportsAsyncFunctionCalls()).toBe(true);
  });

  it('does NOT re-assert voice on response.create (drift fix)', () => {
    const client = makeClient('gpt-realtime-2');
    const sent = attachFakeSocket(client);

    (client as any).createResponse();

    const resp = sent.find((e) => e.type === 'response.create');
    expect(resp).toBeDefined();
    expect(resp.response.audio).toBeUndefined();
  });

  it('does NOT create an overlapping response while one is already active (voice-switch fix)', () => {
    const client = makeClient('gpt-realtime-2');
    const sent = attachFakeSocket(client);

    // First response.create goes through and marks a response active.
    (client as any).createResponse();
    // A second trigger (e.g. a wake message or tool result arriving mid-turn)
    // must NOT spawn a concurrent response -- that would be two overlapping
    // audio renderings, perceived as the voice switching.
    (client as any).createResponse();

    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(1);

    // Once the active response finishes, a new one may be created again.
    (client as any).handleServerEvent({ type: 'response.done', response: {} });
    (client as any).createResponse();
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(2);
  });

  it('emits a voice-mismatch analytics event when the server voice diverges', () => {
    const client = makeClient('gpt-realtime-2');
    attachFakeSocket(client);

    (client as any).handleServerEvent({
      type: 'session.updated',
      session: { audio: { output: { voice: 'alloy' } } },
    });

    expect(sendEvent).toHaveBeenCalledWith(
      'voice_voice_mismatch',
      expect.objectContaining({ requested: 'cedar', server: 'alloy' }),
    );
  });

  it('does not emit a mismatch event when the server voice matches', () => {
    const client = makeClient('gpt-realtime-2');
    attachFakeSocket(client);

    (client as any).handleServerEvent({
      type: 'session.updated',
      session: { audio: { output: { voice: 'cedar' } } },
    });

    expect(sendEvent).not.toHaveBeenCalledWith('voice_voice_mismatch', expect.anything());
  });
});

describe('language pinning (voice-language fix)', () => {
  it('pins the spoken language to the configured preferred language', () => {
    // 11th constructor arg is the preferred language.
    const client = new RealtimeAPIClient(
      'test-key',
      'coding-session',
      '/workspace',
      {} as any,
      'Session context',
      undefined,
      undefined,
      'cedar',
      'gpt-realtime-2',
      undefined,
      'Spanish',
    );
    const sent = attachFakeSocket(client);

    (client as any).updateSession();

    const update = sent.find((e) => e.type === 'session.update');
    expect(update.session.instructions).toContain('Always speak to the user in Spanish');
  });

  it('falls back to English when no preferred language is configured', () => {
    const client = makeClient('gpt-realtime-2'); // no language arg
    const sent = attachFakeSocket(client);

    (client as any).updateSession();

    const update = sent.find((e) => e.type === 'session.update');
    expect(update.session.instructions).toContain('Always speak to the user in English');
  });

  it('re-sends the identical language directive on reconnect', () => {
    // The directive lives in updateSession(), which reconnect re-runs, so the
    // language survives a dropped socket like voice/model/reasoning do.
    const client = new RealtimeAPIClient(
      'test-key',
      'coding-session',
      '/workspace',
      {} as any,
      'Session context',
      undefined,
      undefined,
      'cedar',
      'gpt-realtime-2',
      undefined,
      'French',
    );
    const sent = attachFakeSocket(client);

    (client as any).updateSession();
    (client as any).updateSession();

    const updates = sent.filter((e) => e.type === 'session.update');
    expect(updates).toHaveLength(2);
    expect(updates[0].session.instructions).toContain('Always speak to the user in French');
    expect(updates[1].session.instructions).toBe(updates[0].session.instructions);
  });
});

describe('function-call result always triggers a response (create_session fix)', () => {
  it('creates a follow-up response even if the prior response is still marked active', () => {
    const client = makeClient('gpt-realtime-2');
    const sent = attachFakeSocket(client);

    // The model started a response that emits a function call. response.created
    // marks it active; response.done (which clears the flag) can lag the tool
    // result by a frame, so simulate the flag still being true when the result
    // is sent (the real-world race for a fast create_session callback).
    (client as any).handleServerEvent({ type: 'response.created', response: { id: 'r1' } });
    expect((client as any).hasActiveResponse).toBe(true);

    (client as any).sendFunctionCallResult('call-1', { success: true, sessionId: 's1', title: 'New Session' });

    // Both the function_call_output AND a follow-up response.create must be sent,
    // otherwise the agent never speaks/acts on the result and the tool feels broken.
    expect(sent.find((e) => e.item?.type === 'function_call_output')).toBeDefined();
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(1);
  });

  it('clears a stuck active-response flag on a server error so later responses are not swallowed', () => {
    const client = makeClient('gpt-realtime-2');
    const sent = attachFakeSocket(client);

    // Optimistically active (e.g. a response.create the server then rejects).
    (client as any).createResponse();
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(1);
    expect((client as any).hasActiveResponse).toBe(true);

    // Server rejects with an error -- no response.created/response.done follows.
    (client as any).handleServerEvent({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'nope' },
    });
    expect((client as any).hasActiveResponse).toBe(false);

    // A subsequent createResponse() must not be swallowed.
    (client as any).createResponse();
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(2);
  });
});

describe('model fallback', () => {
  it('falls back to gpt-realtime when gpt-realtime-2 fails to connect', async () => {
    const client = makeClient('gpt-realtime-2');
    const connectPromise = client.connect();

    // First socket (gpt-realtime-2) fails before opening.
    const first = FakeWS.sockets[0];
    expect(first.url).toContain('model=gpt-realtime-2');
    first.emit('error', new Error('no access'));
    first.emit('close', 4001, 'model_not_found');

    // Wait a microtask for the fallback retry to create the second socket.
    await Promise.resolve();
    const second = FakeWS.sockets[1];
    expect(second.url).toContain('model=gpt-realtime');
    second.emit('open');

    await connectPromise;
    expect(client.getModel()).toBe('gpt-realtime');
    expect(client.supportsAsyncFunctionCalls()).toBe(false);
    expect(sendEvent).toHaveBeenCalledWith(
      'voice_model_fallback',
      expect.objectContaining({ from: 'gpt-realtime-2', to: 'gpt-realtime' }),
    );

    client.disconnect();
  });
});

describe('reconnect / resume', () => {
  it('reconnects on an unexpected close and re-sends an identical session config', async () => {
    vi.useFakeTimers();
    const client = makeClient('gpt-realtime-2');
    const reconnecting = vi.fn();
    const reconnected = vi.fn();
    client.setOnReconnecting(reconnecting);
    client.setOnReconnected(reconnected);

    const connectPromise = client.connect();
    const first = FakeWS.sockets[0];
    first.emit('open');
    await connectPromise;

    // Server configures the session -> first config snapshot.
    first.emit('message', Buffer.from(JSON.stringify({ type: 'session.created', session: { id: 's1' } })));
    const firstConfig = first.parsed().find((e) => e.type === 'session.update');
    expect(firstConfig).toBeDefined();

    // Unexpected drop.
    first.emit('close', 1006, 'abnormal');
    expect(reconnecting).toHaveBeenCalledWith(1);

    // Advance backoff -> second socket created and opened.
    await vi.advanceTimersByTimeAsync(600);
    const second = FakeWS.sockets[1];
    expect(second).toBeDefined();
    second.emit('open');
    await Promise.resolve();
    expect(reconnected).toHaveBeenCalled();

    // Re-applied config must be identical (same voice/model/reasoning).
    second.emit('message', Buffer.from(JSON.stringify({ type: 'session.created', session: { id: 's2' } })));
    const secondConfig = second.parsed().find((e) => e.type === 'session.update');
    expect(secondConfig.session.audio.output.voice).toBe(firstConfig.session.audio.output.voice);
    expect(secondConfig.session.reasoning).toEqual(firstConfig.session.reasoning);
    expect(second.url).toContain('model=gpt-realtime-2');

    client.disconnect();
  });

  it('does NOT reconnect after an intentional disconnect', async () => {
    const client = makeClient('gpt-realtime-2');
    const connectPromise = client.connect();
    const first = FakeWS.sockets[0];
    first.emit('open');
    await connectPromise;

    client.disconnect('user_stopped');
    // disconnect() closes the socket -> close handler must see intentional flag.
    expect(FakeWS.sockets).toHaveLength(1);
  });
});

describe('async (deferred) function calling', () => {
  it('keeps submit_agent_prompt open on gpt-realtime-2 and resolves it later', async () => {
    const client = makeClient('gpt-realtime-2');
    const submit = vi.fn(async () => {});
    client.setOnSubmitPrompt(submit);
    const sent = attachFakeSocket(client);

    await (client as any).handleFunctionCall('call-1', 'submit_agent_prompt', JSON.stringify({ prompt: 'do x' }));

    // Deferred: no function_call_output yet, the call stays open.
    expect(submit).toHaveBeenCalledWith('do x');
    expect(sent.find((e) => e.item?.type === 'function_call_output')).toBeUndefined();
    expect(client.hasDeferredCall()).toBe(true);

    // Resolve with the coding agent's summary.
    const resolved = client.resolveDeferredCall({ success: true, summary: 'Fixed the bug.' });
    expect(resolved).toBe(true);
    expect(client.hasDeferredCall()).toBe(false);

    const output = sent.find((e) => e.item?.type === 'function_call_output');
    expect(output).toBeDefined();
    expect(JSON.parse(output.item.output)).toEqual({ success: true, summary: 'Fixed the bug.' });
    // The result triggers the agent to speak it.
    expect(sent.find((e) => e.type === 'response.create')).toBeDefined();
  });

  it('returns a synthetic queued result immediately on the gpt-realtime fallback', async () => {
    const client = makeClient('gpt-realtime');
    const submit = vi.fn(async () => {});
    client.setOnSubmitPrompt(submit);
    const sent = attachFakeSocket(client);

    await (client as any).handleFunctionCall('call-2', 'submit_agent_prompt', JSON.stringify({ prompt: 'do y' }));

    expect(submit).toHaveBeenCalledWith('do y');
    expect(client.hasDeferredCall()).toBe(false);
    const output = sent.find((e) => e.item?.type === 'function_call_output');
    expect(output).toBeDefined();
    expect(JSON.parse(output.item.output).success).toBe(true);
    expect(JSON.parse(output.item.output).message).toContain('queued');
  });
});
